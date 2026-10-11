from copy import deepcopy
from uuid import uuid4
import sqlite3
from pathlib import Path
from threading import RLock

from realapp.knowledge import SEED_ARTICLES
from realapp.models import CaseRecord, KnowledgeArticle, KnowledgeArticleInput


class MemoryStore:
    def __init__(self) -> None:
        self._cases: dict[str, CaseRecord] = {}
        self._lock = RLock()
        self._knowledge = {article.id: deepcopy(article) for article in SEED_ARTICLES}

    def save_case(self, case: CaseRecord) -> CaseRecord:
        with self._lock:
            self._cases[case.id] = deepcopy(case)
        return deepcopy(case)

    def save_audit(self, original, audit):
        with self._lock:
            current = self.get_case(original.id)
            if current and current == original:
                current.qa_checks, current.quality_score = audit.checks, audit.quality_score
                self.save_case(current)
            return current

    def get_case(self, case_id: str) -> CaseRecord | None:
        case = self._cases.get(case_id)
        return deepcopy(case) if case else None

    def list_cases(self) -> list[CaseRecord]:
        return sorted((deepcopy(c) for c in self._cases.values()), key=lambda c: c.created_at, reverse=True)

    def list_knowledge(self) -> list[KnowledgeArticle]:
        return sorted((deepcopy(a) for a in self._knowledge.values()), key=lambda a: a.id)

    def add_knowledge(self, value: KnowledgeArticleInput) -> KnowledgeArticle:
        article_id = value.id or f"KB-{uuid4().hex[:6].upper()}"
        article = KnowledgeArticle(**value.model_dump(exclude={"id"}), id=article_id)
        self._knowledge[article.id] = deepcopy(article)
        return article


class FirestoreStore:
    def __init__(self, project: str | None, collection: str) -> None:
        from google.cloud import firestore

        self.client = firestore.Client(project=project)
        self.cases = self.client.collection(collection)
        self.knowledge = self.client.collection(f"{collection}_knowledge")

    def save_case(self, case: CaseRecord) -> CaseRecord:
        self.cases.document(case.id).set(case.model_dump(mode="json"))
        return case

    def save_audit(self, original, audit):
        from google.cloud import firestore

        @firestore.transactional
        def commit(transaction):
            ref = self.cases.document(original.id)
            snapshot = ref.get(transaction=transaction)
            current = CaseRecord.model_validate(snapshot.to_dict()) if snapshot.exists else None
            if current and current == original:
                current.qa_checks, current.quality_score = audit.checks, audit.quality_score
                transaction.update(ref, {'qa_checks': current.model_dump(mode='json')['qa_checks'], 'quality_score': current.quality_score})
            return current

        return commit(self.client.transaction())

    def get_case(self, case_id: str) -> CaseRecord | None:
        snapshot = self.cases.document(case_id).get()
        return CaseRecord.model_validate(snapshot.to_dict()) if snapshot.exists else None

    def list_cases(self) -> list[CaseRecord]:
        return sorted((CaseRecord.model_validate(doc.to_dict()) for doc in self.cases.stream()), key=lambda c: c.created_at, reverse=True)

    def list_knowledge(self) -> list[KnowledgeArticle]:
        articles = [KnowledgeArticle.model_validate(doc.to_dict()) for doc in self.knowledge.stream()]
        return sorted(articles or [deepcopy(a) for a in SEED_ARTICLES], key=lambda a: a.id)

    def add_knowledge(self, value: KnowledgeArticleInput) -> KnowledgeArticle:
        article_id = value.id or f"KB-{uuid4().hex[:6].upper()}"
        article = KnowledgeArticle(**value.model_dump(exclude={"id"}), id=article_id)
        self.knowledge.document(article.id).set(article.model_dump(mode="json"))
        return article


class SQLiteStore(MemoryStore):
    """Local durable tickets and knowledge; API keys never enter this database."""

    def __init__(self, path):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, body TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, body TEXT NOT NULL)")
            for article in SEED_ARTICLES:
                db.execute("INSERT OR IGNORE INTO knowledge VALUES (?, ?)", (article.id, article.model_dump_json()))

    def connection(self):
        return sqlite3.connect(self.path, timeout=20)

    def save_case(self, case):
        with self.connection() as db:
            db.execute("INSERT OR REPLACE INTO cases VALUES (?, ?)", (case.id, case.model_dump_json()))
        return case.model_copy(deep=True)

    def save_audit(self, original, audit):
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT body FROM cases WHERE id = ?', (original.id,)).fetchone()
            current = CaseRecord.model_validate_json(row[0]) if row else None
            if current and current == original:
                current.qa_checks, current.quality_score = audit.checks, audit.quality_score
                db.execute('UPDATE cases SET body = ? WHERE id = ?', (current.model_dump_json(), current.id))
            return current

    def get_case(self, case_id):
        with self.connection() as db:
            row = db.execute("SELECT body FROM cases WHERE id = ?", (case_id,)).fetchone()
        return CaseRecord.model_validate_json(row[0]) if row else None

    def list_cases(self):
        with self.connection() as db:
            rows = db.execute("SELECT body FROM cases").fetchall()
        return sorted((CaseRecord.model_validate_json(row[0]) for row in rows), key=lambda c: c.created_at, reverse=True)

    def list_knowledge(self):
        with self.connection() as db:
            return [KnowledgeArticle.model_validate_json(row[0]) for row in db.execute("SELECT body FROM knowledge ORDER BY id")]

    def add_knowledge(self, value):
        article = KnowledgeArticle(**value.model_dump(exclude={"id"}), id=value.id or f"KB-{uuid4().hex[:6].upper()}")
        with self.connection() as db:
            db.execute("INSERT OR REPLACE INTO knowledge VALUES (?, ?)", (article.id, article.model_dump_json()))
        return article


def create_store(settings):
    if settings.data_backend == "firestore":
        return FirestoreStore(settings.google_cloud_project, settings.firestore_collection)
    if settings.data_backend == "sqlite":
        return SQLiteStore(settings.local_data_path)
    return MemoryStore()
