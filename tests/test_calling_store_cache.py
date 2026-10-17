"""The call list is cached per server instance: a read fetches only the calls saved since that instance last looked,
the dispatcher works on active calls only, and nothing scans every call ever made on the busy paths."""
from copy import deepcopy
from threading import Lock
from types import SimpleNamespace

from realapp import calling_store
from realapp.calling_store import ACTIVE_CALLS, FirestoreCallingStore


def fake_firestore(monkeypatch):
    from google.cloud import firestore
    monkeypatch.setattr(firestore, 'transactional', lambda fn: fn)
    docs, log = {'coordinator': {'technicians': {}, 'sessions': {}, 'login_attempts': {}}}, []

    def snap(key):
        return SimpleNamespace(id=key, exists=key in docs, to_dict=lambda: deepcopy(docs[key]))

    class Doc:
        def __init__(self, key): self.id = key
        def get(self, **_): return snap(self.id)

    class Query:
        def __init__(self, f): self.f = f
        def stream(self, **_):
            log.append(f'query {self.f.field_path} {self.f.op_string}')
            ops = {'>=': lambda a, b: a is not None and a >= b, 'not-in': lambda a, b: a not in b}
            return [snap(k) for k, v in docs.items() if k != 'coordinator' and ops[self.f.op_string](v.get(self.f.field_path), self.f.value)]

    class Calls:
        def document(self, key): return Doc(key)
        def stream(self, **_):
            log.append('full scan')
            return [snap(k) for k in docs if k != 'coordinator']
        def where(self, filter): return Query(filter)

    class Transaction:
        def set(self, ref, body): docs[ref.id] = deepcopy(body)

    def instance():
        store = object.__new__(FirestoreCallingStore)
        store.client = SimpleNamespace(transaction=Transaction)
        store.ref, store.calls = Doc('coordinator'), Calls()
        store._lock, store._calls_cache = Lock(), None
        return store
    return instance, log, docs


def add_call(call_id, status='Queued'):
    def create(db):
        db['calls'][call_id] = {'id': call_id, 'status': status, 'transcript': []}
        return db['calls'][call_id]
    return create


def test_a_call_saved_by_another_instance_shows_without_rereading_every_call(monkeypatch):
    instance, log, docs = fake_firestore(monkeypatch)
    first, second = instance(), instance()
    first.mutate(add_call('CALL-1', 'Completed'), call_ids=())
    assert set(first.read(lambda db: db['calls'])) == {'CALL-1'} and log.count('full scan') == 1

    second.mutate(add_call('CALL-2'), call_ids=())                       # written by the other instance
    second.mutate(lambda db: db['calls']['CALL-1'].update(status='Failed'), call_ids=('CALL-1',))
    calls = first.read(lambda db: db['calls'])
    assert set(calls) == {'CALL-1', 'CALL-2'} and calls['CALL-1']['status'] == 'Failed'
    assert log.count('full scan') == 1                                    # only the changed calls were fetched
    assert docs['CALL-2'][calling_store.SYNC_FIELD] > 0

    calls['CALL-2']['status'] = 'changed by a caller'
    assert first.read(lambda db: db['calls'])['CALL-2']['status'] == 'Queued'   # callers get their own copies


def test_the_dispatcher_only_reads_active_calls(monkeypatch):
    instance, log, _ = fake_firestore(monkeypatch)
    store = instance()
    store.mutate(add_call('CALL-OLD', 'Completed'), call_ids=())
    store.mutate(add_call('CALL-NEW', 'Queued'), call_ids=())
    log.clear()
    seen = store.mutate(lambda db: sorted(db['calls']), call_ids=ACTIVE_CALLS)
    assert seen == ['CALL-NEW'] and 'full scan' not in log and log == ['query status not-in']


def test_a_full_refresh_still_happens_every_ten_minutes(monkeypatch):
    instance, log, _ = fake_firestore(monkeypatch)
    store = instance()
    store.mutate(add_call('CALL-1'), call_ids=())
    clock = [1000.0]
    monkeypatch.setattr(calling_store.time, 'time', lambda: clock[0])
    store.read(lambda db: db['calls'])
    scans = log.count('full scan')
    clock[0] += 60
    store.read(lambda db: db['calls'])
    assert log.count('full scan') == scans
    clock[0] += calling_store.FULL_REFRESH
    store.read(lambda db: db['calls'])
    assert log.count('full scan') == scans + 1


def test_the_dispatcher_takes_no_lock_when_nothing_is_waiting():
    from test_calling import webapp as _  # noqa: F401
    from realapp.config import Settings
    from realapp.calling import CallingService
    from realapp.calling_store import MemoryCallingStore
    from realapp.store import MemoryStore
    service = CallingService(Settings(llm_provider='mock', calling_backend='memory', data_backend='memory'), MemoryCallingStore(), MemoryStore(), None)
    locks = []
    original = service.repository.mutate
    service.repository.mutate = lambda op, call_ids=None: (locks.append(call_ids), original(op, call_ids))[1]
    service.create_call('Caller')                       # a desk request still with the AI (Triage), nothing to route yet
    locks.clear()
    assert service.dispatch() == [] and locks == []
    call = service.create_call('Caller 2')
    service.enqueue(call['id'], 'Needs a person')
    locks.clear()
    service.dispatch()
    assert locks == [ACTIVE_CALLS]                      # a waiting call: the routing transaction runs, on active calls only
