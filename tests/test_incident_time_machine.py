from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from realapp import main
from realapp.config import Settings
from realapp.engine import OpenAIEngine
from realapp.models import AnalysisRequest, TicketStateTransition, TranscriptTurn, WorkNote
from realapp.store import MemoryStore
from realapp.calling_store import MemoryCallingStore
from realapp.incident_time_machine import compare_history, reconstruct
from conftest import signed_in_admin


def make_incident(engine):
    base = datetime(2026, 10, 14, 10, 0, tzinfo=timezone.utc)
    case = engine.analyze(AnalysisRequest(channel='Web', transcript='Customer: The connection drops every few minutes and the page will not load.'))
    case.issue_title = 'VPN connection drops'
    case.ticket.short_description = 'VPN connection drops during remote work'
    case.ticket.service = 'Network'
    case.created_at = base
    case.transcript = [
        TranscriptTurn(speaker='Customer', text='Connection drops after sign in.', timestamp='2026-10-14T10:05:00Z'),
        TranscriptTurn(speaker='Technician', text='Please retry the connection.', timestamp='00:00:12'),
    ]
    case.attempted_steps = ['Restarted the router']
    case.ticket.work_notes = [
        WorkNote(id='TRY-1', author='Tech', author_type='Technician', text='Restarted the router; the connection still failed.', created_at=datetime(2026, 10, 14, 10, 15, tzinfo=timezone.utc)),
        WorkNote(id='CONF-1', author='Customer', author_type='Customer', text='Confirmed the connection is restored.', created_at=datetime(2026, 10, 14, 10, 25, tzinfo=timezone.utc)),
    ]
    case.ticket.state = 'Resolved'
    case.ticket.resolution = 'Connection restored and confirmed by customer.'
    case.state_history = [TicketStateTransition(from_state='In Progress', to_state='Resolved', changed_at=datetime(2026, 10, 14, 10, 30, tzinfo=timezone.utc), changed_by='Tech')]
    return case


@pytest.fixture
def time_machine(monkeypatch):
    store = MemoryStore()
    engine = OpenAIEngine(Settings(llm_provider='mock'), store.list_knowledge)
    case = store.save_case(make_incident(engine))
    monkeypatch.setattr(main, 'store', store)
    monkeypatch.setattr(main, 'engine', engine)
    monkeypatch.setattr(main.calling, 'repository', MemoryCallingStore())
    monkeypatch.setattr(main.calling, 'case_store', store)
    admin = signed_in_admin(TestClient(main.app))
    return SimpleNamespace(store=store, engine=engine, case=case, admin=admin)


def test_reconstruction_orders_timestamped_records_and_separates_unknown_times(time_machine):
    result = time_machine.admin.get(f"/api/cases/{time_machine.case.id}/time-machine")
    assert result.status_code == 200, result.text
    body = result.json()
    events = body['events']
    assert [item['id'] for item in events if item['occurred_at']] == [
        'case-created', 'transcript-0', 'note-TRY-1', 'note-CONF-1', 'state-0'
    ]
    assert next(item for item in events if item['id'] == 'transcript-1')['time_quality'] == 'undated'
    assert any(item['id'] == 'ai-recommendation' and item['occurred_at'] is None for item in events)
    assert body['incident']['initial_state'] == 'In Progress'
    assert all(link['type'] == 'observed_before' for link in body['relationships'])
    assert 'Root cause not established' in body['causal_status']
    assert any('not establish causation' in warning for warning in body['warnings'])


def test_system_audit_text_is_not_mislabeled_as_a_failed_attempt(time_machine):
    case = time_machine.store.get_case(time_machine.case.id)
    case.ticket.work_notes.append(WorkNote(
        id='SYS-1', author='Automation', author_type='System',
        text='A reported step failed before this system note was written.'
    ))
    events = reconstruct(case)['events']
    system = next(item for item in events if item['id'] == 'note-SYS-1')
    assert system['type'] == 'system_record'
    assert system['time_quality'] == 'recorded'


