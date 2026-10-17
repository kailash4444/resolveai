"""Incident and article lists are cached per server instance and refreshed the moment anything is written, by this
instance or another one: every write bumps a counter in Firestore that each list call checks with one small read."""
from threading import Lock
from types import SimpleNamespace

from realapp.config import Settings
from realapp.gemini import GeminiEngine
from realapp.models import AnalysisRequest, KnowledgeArticleInput
from realapp.store import FirestoreStore, MemoryStore


def sample_case(title):
    case = GeminiEngine(Settings(llm_provider='mock'), MemoryStore().list_knowledge).analyze(
        AnalysisRequest(transcript=f'Customer: {title} printer is offline and nothing prints.', caller='Casey', channel='Voice'))
    case.issue_title = title
    return case


def fake_firestore(monkeypatch):
    from google.cloud import firestore
    monkeypatch.setattr(firestore, 'transactional', lambda fn: fn)
    documents, streams = {}, []

    class Doc:
        def __init__(self, path): self.path, self.id = path, path.split('/')[-1]
        def get(self, **_):
            body = documents.get(self.path)
            return SimpleNamespace(exists=body is not None, to_dict=lambda: dict(body) if body is not None else None, id=self.id)

    class Collection:
        def __init__(self, name): self.name = name
        def document(self, key): return Doc(f'{self.name}/{key}')
        def stream(self, **_):
            streams.append(self.name)
            return [Doc(path).get() for path in list(documents) if path.startswith(self.name + '/')]

    class Transaction:
        def set(self, ref, body): documents[ref.path] = body
        def update(self, ref, fields): documents[ref.path] = {**documents[ref.path], **fields}

    client = SimpleNamespace(collection=Collection, transaction=Transaction)

    def instance():
        store = object.__new__(FirestoreStore)
        store.client = client
        store.cases, store.knowledge = Collection('cases'), Collection('cases_knowledge')
        store.numbers = Collection('cases_metadata').document('numbers')
        store._cache_lock, store._cases_cache, store._knowledge_cache = Lock(), None, None
        return store
    return instance, streams


def test_case_list_is_cached_until_any_instance_writes(monkeypatch):
    instance, streams = fake_firestore(monkeypatch)
    first, second = instance(), instance()          # two Cloud Run instances sharing one database
    first.save_case(sample_case('One'))
    assert [c.issue_title for c in first.list_cases()] == ['One']
    reads = streams.count('cases')
    first.list_cases(); first.list_cases()
    assert streams.count('cases') == reads           # served from cache: no full re-read

    copy = first.list_cases()[0]
    copy.ticket.short_description = 'changed by a caller'
    assert first.list_cases()[0].ticket.short_description != 'changed by a caller'   # callers get their own copies

    second.save_case(sample_case('Two'))            # written by the other instance
    assert sorted(c.issue_title for c in first.list_cases()) == ['One', 'Two']
    assert streams.count('cases') == reads           # only the changed incident was fetched, not the whole list

    # An edit to an existing incident replaces it in place.
    two = next(c for c in first.list_cases() if c.issue_title == 'Two')
    two.ticket.state = 'Resolved'
    second.save_case(two)
    assert next(c for c in first.list_cases() if c.issue_title == 'Two').ticket.state == 'Resolved'
    assert streams.count('cases') == reads


def test_a_gap_in_the_change_log_falls_back_to_a_full_reload(monkeypatch):
    from realapp.store import changed_since
    assert changed_since([[3, 'A'], [4, 'B'], [5, 'A']], 2, 5) == ['A', 'B']
    assert changed_since([[4, 'B']], 2, 4) is None          # version 3 changed without an id (for example a migration)
    assert changed_since([[3, 'A']], None, 3) is None       # nothing cached yet
    instance, streams = fake_firestore(monkeypatch)
    store = instance()
    store.save_case(sample_case('One'))
    store.list_cases()
    reads = streams.count('cases')
    meta = store._versions(); meta['cases_version'] += 1     # a write that left no id behind
    store.client.transaction().set(store.numbers, meta)
    store.list_cases()
    assert streams.count('cases') == reads + 1


def test_article_list_is_cached_and_refreshed_after_a_new_article(monkeypatch):
    instance, streams = fake_firestore(monkeypatch)
    store = instance()
    before = len(store.list_knowledge())
    store.list_knowledge()
    assert streams.count('cases_knowledge') == 1
    store.add_knowledge(KnowledgeArticleInput(title='Reset the print spooler', product='Printing', symptoms='Jobs stay in the queue.',
                                              steps=['Open Services.', 'Restart Print Spooler.'], resolution='Jobs print again.', tags=['printer']))
    assert len(store.list_knowledge()) >= 1 and streams.count('cases_knowledge') == 2
    assert any(a.title == 'Reset the print spooler' for a in store.list_knowledge())
    assert before >= 1
