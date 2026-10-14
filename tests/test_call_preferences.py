from concurrent.futures import ThreadPoolExecutor

import pytest

from test_calling import service, technician, request
from test_livekit import voice_app, webapp
from realapp.calling import CallingService, Login


@pytest.mark.parametrize('availability', ['Available', 'Away', 'Offline'])
def test_saved_preferences_survive_logout_login_and_service_restart(service, availability):
    tech = technician(service)
    service.presence(tech['id'], availability)
    service.call_settings(tech['id'], False)
    token, _ = service.login(Login(username='alex', password='test-password-12345', expected_role='technician'), 'test')
    service.logout(token, tech['id'])
    restarted = CallingService(service.settings, service.repository, service.case_store, service.engine, now=service.now)
    token, user = restarted.login(Login(username='alex', password='test-password-12345', expected_role='technician'), 'test')
    assert user['availability'] == user['status'] == availability
    assert user['calls_enabled'] is False
    assert restarted.heartbeat(tech['id'], True)['voice_ready'] is False
    assert restarted.authenticate(token)['availability'] == availability


def test_disabled_calls_are_not_dispatched_and_finish_restores_available(service):
    tech = technician(service)
    call = request(service, phone=True)
    service.call_settings(tech['id'], False)
    service.heartbeat(tech['id'], True)
    assert service.dispatch() == []
    service.call_settings(tech['id'], True)
    service.heartbeat(tech['id'], True)
    service.dispatch()
    service.accept(call['id'], tech['id'])
    service.finish(call['id'])
    user = service.snapshot()['technicians'][0]
    assert user['status'] == user['availability'] == 'Available'
    assert user['calls_enabled'] and user['voice_ready']


def test_browser_incident_created_once_from_completed_conversation(service, monkeypatch):
    tech = technician(service)
    service.heartbeat(tech['id'], True)
    call = request(service, phone=True)
    assert service.case_store.list_cases() == []
    service.dispatch()
    service.accept(call['id'], tech['id'])
    service.add_turn(call['id'], 'Technician', 'The crash is caused by a damaged report template.')
    service.add_turn(call['id'], 'Customer', 'The report still fails after restarting.')
    analyzed = []
    original = service.engine.analyze
    def analyze(value):
        analyzed.append(value.transcript)
        return original(value)
    monkeypatch.setattr(service.engine, 'analyze', analyze)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: service.finish(call['id']), range(2)))
    assert len(analyzed) == 1
    assert 'damaged report template' in analyzed[0] and 'still fails' in analyzed[0]
    assert results[0]['case_id'] == results[1]['case_id']
    assert len(service.case_store.list_cases()) == 1
    case = service.case_store.get_case(results[0]['case_id'])
    assert len(case.transcript) == 3
    assert case.ticket.assigned_user_id == tech['id']
    assert case.ticket.state == 'New' and case.ticket.resolution == ''
    assert case.qa_checks == [] and case.quality_score is None
    case.ticket.short_description = 'Technician edited this incident'
    service.case_store.save_case(case)
    service.finish(call['id'])
    assert service.case_store.get_case(case.id).ticket.short_description == 'Technician edited this incident'


def test_failed_analysis_still_creates_incident_with_full_transcript(service, monkeypatch):
    call = request(service, phone=True)
    service.add_turn(call['id'], 'Technician', 'Collecting logs for further investigation.')
    def fail(_):
        raise RuntimeError('Provider unavailable')
    monkeypatch.setattr(service.engine, 'analyze', fail)
    result = service.finish(call['id'])
    case = service.case_store.get_case(result['case_id'])
    assert 'Collecting logs' in case.ticket.description
    assert case.ticket.state == 'New'


def test_call_settings_api_and_private_draft(voice_app):
    f = voice_app
    result = f.client.patch('/api/technicians/me/call-settings', json={'enabled':False})
    assert result.status_code == 200 and result.json()['calls_enabled'] is False
    call = f.service.create_call('Customer', 'browser')
    f.service.add_turn(call['id'], 'Customer', 'Payroll report fails. Please send a technician.')
    f.service.triage(call['id'])
    response = f.client.get('/api/calling')
    assert response.status_code == 200 and 'draft_case' not in response.text
    assert f.service.get(call['id'])['case_id'] is None


def test_audio_disconnects_before_ticket_generation(voice_app, monkeypatch):
    f = voice_app
    call = f.service.create_call('Customer', 'browser')
    original = f.service.finish
    def finish(call_id, status='Completed'):
        f.room.delete_room.assert_awaited_once()
        return original(call_id, status)
    monkeypatch.setattr(f.service, 'finish', finish)
    assert f.client.post('/api/calling/' + call['id'] + '/finish').status_code == 200

