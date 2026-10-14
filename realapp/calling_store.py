"""Transactional routing state. Mutations contain no network operations."""
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
from threading import RLock


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

    def get_call(self, call_id):
        snapshot = self.calls.document(call_id).get()
        return snapshot.to_dict() if snapshot.exists else None

    def mutate(self, operation, call_ids=None):
        from google.cloud import firestore

        @firestore.transactional
        def apply(transaction):
            snapshot = self.ref.get(transaction=transaction)
            original = snapshot.to_dict() if snapshot.exists else empty_state()
            # None means a queue-wide operation; an explicit set only reads those
            # calls. Authentication/heartbeats pass () and never scan call history.
            docs = (self.calls.stream(transaction=transaction) if call_ids is None else
                    (self.calls.document(cid).get(transaction=transaction) for cid in call_ids))
            original["calls"] = {doc.id: doc.to_dict() for doc in docs if doc.exists}
            data = deepcopy(original)
            result = operation(data)
            if data != original:
                routing = {k: v for k, v in data.items() if k != "calls"}
                if routing != {k: v for k, v in original.items() if k != "calls"}:
                    transaction.set(self.ref, routing)
                for call_id, call in data["calls"].items():
                    if call != original["calls"].get(call_id):
                        transaction.set(self.calls.document(call_id), call)
            return result

        return apply(self.client.transaction())


def create_calling_store(settings):
    if settings.calling_backend == "memory":
        return MemoryCallingStore()
    if settings.calling_backend == "firestore":
        return FirestoreCallingStore(settings.google_cloud_project, settings.firestore_collection)
    return SQLiteCallingStore(settings.calling_data_path)
