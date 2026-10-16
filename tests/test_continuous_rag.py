import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

from test_calling import service
from realapp.livekit_transport import BrowserSession, LiveKitTransport


def match(id):
    return SimpleNamespace(model_dump=lambda: {'id': id, 'title': id, 'steps': ['Check the error'], 'score': .9})


def call_for(service):
    call = service.create_call('Customer', 'browser')
    service.repository.mutate(lambda db: db['calls'][call['id']].update(status='Connected'))
    service.add_turn(call['id'], 'Customer', 'My browser cannot open the payroll portal.')
    return call['id']


def test_query_retains_original_and_recent_speaker_labelled_context(service):
    id = call_for(service)
    service.add_turn(id, 'Technician', 'OLD unrelated observation')
    for n in range(10):
        service.add_turn(id, 'Customer', f'Additional diagnostic detail {n}')
    service.add_turn(id, 'Technician', 'Cache clearing was suggested; DNS lookup returns NXDOMAIN.')
    service.add_turn(id, 'Customer', 'Clearing the cache did not fix it.')
    query = service.knowledge_query(service.get(id))
    assert 'Original customer issue: My browser' in query
    assert 'Technician: Cache clearing was suggested; DNS lookup returns NXDOMAIN.' in query
    assert 'Customer: Clearing the cache did not fix it.' in query
    assert 'OLD unrelated' not in query and len(query) <= 4000
    service.add_turn(id, 'Customer', 'Okay.')
    assert service.knowledge_query(service.get(id)) == query
    service.add_turn(id, 'Technician', 'Did restarting fix the error?')
    service.add_turn(id, 'Customer', 'No.')
    assert 'Customer: No.' in service.knowledge_query(service.get(id))


def test_conversation_continuing_does_not_starve_results(service):
    id = call_for(service)
    original_revision = service.get(id)['transcript_revision']
    def retrieve(query, limit):
        assert limit == 5
        service.add_turn(id, 'Technician', 'DNS is reporting NXDOMAIN.')
        return [match('KB00001')]
    service.knowledge_engine = SimpleNamespace(retrieve=retrieve)
    service.refresh_knowledge(id)
    call = service.get(id)
    assert call['knowledge_matches'][0]['id'] == 'KB00001'
    assert call['knowledge_revision'] == original_revision
    assert call['knowledge_status'] == 'updating'
    def latest(query, limit):
        assert 'NXDOMAIN' in query
        return [match('KB00002')]
    service.knowledge_engine.retrieve = latest
    service.refresh_knowledge(id)
    call = service.get(id)
    assert call['knowledge_revision'] == call['transcript_revision']
    assert call['knowledge_status'] == 'ready' and call['knowledge_matches'][0]['id'] == 'KB00002'


def test_original_issue_and_monotonic_revision_survive_transcript_window(service):
    id = call_for(service)
    for i in range(160):
        service.add_turn(id, 'Technician', f'Diagnostic observation {i}')
    call = service.get(id)
    assert len(call['transcript']) == 150 and call['transcript_revision'] == 161
    query = service.knowledge_query(call)
    assert 'My browser cannot open the payroll portal.' in query and 'observation 159' in query


def test_error_preserves_previous_results_and_evidence_time(service):
    id = call_for(service)
    service.knowledge_engine = SimpleNamespace(retrieve=lambda *a, **k: [match('KB00001')])
    service.refresh_knowledge(id)
    before = service.get(id)
    service.add_turn(id, 'Technician', 'The portal now returns HTTP 503.')
    def broken(*a, **k): raise RuntimeError('secret provider information')
    service.knowledge_engine.retrieve = broken
    service.refresh_knowledge(id)
    after = service.get(id)
    assert after['knowledge_status'] == 'error' and 'secret' not in after['knowledge_error']
    for field in ('knowledge_matches', 'knowledge_revision', 'knowledge_through_at', 'knowledge_updated_at'):
        assert after[field] == before[field]


