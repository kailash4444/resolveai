import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import Mock

from realapp.config import Settings
from realapp.gemini import GeminiEngine
from realapp.knowledge_vectors import KnowledgeIndex, fingerprint, install_index_worker
from realapp.models import KnowledgeArticleInput, KnowledgeContent, KnowledgeCoverage
from realapp.resolved_knowledge import ResolvedKnowledgePublisher
from realapp.store import MemoryStore, SQLiteStore
from test_incident_knowledge import incident, draft_app
from realapp.engine import OpenAIEngine


def settings():
    return Settings(_env_file=None, gemini_provider='vertex', google_cloud_project='test', embedding_dimensions=128)


def embed(texts, task):
    return [[1.0] + [0.0]*127 for _ in texts]


def new_article(**updates):
    return KnowledgeArticleInput(**dict(dict(title='Clear browser cache', product='Chrome', symptoms='Page is blank',
        steps=['Open Settings', 'Clear cached files and retry'], resolution='Page loads', tags=['browser']), **updates))


def test_vectors_survive_restart_and_voice_search_never_embeds_documents(tmp_path):
    store = SQLiteStore(str(tmp_path/'app.sqlite3'))
    saved = store.add_knowledge(new_article())
    provider = Mock(side_effect=embed)
    index = KnowledgeIndex(settings(), store, provider)
    assert index.sync_all()['indexed'] == 5
    assert index.sync_all() == {'indexed': 0, 'unchanged': 5, 'failed': 0}
    restarted = KnowledgeIndex(settings(), SQLiteStore(store.path), provider)
    provider.reset_mock()
    assert restarted.sync_all()['unchanged'] == 5
    assert saved.id in [m.id for m in restarted.retrieve('Blank browser', limit=5)]
    assert [call.args[1] for call in provider.call_args_list] == ['RETRIEVAL_QUERY']


def test_edit_hides_stale_vectors_then_replaces_old_passages(tmp_path):
    store = SQLiteStore(str(tmp_path/'app.sqlite3'))
    saved = store.add_knowledge(new_article(symptoms='Long problem ' * 250))
    provider = Mock(side_effect=embed)
    index = KnowledgeIndex(settings(), store, provider)
    index.sync_all()
    assert len(index.vectors.states()[saved.id]['rows']) > 1
    changed = store.add_knowledge(new_article(id=saved.id, symptoms='Different browser problem'))
    assert saved.id not in [m.id for m in index.retrieve('browser', limit=20)]
    provider.reset_mock()
    assert index.sync_all() == {'indexed': 1, 'unchanged': 4, 'failed': 0}
    state = index.vectors.states()[saved.id]
    assert state['digest'] == fingerprint(changed) and len(state['rows']) == 1
    assert provider.call_count == 1
    assert saved.id in [m.id for m in index.retrieve('browser', limit=20)]
    # Linking another incident is not an article-content change.
    store.add_knowledge(changed.model_copy(update={'source_ticket_ids': ['INC0000001']}))
    provider.reset_mock()
    assert index.sync_all()['indexed'] == 0
    provider.assert_not_called()


def test_failed_indexing_retries_and_does_not_publish_partial_vectors():
    store = MemoryStore()
    saved = store.add_knowledge(new_article())
    index = KnowledgeIndex(settings(), store, embed)
    index.sync_all()
    old = index.vectors.states()[saved.id]
    store.add_knowledge(new_article(id=saved.id, symptoms='A new failure'))
    index.embed = Mock(side_effect=RuntimeError('Temporary provider outage'))
    assert index.sync_all()['failed'] == 1
    assert index.vectors.states()[saved.id] == old
    index.embed = embed
    assert index.sync_all()['indexed'] == 1


def test_model_or_dimensions_change_requires_reindex(tmp_path):
    store = SQLiteStore(str(tmp_path/'app.sqlite3'))
    first = KnowledgeIndex(settings(), store, embed)
    first.sync_all()
    changed = settings().model_copy(update={'embedding_model': 'text-embedding-005'})
    index = KnowledgeIndex(changed, store, embed)
    assert index.sync_all()['indexed'] == 4


def test_semantic_duplicate_is_checked_before_generation():
    store = MemoryStore()
    engine = OpenAIEngine(Settings(llm_provider='mock'), store.list_knowledge)
    case = incident(engine); store.save_case(case)
    existing = store.add_knowledge(new_article())
    engine.find_existing_knowledge = Mock(return_value=existing)
    engine.draft_knowledge = Mock(side_effect=AssertionError('Must not generate a duplicate'))
    ResolvedKnowledgePublisher(store, store, engine, lambda _: None).publish(case.id)
    engine.find_existing_knowledge.assert_called_once()
    engine.draft_knowledge.assert_not_called()
    assert len(store.list_knowledge()) == 5


