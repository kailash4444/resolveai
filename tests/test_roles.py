from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient
from realapp import main
from realapp.calling_store import MemoryCallingStore
from realapp.store import MemoryStore
from realapp.engine import OpenAIEngine
from realapp.config import Settings
from realapp.models import QAAuditPayload, WorkNote
from realapp.store import SQLiteStore


@pytest.fixture
def accounts(monkeypatch):
    store=MemoryStore()
    engine=OpenAIEngine(Settings(llm_provider='mock'),store.list_knowledge)
    service=main.calling
    monkeypatch.setattr(service,'repository',MemoryCallingStore())
    monkeypatch.setattr(service,'case_store',store)
    monkeypatch.setattr(service,'engine',engine)
    monkeypatch.setattr(main,'store',store)
    monkeypatch.setattr(main,'engine',engine)
    admin=TestClient(main.app)
    assert admin.post('/api/auth/setup',json={'name':'Admin','username':'admin','password':'isolated-admin-password'}).status_code==201
    result=SimpleNamespace(admin=admin,store=store,engine=engine,service=service)
    for name,role in [('tech_a','technician'),('tech_b','technician'),('customer_a','customer'),('customer_b','customer')]:
        value={'name':name,'username':name,'password':'isolated-user-password','role':role}
        created=admin.post('/api/users',json=value)
        assert created.status_code==201,created.text
        client=TestClient(main.app)
        assert client.post('/api/auth/login',json=value).status_code==200
        setattr(result,name,client);setattr(result,name+'_id',created.json()['id'])
    return result


def create_incident(client):
    response=client.post('/api/customer/incidents',json={'short_description':'Browser issue','description':'The page goes blank whenever I open the reports.','service':'Browser'})
    assert response.status_code==201,response.text
    return response.json()


@pytest.mark.parametrize('backend', ['memory', 'sqlite'])
def test_slow_audit_does_not_restore_old_assignment_or_comments(accounts, tmp_path, backend):
    item = create_incident(accounts.customer_a)
    store = MemoryStore() if backend == 'memory' else SQLiteStore(str(tmp_path / 'audit.sqlite3'))
    original = accounts.store.get_case(item['id'])
    original.ticket.state = 'Resolved'
    original.ticket.resolution = 'Issue fixed.'
    original.ticket.assigned_user_id = accounts.tech_a_id
    store.save_case(original)
    updated = store.get_case(original.id)
    updated.ticket.assigned_user_id = accounts.tech_b_id
    updated.ticket.work_notes.append(WorkNote(id='new-comment', author='Customer', author_type='Customer', text='Thank you.'))
    store.save_case(updated)
    audit = QAAuditPayload(checks=[], quality_score=100)
    result = store.save_audit(original, audit)
    assert result == updated
    assert store.get_case(original.id) == updated
    current = store.save_audit(updated, audit)
    assert current.quality_score == 100
    assert current.ticket.assigned_user_id == accounts.tech_b_id


def test_manual_audit_allows_staff_after_reassignment(accounts, monkeypatch):
    f = accounts
    item = create_incident(f.customer_a)
    case = f.store.get_case(item['id'])
    case.ticket.state, case.ticket.resolution = 'Resolved', 'Fixed and confirmed.'
    case.ticket.assigned_user_id = f.tech_a_id
    f.store.save_case(case)

    def slow_audit(snapshot):
        current = f.store.get_case(snapshot.id)
        current.ticket.assigned_user_id = f.tech_b_id
        f.store.save_case(current)
        return QAAuditPayload(checks=[], quality_score=100)

    monkeypatch.setattr(f.engine, 'audit', slow_audit)
    assert f.tech_a.post('/api/cases/' + case.id + '/qa').status_code == 200
    assert f.store.get_case(case.id).ticket.assigned_user_id == f.tech_b_id


def test_authentication_and_single_admin_enforced(accounts):
    f=accounts;guest=TestClient(main.app)
    for path in ['/api/cases','/api/knowledge','/api/config','/api/overview','/api/calling','/api/support/status']:
        assert guest.get(path).status_code==401
    assert guest.get('/support',follow_redirects=False).status_code==303
    assert guest.post('/api/support/calls',json={'caller':'Guest'}).status_code==401
    assert f.admin.post('/api/auth/setup',json={'name':'Other Admin','username':'other_admin','password':'isolated-admin-password'}).status_code==409
    assert f.admin.post('/api/users',json={'name':'Other Admin','username':'other','password':'isolated-admin-password','role':'admin'}).status_code==422
    for user in [f.tech_a,f.customer_a]:
        assert user.get('/api/users').status_code==403
        assert user.post('/api/users',json={}).status_code==403


def test_customer_portal_scope_and_no_qa_or_analytics(accounts):
    f=accounts;one=create_incident(f.customer_a);two=create_incident(f.customer_b)
    assert one['customer_id']==f.customer_a_id and one['caller']=='customer_a'
    assert [c['id'] for c in f.customer_a.get('/api/cases').json()]==[one['id']]
    assert f.customer_b.get('/api/cases/'+one['id']).status_code==404
    assert f.customer_a.patch('/api/cases/'+one['id']+'/ticket',json={'state':'Resolved','resolution':'Spoof'}).status_code==403
    for path in ['/api/overview','/api/calling','/api/cases/'+one['id']+'/qa','/api/knowledge/from-incidents']:
        response=f.customer_a.get(path) if path in {'/api/overview','/api/calling'} else f.customer_a.post(path,json={})
        assert response.status_code==403
    assert f.customer_a.get('/api/knowledge').status_code==200
    assert f.customer_a.post('/api/knowledge',json={}).status_code==403
    assert len(f.admin.get('/api/cases').json())==2
    case=f.store.get_case(one['id']);case.quality_score=23;f.store.save_case(case)
    assert f.customer_a.get('/api/cases/'+one['id']).json()['quality_score'] is None