def test_acknowledgements_do_not_generate_redundant_embeddings(service):
    id = call_for(service)
    queries = []
    def retrieve(query, limit):
        queries.append(query)
        return [match('KB00001')]
    service.knowledge_engine = SimpleNamespace(retrieve=retrieve)
    service.refresh_knowledge(id)
    service.add_turn(id, 'Customer', 'Thank you!')
    service.refresh_knowledge(id)
    assert len(queries) == 1
    call = service.get(id)
    assert call['knowledge_revision'] == call['transcript_revision']


def test_late_search_cannot_update_ended_call(service):
    id = call_for(service)
    def retrieve(*a, **k):
        service.repository.mutate(lambda db: db['calls'][id].update(status='Completed'))
        return [match('KB00001')]
    service.knowledge_engine = SimpleNamespace(retrieve=retrieve)
    service.refresh_knowledge(id)
    assert not service.get(id).get('knowledge_matches')


def test_older_completion_cannot_overwrite_published_revision(service):
    id = call_for(service)
    def retrieve(*a, **k):
        service.add_turn(id, 'Customer', 'A newer issue')
        service.repository.mutate(lambda db: db['calls'][id].update(knowledge_revision=2,
            knowledge_matches=[{'id': 'KB00002'}], knowledge_status='ready'))
        return [match('KB00001')]
    service.knowledge_engine = SimpleNamespace(retrieve=retrieve)
    service.refresh_knowledge(id)
    assert service.get(id)['knowledge_matches'] == [{'id': 'KB00002'}]


def test_simultaneous_search_requests_serialize_and_coalesce(service):
    id = call_for(service)
    entered, release = threading.Event(), threading.Event()
    queries = []
    def retrieve(query, limit):
        queries.append(query)
        entered.set()
        assert release.wait(5)
        return [match('KB00001')]
    service.knowledge_engine = SimpleNamespace(retrieve=retrieve)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(service.refresh_knowledge, id)
        assert entered.wait(2)
        second = pool.submit(service.refresh_knowledge, id)
        release.set()
        first.result(3); second.result(3)
    assert len(queries) == 1


def test_a_slow_call_search_does_not_block_another_call(service):
    first_id, second_id = call_for(service), call_for(service)
    service.add_turn(first_id, 'Customer', 'First call has a slow lookup.')
    entered, release = threading.Event(), threading.Event()
    def retrieve(query, limit):
        if 'slow lookup' in query:
            entered.set()
            assert release.wait(5)
        return [match('KB00001')]
    service.knowledge_engine = SimpleNamespace(retrieve=retrieve)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(service.refresh_knowledge, first_id)
        try:
            assert entered.wait(2)
            second = pool.submit(service.refresh_knowledge, second_id)
            second.result(2)
            assert service.get(second_id)['knowledge_status'] == 'ready' and not first.done()
        finally:
            release.set()
        first.result(2)
    assert not service._knowledge_locks


def test_speech_continues_during_search_and_latest_turns_are_searched_next(service):
    async def run():
        id = call_for(service)
        session = BrowserSession(LiveKitTransport(service.settings, service), id)
        entered, release = threading.Event(), threading.Event()
        queries = []
        def retrieve(query, limit):
            queries.append(query)
            if len(queries) == 1:
                entered.set()
                assert release.wait(5)
            return [match(f'KB{len(queries):05}')]
        service.knowledge_engine = SimpleNamespace(retrieve=retrieve)
        await session.record_text('Customer', 'It shows a connection error.')
        try:
            assert await asyncio.to_thread(entered.wait, 3)
            worker = session.knowledge_task
            await asyncio.wait_for(session.record_text('Technician', 'The DNS lookup returns NXDOMAIN.'), .5)
            await asyncio.wait_for(session.record_text('Customer', 'Other websites work.'), .5)
            assert session.knowledge_task is worker and len(queries) == 1
            release.set()
            await asyncio.wait_for(worker, 4)
            assert len(queries) == 2 and 'NXDOMAIN' in queries[-1] and 'Other websites work' in queries[-1]
            assert service.get(id)['knowledge_matches'][0]['id'] == 'KB00002'
        finally:
            release.set()
            session.closed = True
            if session.knowledge_task and not session.knowledge_task.done():
                session.knowledge_task.cancel()
                await asyncio.gather(session.knowledge_task, return_exceptions=True)
    asyncio.run(run())
