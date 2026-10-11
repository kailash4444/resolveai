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

    def mutate(self, operation):
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

    def mutate(self, operation):
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

    def mutate(self, operation):
        from google.cloud import firestore

        @firestore.transactional
        def apply(transaction):
            snapshot = self.ref.get(transaction=transaction)
            original = snapshot.to_dict() if snapshot.exists else empty_state()
            original["calls"] = {doc.id: doc.to_dict() for doc in self.calls.stream(transaction=transaction)}
            data = deepcopy(original)
            result = operation(data)
            if data != original:
                transaction.set(self.ref, {k: v for k, v in data.items() if k != "calls"})
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
