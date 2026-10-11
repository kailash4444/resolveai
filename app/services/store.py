from datetime import datetime, timezone
from threading import Lock
from typing import Any


class MemoryStore:
    def __init__(self):
        self._cases: dict[str, dict[str, Any]] = {}
        self._lock = Lock()

    def save_case(self, case: dict[str, Any]) -> None:
        payload = dict(case)
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._cases[payload["case_id"]] = payload

    def get_case(self, case_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._cases.get(case_id)

    def list_cases(self) -> list[dict[str, Any]]:
        with self._lock:
            return sorted(self._cases.values(), key=lambda item: item.get("updated_at", ""), reverse=True)


class FirestoreStore:
    def __init__(self, project: str | None, collection: str):
        from google.cloud import firestore
        self._firestore = firestore
        self._client = firestore.Client(project=project)
        self._collection = self._client.collection(collection)

    def save_case(self, case: dict[str, Any]) -> None:
        payload = dict(case)
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._collection.document(payload["case_id"]).set(payload)

    def get_case(self, case_id: str) -> dict[str, Any] | None:
        snapshot = self._collection.document(case_id).get()
        return snapshot.to_dict() if snapshot.exists else None

    def list_cases(self) -> list[dict[str, Any]]:
        return [doc.to_dict() for doc in self._collection.order_by("updated_at", direction=self._firestore.Query.DESCENDING).limit(50).stream()]


def create_store(mode: str, project: str | None, collection: str):
    if mode == "firestore":
        return FirestoreStore(project, collection)
    return MemoryStore()