def test_assignment_and_comments_derive_identity_and_scope(accounts):
    f=accounts;item=create_incident(f.customer_a);path='/api/cases/'+item['id']
    assert len(f.tech_a.get('/api/cases').json())==1
    assert f.tech_a.get(path).status_code==200
    assert f.admin.patch(path+'/ticket',json={'assigned_user_id':f.tech_a_id,'state':'In Progress'}).status_code==200
    assert f.tech_a.get(path).json()['ticket']['assigned_to']=='tech_a'
    assert f.tech_b.patch(path+'/ticket',json={'description':'Other staff can help with this incident.'}).status_code==200
    assert f.tech_a.patch(path+'/ticket',json={'assigned_user_id':f.tech_b_id}).status_code==403
    for client,expected_name,expected_type in [(f.tech_a,'tech_a','Technician'),(f.customer_a,'customer_a','Customer')]:
        response=client.post(path+'/work-notes',json={'text':'A real written comment.','author':'Spoof Admin','author_type':'Customer'})
        assert response.status_code==200,response.text
        note=response.json()['ticket']['work_notes'][-1]
        assert note['author']==expected_name and note['author_type']==expected_type
    assert f.customer_b.post(path+'/work-notes',json={'text':'foreign'}).status_code==404
    assert f.tech_b.post(path+'/work-notes',json={'text':'Helping another technician.'}).status_code==200
    assert f.tech_b.get(path).status_code==200
    assert f.tech_a.get('/api/overview').json()['total_cases']==1
    assert f.tech_b.get('/api/overview').json()['total_cases']==0
    assert f.admin.patch(path+'/ticket',json={'assigned_user_id':f.tech_b_id}).status_code==200
    assert f.tech_a.get(path).status_code==200
    assert f.tech_b.get(path).status_code==200


def test_only_admin_sets_shared_key(accounts,monkeypatch):
    f=accounts;saved=[]
    monkeypatch.setattr(main.settings,'llm_provider','openai')
    monkeypatch.setattr(main,'save_local_openai_key',saved.append)
    fake='sk-isolated-shared-key-not-real'
    for user in [f.customer_a,f.tech_a,f.tech_b]:
        assert user.post('/api/config/openai-key',json={'api_key':fake}).status_code==403
    assert f.admin.post('/api/config/openai-key',json={'api_key':fake}).status_code==200
    assert saved==[fake] and f.engine._runtime_api_key==fake
    for user in [f.admin,f.customer_a,f.tech_a,f.tech_b]:
        response=user.get('/api/config')
        assert response.json()['configured'] is True
        assert fake not in response.text
    assert f.tech_a.get('/api/config').json()['runtime_key_supported'] is False


def test_any_available_technician_can_pick_up_and_only_one_wins(accounts):
    f=accounts
    for client in [f.tech_a,f.tech_b]:
        client.patch('/api/technicians/me/presence',json={'status':'Available'})
        client.post('/api/technicians/me/heartbeat',json={'voice_ready':True})
    call=f.service.create_call('customer_a',customer_id=f.customer_a_id)
    f.service.add_turn(call['id'],'Customer','The payroll system crashed and I need a technician.')
    call=f.service.triage(call['id']);f.service.dispatch()
    second=f.tech_b.get('/api/calling').json()
    assert second['calls']==[] and second['incoming_calls'][0]['id']==call['id']
    assert 'transcript' not in second['incoming_calls'][0] and 'case_id' not in second['incoming_calls'][0]
    # B may answer even though the original automatic offer was assigned to A.
    assert f.tech_b.post('/api/calling/'+call['id']+'/accept').status_code==200
    assert f.tech_a.post('/api/calling/'+call['id']+'/accept').status_code==409
    assert f.tech_a.get('/api/calling').json()['calls']==[]
    assert f.tech_a.get('/api/cases/'+call['case_id']).status_code==200
    assert f.tech_b.get('/api/cases/'+call['case_id']).json()['ticket']['assigned_user_id']==f.tech_b_id
    assert f.customer_a.get('/api/customer/calls').json()[0]['id']==call['id']
    assert f.customer_b.get('/api/customer/calls').json()==[]
    f.service.finish(call['id'])
    for client in [f.tech_a,f.tech_b]:
        client.patch('/api/technicians/me/presence',json={'status':'Available'})
    next_call=f.service.create_call('customer_a',customer_id=f.customer_a_id)
    f.service.add_turn(next_call['id'],'Customer','Another payroll failure requiring technician assistance.')
    f.service.triage(next_call['id'])
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda client:client.post('/api/calling/'+next_call['id']+'/accept').status_code,[f.tech_a,f.tech_b]))
    assert sorted(results)==[200,409]
