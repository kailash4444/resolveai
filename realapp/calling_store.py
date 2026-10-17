"""Transactional routing state. Mutations contain no network operations."""
from copy import deepcopy
import json
import time
from pathlib import Path
import sqlite3
from threading import Lock, RLock


# Calls that have finished. Everything else (triage, AI, queued, ringing, connected) is still active.
FINISHED_STATUSES = ("Completed", "Callback requested", "Failed")
# Pass as call_ids to work on the active calls only (the dispatcher). Stores that hold everything in one place ignore it.
ACTIVE_CALLS = "active"
# Each saved call carries the time it was written, so an instance can fetch just the calls changed since it last looked.
SYNC_FIELD = "_synced_at"
SYNC_OVERLAP = 15        # seconds re-read on each sync, covering clock differences between instances
FULL_REFRESH = 600       # a full re-read every 10 minutes as a safety net


def empty_state():
    return {"technicians": {}, "calls": {}, "sessions": {}, "login_attempts": {}}


class MemoryCallingStore:
    def __init__(self):
        self.data = empty_state()
        self.lock = RLock()

    def get_call(self, call_id):
        with self.lock:
            return deepcopy(self.data['calls'].get(call_id))

    def mutate(self, operation, call_ids=None):
        with self.lock:
            data = deepcopy(self.data)
            result = operation(data)
            self.data = data
            return deepcopy(result)

    def read(self, operation, call_ids=None):
        with self.lock:
            return deepcopy(operation(deepcopy(self.data)))


class SQLiteCallingStore:
    def __init__(self, path):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS routing (id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
            db.execute("INSERT OR IGNORE INTO routing VALUES (1, ?)", (json.dumps(empty_state()),))

    def get_call(self, call_id):
        with sqlite3.connect(self.path, timeout=20) as db:
            data = json.loads(db.execute('SELECT body FROM routing WHERE id=1').fetchone()[0])
            return data['calls'].get(call_id)

    def read(self, operation, call_ids=None):
        # Read-only: no write lock, so reads never wait behind heartbeats or call updates.
        with sqlite3.connect(self.path, timeout=20) as db:
            data = json.loads(db.execute('SELECT body FROM routing WHERE id=1').fetchone()[0])
        return deepcopy(operation(data))

    def mutate(self, operation, call_ids=None):
        with sqlite3.connect(self.path, timeout=20, isolation_level=None) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                original = db.execute("SELECT body FROM routing WHERE id=1").fetchone()[0]
                data = json.loads(original)
                result = operation(data)
                updated = json.dumps(data)
                if updated != original:
                    db.execute("UPDATE routing SET body=? WHERE id=1", (updated,))
                db.commit()
                return deepcopy(result)
            except Exception:
                db.rollback()
                raise


class FirestoreCallingStore:
    """Small-team routing coordinator. Call transcripts live in separate documents.

    Split this coordinator by tenant/queue before large contact-center deployment.
    Transactions guarantee reservations across Cloud Run instances.
    """
    def __init__(self, project, collection):
        from google.cloud import firestore
        self.client = firestore.Client(project=project)
        self.ref = self.client.collection(f"{collection}_routing").document("coordinator")
        self.calls = self.client.collection(f"{collection}_calls")
        # Every call is cached per instance. Each write stamps the call with the time it was saved, so a read fetches
        # only the calls saved since this instance last looked (no shared counter that every write would contend on).
        self._lock = Lock()
        self._calls_cache = None   # (synced_at, full_at, {call_id: call})

    def get_call(self, call_id):
        snapshot = self.calls.document(call_id).get()
        return snapshot.to_dict() if snapshot.exists else None

    def _all_calls(self):
        from google.cloud.firestore_v1.base_query import FieldFilter
        now = time.time()
        with self._lock:
            cached = self._calls_cache
        if cached and now - cached[1] < FULL_REFRESH:
            calls = dict(cached[2])
            for doc in self.calls.where(filter=FieldFilter(SYNC_FIELD, ">=", cached[0] - SYNC_OVERLAP)).stream():
                calls[doc.id] = doc.to_dict()
            fresh = (now, cached[1], calls)
        else:
            calls = {doc.id: doc.to_dict() for doc in self.calls.stream()}
            fresh = (now, now, calls)
        with self._lock:
            if not self._calls_cache or self._calls_cache[0] <= now:
                self._calls_cache = fresh
        return deepcopy(calls)

    def read(self, operation, call_ids=None):
        """Read-only snapshot without a transaction. Firestore transactions lock what they read, so using them for
        lookups (sessions, the calls overview) made every request queue behind heartbeats and call updates."""
        snapshot = self.ref.get()
        data = snapshot.to_dict() if snapshot.exists else empty_state()
        if call_ids is None or call_ids == ACTIVE_CALLS:
            data["calls"] = self._all_calls()
        else:
            docs = (self.calls.document(cid).get() for cid in call_ids)
            data["calls"] = {doc.id: doc.to_dict() for doc in docs if doc.exists}
        return operation(data)

    def mutate(self, operation, call_ids=None):
        from google.cloud import firestore
        from google.cloud.firestore_v1.base_query import FieldFilter

        @firestore.transactional
        def apply(transaction):
            snapshot = self.ref.get(transaction=transaction)
            original = snapshot.to_dict() if snapshot.exists else empty_state()
            # None means every call (rare: start-up migrations); ACTIVE_CALLS only the calls still in progress (the
            # dispatcher, every couple of seconds); an explicit set reads just those. Authentication and heartbeats
            # pass () and never touch calls.
            if call_ids is None:
                docs = self.calls.stream(transaction=transaction)
            elif call_ids == ACTIVE_CALLS:
                docs = self.calls.where(filter=FieldFilter("status", "not-in", list(FINISHED_STATUSES))).stream(transaction=transaction)
            else:
                docs = (self.calls.document(cid).get(transaction=transaction) for cid in call_ids)
            original["calls"] = {doc.id: doc.to_dict() for doc in docs if doc.exists}
            data = deepcopy(original)
            result = operation(data)
            if data != original:
                routing = {k: v for k, v in data.items() if k != "calls"}
                if routing != {k: v for k, v in original.items() if k != "calls"}:
                    transaction.set(self.ref, routing)
                for call_id, call in data["calls"].items():
                    if call != original["calls"].get(call_id):
                        transaction.set(self.calls.document(call_id), {**call, SYNC_FIELD: time.time()})
            return result

        return apply(self.client.transaction())


def create_calling_store(settings):
    if settings.calling_backend == "memory":
        return MemoryCallingStore()
    if settings.calling_backend == "firestore":
        return FirestoreCallingStore(settings.google_cloud_project, settings.firestore_collection)
    return SQLiteCallingStore(settings.calling_data_path)
