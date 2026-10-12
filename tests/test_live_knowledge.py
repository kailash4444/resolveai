import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from realapp import main
from realapp.config import Settings
from realapp.gemini import GeminiEngine
from realapp.models import KnowledgeArticle
from realapp.livekit_transport import BrowserSession
from test_roles import accounts, create_incident


def article(number, text='Payroll fails'):
    return KnowledgeArticle(id=f'KB-{number}', title=text, product='Payroll', symptoms=text,
                            steps=['Check service status'], resolution='Access restored', tags=['payroll'])


def test_google_ranking_top_five_and_content_cache_invalidation():
    articles = [article(i, f'Problem {i}') for i in range(7)]
    engine = GeminiEngine(Settings(gemini_provider='vertex', google_cloud_project='test-project'), lambda: articles)
    def embed(*, contents, config, model):
        assert model == 'gemini-embedding-001'
        vector = [1., 0.] if config.task_type == 'RETRIEVAL_QUERY' else [1., float(contents.split('Problem ')[1][0])]
        return SimpleNamespace(embeddings=[SimpleNamespace(values=vector)])
    api = Mock(side_effect=embed)
    engine._client = SimpleNamespace(models=SimpleNamespace(embed_content=api))
    assert [x.id for x in engine.retrieve('Cannot open payroll')] == [f'KB-{i}' for i in range(5)]
    assert api.call_count == 8
    engine.retrieve('New customer symptom')
    assert api.call_count == 9  # unchanged documents are reused
    articles[0] = article(0, 'Problem 6 changed')
    engine.retrieve('Another customer symptom')
    assert api.call_count == 11  # edited text is re-embedded
    articles.pop()
    engine.retrieve('Another symptom')
    assert len(engine._document_vectors) == 6


def test_call_retrieval_tracks_customer_problem_and_never_overwrites_ticket(accounts):
    service = accounts.service
    call = service.create_call('Customer', customer_id=accounts.customer_a_id)
    service.add_turn(call['id'], 'Customer', 'Payroll fails when exporting a report.')
    service.add_turn(call['id'], 'Technician', 'Can you explain the error?')
    call = service.triage(call['id'])
    original = accounts.store.get_case(call['case_id'])
    match = SimpleNamespace(model_dump=lambda: {'id':'KB-1','title':'Payroll','score':.9,'excerpt':'Export error','steps':['Check reports']})
    def retrieve(query, limit):
        assert 'Can you explain' not in query and 'Payroll' in query and limit == 5
        updated = accounts.store.get_case(call['case_id'])
        updated.ticket.description = 'Technician edit during retrieval'
        accounts.store.save_case(updated)
        return [match]
    service.knowledge_engine = SimpleNamespace(retrieve=retrieve)
    service.refresh_knowledge(call['id'])
    assert service.get(call['id'])['knowledge_matches'][0]['id'] == 'KB-1'
    assert accounts.store.get_case(original.id).ticket.description == 'Technician edit during retrieval'
    def stale(query, limit):
        service.add_turn(call['id'], 'Customer', 'Now an entirely different error appears.')
        return []
    service.knowledge_engine = SimpleNamespace(retrieve=stale)
    service.refresh_knowledge(call['id'])
    assert service.get(call['id'])['knowledge_matches'][0]['id'] == 'KB-1'
    service.knowledge_engine = SimpleNamespace(retrieve=Mock(side_effect=RuntimeError('private provider detail')))
    service.refresh_knowledge(call['id'])
    current = service.get(call['id'])
    assert current['knowledge_status'] == 'error' and 'private' not in current['knowledge_error']
    assert current['status'] not in {'Failed', 'Completed'}


def test_customer_never_enters_service_team_and_ticket_filters_are_scoped(accounts):
    f = accounts
    one, two = create_incident(f.customer_a), create_incident(f.customer_b)
    f.admin.patch('/api/cases/'+one['id']+'/ticket', json={'assigned_user_id':f.tech_a_id})
    f.admin.patch('/api/cases/'+two['id']+'/ticket', json={'assigned_user_id':f.tech_b_id})
    for client in [f.admin, f.tech_a, f.tech_b]:
        assert len(client.get('/api/cases').json()) == 2
        result = client.get('/api/cases', params={'ticket_number':one['ticket']['id'].lower(), 'assigned_to':'tech_a'}).json()
        assert [x['id'] for x in result] == [one['id']]
        assert client.get('/api/cases', params={'ticket_number':one['ticket']['id'], 'assigned_to':'tech_b'}).json() == []
        assert all(t['role'] != 'customer' for t in client.get('/api/calling').json()['technicians'])
    assert len(f.customer_a.get('/api/cases').json()) == 1
    assert f.customer_a.get('/api/cases', params={'ticket_number':two['ticket']['id']}).json() == []
    assert f.customer_a.get('/api/cases', params={'assigned_to':'tech_b'}).json() == []
    assert f.customer_a.patch('/api/technicians/me/presence', json={'status':'Available'}).status_code == 403
    assert f.customer_a.post('/api/technicians/me/heartbeat', json={'voice_ready':True}).status_code == 403
    with pytest.raises(HTTPException):
        f.service.presence(f.customer_a_id, 'Available')


def test_connected_speech_starts_nonblocking_coalesced_retrieval(accounts):
    async def run():
        f = accounts
        call = f.service.create_call('Customer', customer_id=f.customer_a_id)
        f.service.repository.mutate(lambda db: db['calls'][call['id']].update(status='Connected'))
        f.service.engine.transcribe = lambda *args: 'Payroll export fails.'
        refresh = Mock()
        f.service.refresh_knowledge = refresh
        transport = SimpleNamespace(service=f.service, settings=main.settings)
        session = BrowserSession(transport, call['id'])
        await session.process_utterance('Customer', b'audio')
        await session.process_utterance('Customer', b'audio')
        refresh.assert_not_called()
        await session.knowledge_task
        refresh.assert_called_once_with(call['id'])
        await session.process_utterance('Technician', b'audio')
        assert refresh.call_count == 1
    asyncio.run(run())
