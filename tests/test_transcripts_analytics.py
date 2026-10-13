from realapp.call_analytics import CallQuality, CallAudit, MetricScore, analytics, METRICS, fingerprint, overall_quality, filtered_analytics
from test_roles import accounts
from test_calling import service


def add_completed(service,customer_id,tech_id):
    call=service.create_call('Customer','browser',customer_id=customer_id)
    service.add_turn(call['id'],'Technician','Thank you calling service desk, how can I help you today?')
    service.add_turn(call['id'],'Customer','The payroll application fails to open. I need assistance.')
    service.add_turn(call['id'],'Technician','Please restart the application and verify the result.')
    service.repository.mutate(lambda db:db['calls'][call['id']].update(technician_id=tech_id,technician_name='Assigned technician',status='Connected'))
    return service.finish(call['id'])


def test_transcript_list_detail_and_download_are_scoped_by_role(accounts):
    f=accounts
    one=add_completed(f.service,f.customer_a_id,f.tech_a_id)
    two=add_completed(f.service,f.customer_b_id,f.tech_b_id)
    assert len(f.admin.get('/api/transcripts').json())==2
    for client in (f.tech_a,f.customer_a):
        listing=client.get('/api/transcripts')
        assert listing.status_code==200 and [s['source_id'] for s in listing.json()]==[one['id']]
        assert client.get('/api/transcripts/'+one['id']).status_code==200
        assert client.get('/api/transcripts/'+two['id']).status_code==404
        assert client.get('/api/transcripts/'+two['id']+'/download').status_code==404
        download=client.get('/api/transcripts/'+one['id']+'/download')
        assert download.status_code==200 and 'Technician' in download.text and 'INC0000001' in download.text
    assert f.customer_a.get('/api/call-analytics').status_code==403
    assert f.customer_a.post('/api/call-analytics/evaluate').status_code==403
    assert f.admin.get('/api/call-analytics').json()['total']==2
    assert f.tech_a.get('/api/call-analytics').json()['total']==1
    assert f.tech_a.get('/api/cases/'+two['case_id']).json()['transcript']==[]
    assert f.admin.get('/api/cases/'+two['case_id']).json()['transcript']
    assert f.customer_a.get('/api/transcripts/'+one['id']).json()['quality_audit'] is None


def test_six_evidence_based_metrics_and_stale_results(service,monkeypatch):
    call=add_completed(service,'customer','tech')
    quality=CallQuality(service)
    service.engine.settings.llm_provider='vertex'
    metric=MetricScore(score=90,evidence='Thank you calling service desk, how can I help you today?',explanation='Opens the call appropriately.',improvement='Introduce your name.')
    audit=CallAudit(**{key:metric for key,_,_ in METRICS})
    audit.empathy=MetricScore(score=95,evidence='This invented quotation is not in the transcript',explanation='Unsupported',improvement='Acknowledge impact')
    monkeypatch.setattr(service.engine,'_generate',lambda *args:audit)
    assert quality.evaluate(call['id'])=='completed'
    data=analytics([service.get(call['id'])])
    assert len(data['metrics'])==6 and data['audited']==1
    empathy=next(m for m in data['metrics'] if m['key']=='empathy')
    assert empathy['score'] is None and empathy['evaluated_count']==0
    assert data['metrics'][0]['score']==90
    assert data['overall']['score'] is None
    assert data['calls'][0]['overall']['scored_metrics']==5
    assert quality.evaluate(call['id'])=='skipped'
    service.add_turn(call['id'],'Customer','I have more information about the issue.')
    assert analytics([service.get(call['id'])])['audited']==0
    quality.pool.shutdown(wait=True)


def test_call_totals_filtering_and_incomplete_scores():
    def call(number, name, service, scores):
        item=dict(id=number,technician_name=name,service=service,status='Completed',created_at=100,ended_at=160,transcript=[{'text':number}])
        item['quality_audit']={'fingerprint':fingerprint(item),'metrics':{key:{'score':score} for (key,_,_),score in zip(METRICS,scores)}}
        return item
    first=call('CALL-001','Arjun','Identity',[85,95,55,95,100,95])
    perfect=call('CALL-002','Meera','Printing',[100]*6)
    incomplete=call('CALL-003','Arjun','Identity',[90]*5+[None])
    zero=call('CALL-004','Arjun','Identity',[0]*6)
    assert overall_quality(first)['score']==525
    assert overall_quality(first)['percentage']==87.5
    assert overall_quality(perfect)['percentage']==100
    assert overall_quality(zero)['score']==0
    result=filtered_analytics([first,perfect,incomplete,zero],technician='Arjun',service='Identity')
    assert result['total']==3 and result['available_total']==4
    assert result['overall']['score']==262.5 and result['overall']['percentage']==43.8
    assert result['overall']['evaluated_count']==2
    assert result['filters']['technicians']==['Arjun','Meera']
    assert filtered_analytics([first,perfect],call_id=' call-001 ',service='Identity')['overall']['percentage']==87.5
    assert filtered_analytics([first],service='Printing')['total']==0
    first['transcript'].append({'text':'Changed'})
    assert overall_quality(first)['score'] is None


def test_analytics_filters_cannot_expand_role_access(accounts):
    f=accounts
    one=add_completed(f.service,f.customer_a_id,f.tech_a_id)
    two=add_completed(f.service,f.customer_b_id,f.tech_b_id)
    f.service.repository.mutate(lambda db:db['calls'][two['id']].update(technician_name='Other technician',service='Printing'))
    result=f.tech_a.get('/api/call-analytics',params={'call_id':two['id']}).json()
    assert result['total']==0 and result['available_total']==1
    assert 'Other technician' not in result['filters']['technicians']
    assert f.admin.get('/api/call-analytics',params={'call_id':two['id'],'technician':'Other technician','service_name':'Printing'}).json()['total']==1
    assert f.customer_a.get('/api/transcripts/'+one['id']).json()['overall_quality'] is None


def test_active_calls_and_missing_handler_evidence_are_not_scored(service):
    quality=CallQuality(service)
    call=service.create_call('Customer','browser')
    service.add_turn(call['id'],'Customer','I cannot open my application and need help.')
    assert quality.evaluate(call['id'])=='skipped'
    service.finish(call['id'])
    assert quality.evaluate(call['id'])=='skipped'
    assert analytics([service.get(call['id'])])['metrics'][0]['score'] is None
    quality.pool.shutdown(wait=True)
