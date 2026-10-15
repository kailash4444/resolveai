import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_calling import service
from realapp.calling import VoiceDecision
from realapp.calling_api import install_calling
from realapp.config import Settings
from realapp.engine import OpenAIEngine
from realapp.gemini import GeminiEngine
from realapp.livekit_transport import BrowserSession, LiveKitTransport
from realapp.store import MemoryStore
from realapp.models import AnalysisRequest, CompletedCallAnalysisPayload


def prepare(service, monkeypatch):
    service.settings.llm_provider = 'vertex'
    call = service.create_call('Kavya', 'browser', customer_id='customer-kavya')
    service.add_turn(call['id'], 'Customer', 'How do I clear my browser cache?')
    kb = SimpleNamespace(model_dump=lambda: {'id': 'KB00001', 'title': 'Browser cache',
        'excerpt': 'Clear Chrome cache', 'steps': ['Open browser settings.']})
    monkeypatch.setattr(service.knowledge_engine, 'retrieve', lambda *a, **kw: [kb])
    decision = VoiceDecision(reply='Which browser are you using?', escalate=False,
        customer_confirmed_resolved=False, safe_guidance=True, confidence=.99, service='Browser', summary='Clear browser cache')
    requests = []
    def generate(prompt, schema):
        requests.append(prompt)
        return decision
    monkeypatch.setattr(service.engine, 'generate_voice', generate, raising=False)
    return call, decision, requests


def test_first_voice_turn_routes_and_replies_once_without_incident(service, monkeypatch):
    call, _, requests = prepare(service, monkeypatch)
    monkeypatch.setattr(service.engine, 'analyze', lambda *_: pytest.fail('Incident analysis during live call'))
    async def run():
        session = BrowserSession(LiveKitTransport(service.settings, service), call['id'])
        session.say = AsyncMock(return_value=True)
        await session.respond(0)
        session.say.assert_awaited_once_with('Which browser are you using?')
    asyncio.run(run())
    assert len(requests) == 1
    assert service.get(call['id'])['status'] == 'AI'
    assert service.case_store.list_cases() == []
    assert not service.get(call['id']).get('draft_case')


def test_hangup_queues_generation_and_confirmed_ai_incident_is_resolved(service, monkeypatch):
    call, _, _ = prepare(service, monkeypatch)
    service.reply(call['id'])
    service.add_turn(call['id'], 'AI Agent', 'Open browser settings and clear cached images and files.')
    service.add_turn(call['id'], 'Customer', 'I cleared the cache and it is working now.')
    service.confirm_ai_resolution(call['id'])
    queued = []
    service.on_ticket_pending = queued.append
    completed = service.finish(call['id'])
    assert completed['status'] == 'Completed' and completed['ticket_status'] == 'pending'
    assert not completed['case_id'] and queued == [call['id']]
    # Even when post-call Gemini fails, retain all evidence and the verified outcome.
    monkeypatch.setattr(service.engine, 'analyze', lambda *_: (_ for _ in ()).throw(RuntimeError('Unavailable')))
    service.finalize_ticket(call['id'])
    service.finalize_ticket(call['id'])
    cases = service.case_store.list_cases()
    assert len(cases) == 1
    case = cases[0]
    assert case.customer_id == 'customer-kavya'
    assert case.ticket.state == 'Resolved' and case.status == 'Resolved'
    assert case.ticket.assigned_to == 'AI' and case.ticket.assignment_group == 'Artificial intelligence'
    assert case.ticket.assigned_user_id == ''
    assert 'cleared the cache' in case.ticket.resolution and 'cached images' in case.ticket.resolution


@pytest.mark.parametrize('technician,status', [('', 'Completed'), ('tech-1', 'Completed'), ('', 'Failed')])
def test_unconfirmed_human_or_failed_calls_do_not_auto_resolve(service, monkeypatch, technician, status):
    call, _, _ = prepare(service, monkeypatch)
    service.reply(call['id'])
    if technician or status == 'Failed':
        service.confirm_ai_resolution(call['id'])
    service.repository.mutate(lambda db: db['calls'][call['id']].update(technician_id=technician,
        technician_name='Asha' if technician else ''))
    monkeypatch.setattr(service.engine, 'analyze', lambda *_: (_ for _ in ()).throw(RuntimeError()))
    service.finish(call['id'], status)
    case = service.case_store.list_cases()[0]
    assert case.ticket.state == 'New' and not case.ticket.resolution
    assert case.ticket.assigned_to == ('Asha' if technician else '')


def test_new_customer_words_invalidate_previous_confirmation(service, monkeypatch):
    call, _, _ = prepare(service, monkeypatch)
    service.reply(call['id'])
    previous = service.get(call['id'])['transcript'][-1]
    service.confirm_ai_resolution(call['id'], previous)
    service.add_turn(call['id'], 'Customer', 'Actually it is still failing.')
    service.confirm_ai_resolution(call['id'], previous)
    assert not service.get(call['id']).get('ai_resolution')


def test_voice_timeout_transfers_without_another_analysis_attempt(service, monkeypatch):
    call, _, _ = prepare(service, monkeypatch)
    monkeypatch.setattr(service.engine, 'generate_voice', lambda *_: (_ for _ in ()).throw(TimeoutError()))
    monkeypatch.setattr(service.engine, 'analyze', lambda *_: pytest.fail('Unexpected slow retry'))
    reply = service.reply(call['id'])
    assert reply.escalate and not reply.customer_confirmed_resolved
    assert not service.case_store.list_cases()