def test_distinct_resolution_publishes_new_article_and_wakes_indexer():
    store = MemoryStore()
    engine = OpenAIEngine(Settings(llm_provider='mock'), store.list_knowledge)
    case = incident(engine); case.ticket.trace_id = 'a' * 32; store.save_case(case)
    engine.find_existing_knowledge = Mock(return_value=None)
    engine.draft_knowledge = Mock(return_value=KnowledgeContent(**new_article().model_dump(exclude={'id', 'source_ticket_ids'})))
    store.knowledge_changed = Mock()
    ResolvedKnowledgePublisher(store, store, engine, lambda _: None).publish(case.id)
    assert len(store.list_knowledge()) == 5
    assert any('a' * 32 in article.source_trace_ids for article in store.list_knowledge())
    store.knowledge_changed.assert_called_once()


def test_draft_endpoint_returns_existing_article_without_generating(draft_app):
    env = draft_app
    existing = env.store.add_knowledge(new_article())
    env.engine.find_existing_knowledge = Mock(return_value=existing)
    response = env.client.post('/api/knowledge/from-incidents', json={'ticket_numbers': [env.first.ticket.id]})
    assert response.status_code == 200
    assert response.json()['existing_article'] == {'id': existing.id, 'title': existing.title}
    assert not env.captured
    assert 'source_ticket_ids' not in response.json()['existing_article']


def test_coverage_rejects_unknown_id_and_uncertain_matches():
    import json
    store = MemoryStore()
    existing = store.add_knowledge(new_article())
    engine = GeminiEngine(settings(), store.list_knowledge)
    engine.knowledge_index = SimpleNamespace(sync_all=Mock())
    engine.retrieve = Mock(return_value=[SimpleNamespace(id=existing.id)])
    context = json.dumps([{'ticket': {'short_description': 'Browser blank', 'resolution': 'Cleared cache'}}])
    for article_id, confidence, expected in [(existing.id, .95, existing), (existing.id, .5, None), ('KB-NOT-A-CANDIDATE', 1, None), (None, 1, None)]:
        engine._generate = Mock(return_value=KnowledgeCoverage(article_id=article_id, confidence=confidence, reason='Compared fixes'))
        assert engine.find_existing_knowledge(context) == expected


def test_background_worker_indexes_saves_and_stops_cleanly():
    from fastapi import FastAPI
    async def run():
        app = FastAPI()
        store = MemoryStore()
        index = KnowledgeIndex(settings(), store, embed)
        engine = SimpleNamespace(knowledge_index=index, configured=True)
        install_index_worker(app, store, engine)
        async with app.router.lifespan_context(app):
            for _ in range(100):
                if len(index.vectors.states()) == 4: break
                await asyncio.sleep(.01)
            saved = store.add_knowledge(new_article())
            for _ in range(100):
                if saved.id in index.vectors.states(): break
                await asyncio.sleep(.01)
            assert saved.id in index.vectors.states()
        assert store.knowledge_changed is None
    asyncio.run(run())


def test_firestore_replacement_removes_old_passages_and_rejects_stale_source(monkeypatch):
    from google.cloud import firestore
    from realapp.knowledge_vectors import FirestoreVectors
    monkeypatch.setattr(firestore, 'transactional', lambda fn: fn)
    documents = {}
    class Doc:
        def __init__(self, path): self.path = path
        def get(self, **kwargs):
            return SimpleNamespace(exists=self.path in documents, to_dict=lambda: documents.get(self.path))
    class Collection:
        def __init__(self, name): self.name = name
        def document(self, key): return Doc(self.name+'/'+key)
    writes = []
    class Transaction:
        def set(self, ref, body):
            writes.append(('set', ref.path)); documents[ref.path] = body
        def delete(self, ref):
            writes.append(('delete', ref.path)); documents.pop(ref.path, None)
    source = SimpleNamespace(client=SimpleNamespace(collection=Collection, transaction=Transaction), knowledge=Collection('articles'))
    vectors = FirestoreVectors(source, 'app', 'test-space')
    article = MemoryStore().add_knowledge(new_article())
    documents['articles/'+article.id] = article.model_dump()
    rows = [{'embedding': [1., 0.], 'text': 'first'}, {'embedding': [0., 1.], 'text': 'second'}]
    assert vectors.replace(article, fingerprint(article), rows)
    assert len([key for key in documents if key.startswith('app_knowledge_vectors/')]) == 2
    updated = article.model_copy(update={'symptoms': 'Changed problem'})
    documents['articles/'+article.id] = updated.model_dump()
    writes.clear()
    assert not vectors.replace(article, fingerprint(article), rows)
    assert not writes
    assert vectors.replace(updated, fingerprint(updated), rows[:1])
    assert len([key for key in documents if key.startswith('app_knowledge_vectors/')]) == 1
    assert any(kind == 'delete' for kind, _ in writes)