def test_counterfactual_is_staff_only_simulated_and_does_not_change_case(time_machine):
    env = time_machine
    path = f"/api/cases/{env.case.id}/time-machine"
    before = env.store.get_case(env.case.id).model_dump_json()
    response = env.admin.post(f"{path}/counterfactual", json={
        'decision_event_id': 'case-created', 'alternative': 'collect_diagnostic'
    })
    assert response.status_code == 422

    response = env.admin.post(f"{path}/counterfactual", json={
        'decision_event_id': 'note-TRY-1', 'alternative': 'collect_diagnostic'
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['label'].startswith('SIMULATED ALTERNATIVE')
    assert body['historical_validation']['status'] == 'not_established'
    assert [item['id'] for item in body['observed_later_events']] == ['note-CONF-1', 'state-0']
    assert 'note-TRY-1' not in {item['id'] for item in body['evidence_available_before_decision']}
    assert env.store.get_case(env.case.id).model_dump_json() == before


def test_counterfactual_keeps_same_timestamp_events_out_of_both_paths(time_machine):
    env = time_machine
    case = env.store.get_case(env.case.id)
    case.ticket.work_notes.append(WorkNote(
        id='SAME-1', author='Tech', author_type='Technician', text='A note with unresolved event ordering.',
        created_at=datetime(2026, 10, 14, 10, 15, tzinfo=timezone.utc),
    ))
    env.store.save_case(case)
    response = env.admin.post(f"/api/cases/{case.id}/time-machine/counterfactual", json={
        'decision_event_id': 'note-TRY-1', 'alternative': 'collect_diagnostic'
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert [item['id'] for item in body['events_at_same_timestamp_order_unknown']] == ['note-SAME-1']
    assert 'note-SAME-1' not in {item['id'] for item in body['evidence_available_before_decision']}
    assert 'note-SAME-1' not in {item['id'] for item in body['observed_later_events']}


def test_time_machine_requires_staff_authentication(time_machine):
    guest = TestClient(main.app)
    response = guest.get(f"/api/cases/{time_machine.case.id}/time-machine")
    assert response.status_code == 401


def test_history_comparison_uses_actual_similar_incidents_and_explicit_outcomes(time_machine):
    candidate = time_machine.store.save_case(make_incident(time_machine.engine))
    comparison = compare_history(time_machine.case, [time_machine.case, candidate])
    assert comparison['status'] == 'observational_context'
    assert comparison['comparable_count'] == 1
    assert comparison['outcomes']['customer_confirmed_resolution'] == 1
    assert comparison['matches'][0]['ticket_id'] == candidate.ticket.id
    assert comparison['matches'][0]['similarity_terms']
    assert any('not a causal estimate' in message for message in comparison['limitations'])


def test_mock_knowledge_draft_stays_explicit_about_unverified_outcome(time_machine):
    response = time_machine.admin.post('/api/knowledge/from-incidents', json={
        'ticket_numbers': [time_machine.case.ticket.id]
    })
    assert response.status_code == 200, response.text
    article = response.json()['article']
    assert article['source_ticket_ids'] == [time_machine.case.ticket.id]
    assert article['product'] == 'Network'
    assert 'No confirmed fix' in article['resolution']


def test_validate_endpoint_reports_observed_cohort_without_claiming_causality(time_machine):
    env = time_machine
    candidate = env.store.save_case(make_incident(env.engine))
    response = env.admin.post(f"/api/cases/{env.case.id}/time-machine/validate", json={
        'decision_event_id': 'note-TRY-1', 'alternative': 'avoid_repeat'
    })
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['strategy_validation']['status'] == 'not_established'
    assert result['historical_context']['comparable_count'] == 1
    assert result['historical_context']['matches'][0]['case_id'] == candidate.id
