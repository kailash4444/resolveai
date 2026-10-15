"""Lookups must not lock the shared routing record: in production (Firestore) every locked read queued behind
heartbeats and call updates, which made pages and API calls take tens of seconds."""
from test_calling import service, technician, request
from realapp.calling import Login


class Counting:
    """Wraps the store and counts locked (mutate) and plain (read) access."""
    def __init__(self, store):
        self.store, self.mutates, self.reads = store, [], []

    def get_call(self, call_id):
        return self.store.get_call(call_id)

    def mutate(self, operation, call_ids=None):
        self.mutates.append(call_ids)
        return self.store.mutate(operation, call_ids)

    def read(self, operation, call_ids=None):
        self.reads.append(call_ids)
        return self.store.read(operation, call_ids)


def counted(service):
    service.repository = Counting(service.repository)
    return service.repository


def test_session_check_and_calls_overview_are_plain_reads(service):
    technician(service)
    token, _ = service.login(Login(username='alex', password='test-password-12345', expected_role='technician'), 'test')
    store = counted(service)
    assert service.authenticate(token)['username'] == 'alex'
    assert service.has_users()
    service.snapshot()
    assert store.mutates == [] and len(store.reads) == 3


def test_heartbeat_writes_only_when_something_changed_or_last_seen_is_getting_old(service):
    tech = technician(service)
    service.heartbeat(tech['id'], True)
    store = counted(service)
    service.heartbeat(tech['id'], True)                 # nothing changed, just written: no write
    assert store.mutates == []
    service.heartbeat(tech['id'], False)                # voice readiness changed: written at once
    assert store.mutates == [()]
    clock = service.now()
    service.now = lambda: clock + service.settings.technician_heartbeat_seconds / 3 + 1
    service.heartbeat(tech['id'], False)                # unchanged but last_seen is a third of the way to expiry
    assert store.mutates == [(), ()]
    assert service.snapshot()['technicians'][0]['voice_ready'] is False


def test_single_call_updates_only_load_that_call(service):
    tech = technician(service)
    call = request(service)
    store = counted(service)
    service.enqueue(call['id'], 'Customer asked for a person')
    service.finish(call['id'])
    assert store.mutates == [(call['id'],), (call['id'],)]


def test_firestore_read_never_opens_a_transaction():
    from copy import deepcopy
    from types import SimpleNamespace
    from realapp.calling_store import FirestoreCallingStore
    reads, transactions = [], []
    data = {'coordinator': {'technicians': {}, 'sessions': {'s': {'technician_id': 't'}}}, 'CALL-A': {'id': 'CALL-A'}}
    class Document:
        def __init__(self, id): self.id = id
        def get(self, **kwargs):
            assert 'transaction' not in kwargs, 'plain reads must not join a transaction'
            reads.append(self.id)
            return SimpleNamespace(id=self.id, exists=self.id in data, to_dict=lambda: deepcopy(data[self.id]))
    class Collection:
        def document(self, id): return Document(id)
        def stream(self, **kwargs): raise AssertionError('Full call scan')
    store = object.__new__(FirestoreCallingStore)
    store.ref = Document('coordinator'); store.calls = Collection()
    store.client = SimpleNamespace(transaction=lambda: transactions.append(1))
    assert store.read(lambda db: list(db['sessions']), call_ids=()) == ['s']
    assert store.read(lambda db: db['calls']['CALL-A']['id'], call_ids=('CALL-A',)) == 'CALL-A'
    assert reads == ['coordinator', 'coordinator', 'CALL-A'] and transactions == []