def test_clarification_reuses_articles_but_changed_problem_refreshes(service, monkeypatch):
    call, decision, requests = prepare(service, monkeypatch)
    service.reply(call['id'])
    service.add_turn(call['id'], 'AI Agent', decision.reply)
    service.add_turn(call['id'], 'Customer', 'Google Chrome')
    refreshed = []
    original = service.refresh_knowledge
    def refresh(call_id):
        refreshed.append(call_id)
        return original(call_id)
    monkeypatch.setattr(service, 'refresh_knowledge', refresh)
    service.reply(call['id'])
    assert not refreshed and len(requests) == 2
    service.add_turn(call['id'], 'Customer', 'Now my printer cannot connect.')
    decision.needs_new_knowledge = True
    service.reply(call['id'])
    assert refreshed == [call['id']] and len(requests) == 4


def test_voice_request_uses_bounded_sdk_timeout_without_retries():
    settings = Settings(_env_file=None, gemini_provider='google_ai', gemini_api_key='test-only')
    engine = GeminiEngine(settings, lambda: [])
    requests = []
    def generate(**kwargs):
        requests.append(kwargs)
        raise TimeoutError()
    engine._client = SimpleNamespace(models=SimpleNamespace(generate_content=generate))
    with pytest.raises(TimeoutError):
        engine.generate_voice('test', VoiceDecision)
    assert len(requests) == 1
    config = requests[0]['config']
    assert config.http_options.timeout == 8000 and config.http_options.retry_options.attempts == 1
    assert config.max_output_tokens == 600
    assert config.thinking_config.thinking_level == 'MINIMAL'


def test_background_publication_runs_resolved_followups():
    import threading
    store = MemoryStore()
    settings = Settings(_env_file=None, llm_provider='mock', calling_backend='memory', data_backend='memory')
    engine = OpenAIEngine(settings, store.list_knowledge)
    processed = threading.Event()
    app = FastAPI()
    service = install_calling(app, settings, store, engine, lambda *args: None,
        resolved_tasks=(lambda _: processed.set(),))
    service.on_finished = None
    with TestClient(app):
        call = service.create_call('Kavya', 'browser')
        service.add_turn(call['id'], 'Customer', 'The browser issue is resolved after clearing cache.')
        service.repository.mutate(lambda db: db['calls'][call['id']].update(status='AI'))
        service.confirm_ai_resolution(call['id'])
        service.finish(call['id'])
        assert processed.wait(5), 'Resolved incident follow-ups were not scheduled'
        assert store.list_cases()[0].ticket.state == 'Resolved'


@pytest.mark.parametrize('resolved,quote,expected', [
    (True, 'It prints now. The issue is fixed.', 'Resolved'),
    (True, 'Everything works perfectly.', 'New'),
    (False, 'It prints now. The issue is fixed.', 'New'),
])
def test_completed_call_extracts_grounded_resolution_in_same_analysis(monkeypatch, resolved, quote, expected):
    engine = GeminiEngine(Settings(_env_file=None, gemini_provider='google_ai'), lambda: [])
    transcript = ('Customer: My printer is offline.\nTechnician: I reconnected the workstation to the printer. Please test it.\n'
        'Customer: It prints now. The issue is fixed.')
    payload = CompletedCallAnalysisPayload(**engine._mock_analysis(transcript).model_dump(),
        call_resolved=resolved, resolution_notes='Reconnected the workstation to the printer. Customer verified successful printing.',
        customer_confirmation=quote)
    requests = []
    def generate(prompt, schema):
        requests.append(schema)
        return payload
    monkeypatch.setattr(engine, '_generate', generate)
    monkeypatch.setattr(engine, 'retrieve', lambda *_: [])
    case = engine.analyze_completed_call(AnalysisRequest(transcript=transcript))
    assert requests == [CompletedCallAnalysisPayload]
    assert case.ticket.state == expected
    assert bool(case.ticket.resolution) == (expected == 'Resolved')
    # Ordinary intake still creates a new incident even if a model outputs Resolved.
    ordinary = engine.analyze(AnalysisRequest(transcript=transcript))
    assert ordinary.ticket.state == 'New' and ordinary.ticket.resolution == ''


def test_human_resolved_call_keeps_technician_and_team(service, monkeypatch):
    call = service.create_call('Kavya', 'browser', customer_id='customer-kavya')
    service.add_turn(call['id'], 'Technician', 'I reconnected your printer. Please try printing.')
    service.add_turn(call['id'], 'Customer', 'The printout is correct now. It is fixed.')
    service.repository.mutate(lambda db: db['calls'][call['id']].update(
        status='Connected', technician_id='tech-asha', technician_name='Asha'))
    case = service.engine.analyze(AnalysisRequest(transcript='Customer: My printer is offline and will not print.'))
    case.ticket.state = 'Resolved'
    case.ticket.resolution = 'Reconnected the printer; customer confirmed successful printing.'
    case.ticket.assignment_group = 'Endpoint Support'
    monkeypatch.setattr(service.engine, 'analyze_completed_call', lambda _: case, raising=False)
    result = service.finish(call['id'])
    saved = service.case_store.get_case(result['case_id'])
    assert saved.ticket.state == 'Resolved' and 'confirmed' in saved.ticket.resolution
    assert saved.ticket.assigned_to == 'Asha' and saved.ticket.assigned_user_id == 'tech-asha'
    assert saved.ticket.assignment_group == 'Endpoint Support' and saved.routing.handler == 'Human'
