from copy import deepcopy
import json
import sqlite3
from pathlib import Path
from threading import Lock, RLock

from realapp.knowledge import SEED_ARTICLES
from realapp.models import (CaseRecord, EngineeringFollowup, IssueCluster, KnowledgeArticle,
                            KnowledgeArticleInput, ResolutionAssessment)
from realapp.numbering import assign_case, assign_article, sync_case, migrate


class MemoryStore:
    def __init__(self) -> None:
        self._cases: dict[str, CaseRecord] = {}
        self._lock = RLock()
        self._meta = {}
        self._knowledge = {}
        for article in SEED_ARTICLES:
            saved = assign_article(article, None, self._meta)
            self._knowledge[saved.id] = saved
        self._resolution_assessments: dict[str, ResolutionAssessment] = {}
        self._radar_clusters: dict[str, IssueCluster] = {}
        self._engineering_followups: dict[str, EngineeringFollowup] = {}

    def save_case(self, case: CaseRecord) -> CaseRecord:
        with self._lock:
            saved = assign_case(case, self._cases.get(case.id), self._meta)
            self._cases[case.id] = saved
        return sync_case(case, saved)

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

    def list_cases_for_service(self, service: str) -> list[CaseRecord]:
        key = service.strip().casefold()
        return [deepcopy(case) for case in self._cases.values()
                if case.ticket.service.strip().casefold() == key]

    def list_knowledge(self) -> list[KnowledgeArticle]:
        return sorted((deepcopy(a) for a in self._knowledge.values()), key=lambda a: a.id)

    def add_knowledge(self, value: KnowledgeArticleInput) -> KnowledgeArticle:
        with self._lock:
            key = self._meta.get('knowledge_aliases',{}).get(value.id,value.id)
            article = assign_article(value,self._knowledge.get(key),self._meta)
            self._knowledge[article.id] = deepcopy(article)
            if getattr(self, 'knowledge_changed', None):
                self.knowledge_changed()
            return article

    def migrate_numbers(self):
        with self._lock:
            cases, articles, aliases = migrate(list(self._cases.values()),list(self._knowledge.values()),self._meta)
            self._cases = {case.id:case for case in cases}
            self._knowledge = {article.id:article for article in articles}
            return aliases

    def get_resolution_assessment(self, case_id: str) -> ResolutionAssessment | None:
        with self._lock:
            value = self._resolution_assessments.get(case_id)
            return deepcopy(value) if value else None

    def save_resolution_assessment(self, value: ResolutionAssessment) -> ResolutionAssessment:
        with self._lock:
            self._resolution_assessments[value.case_id] = deepcopy(value)
        return deepcopy(value)

    def list_resolution_assessments(self) -> list[ResolutionAssessment]:
        with self._lock:
            return [deepcopy(value) for value in self._resolution_assessments.values()]

    def get_radar_cluster(self, cluster_id: str) -> IssueCluster | None:
        with self._lock:
            value = self._radar_clusters.get(cluster_id)
            return deepcopy(value) if value else None

    def save_radar_cluster(self, value: IssueCluster) -> IssueCluster:
        with self._lock:
            self._radar_clusters[value.id] = deepcopy(value)
        return deepcopy(value)

    def list_radar_clusters(self) -> list[IssueCluster]:
        with self._lock:
            return [deepcopy(value) for value in self._radar_clusters.values()]

    def save_engineering_followup(self, value: EngineeringFollowup) -> EngineeringFollowup:
        with self._lock:
            self._engineering_followups[value.id] = deepcopy(value)
        return deepcopy(value)

    def get_engineering_followup(self, followup_id: str) -> EngineeringFollowup | None:
        with self._lock:
            value = self._engineering_followups.get(followup_id)
            return deepcopy(value) if value else None

    def list_engineering_followups(self, cluster_id: str) -> list[EngineeringFollowup]:
        with self._lock:
            return [deepcopy(value) for value in self._engineering_followups.values()
                    if value.cluster_id == cluster_id]


CHANGE_LOG = 200


def changed_since(changes, cached_version, version):
    """Ids written after `cached_version`, or None when the change log doesn't cover every version in between (the
    cache is too old, or something changed without an id) and the caller must reload everything."""
    if cached_version is None or version < cached_version:
        return None
    entries = ((e['v'], e['id']) if isinstance(e, dict) else tuple(e) for e in (changes or []))
    recorded = {v: key for v, key in entries if cached_version < v <= version}
    if len(recorded) != version - cached_version:
        return None
    return list(dict.fromkeys(recorded[v] for v in sorted(recorded)))


class FirestoreStore:
    def __init__(self, project: str | None, collection: str) -> None:
        from google.cloud import firestore

        self.client = firestore.Client(project=project)
        self.cases = self.client.collection(collection)
        self.knowledge = self.client.collection(f"{collection}_knowledge")
        self.numbers = self.client.collection(f"{collection}_metadata").document("numbers")
        self.radar_assessments = self.client.collection(f"{collection}_resolution_assessments")
        self.radar_clusters = self.client.collection(f"{collection}_resolution_clusters")
        self.radar_followups = self.client.collection(f"{collection}_engineering_followups")
        # Lists of incidents and articles are cached per server instance. Every write bumps a counter in the numbers
        # document (inside the same transaction), so one small read tells any instance whether its copy is current.
        self._cache_lock = Lock()
        self._cases_cache = None       # (cases_version, [CaseRecord])
        self._knowledge_cache = None   # (knowledge_version, [KnowledgeArticle])

    def _versions(self):
        snapshot = self.numbers.get()
        return snapshot.to_dict() if snapshot.exists else {}

    @staticmethod
    def _bump(meta, key, changed_id=None):
        meta[key] = meta.get(key, 0) + 1
        # The last few changed incidents, so an instance that is only a little behind fetches just those instead of the
        # whole list. A write without an id (a migration) leaves a gap, which makes everyone reload in full.
        if key == 'cases_version' and changed_id:
            # Firestore can't store a list inside a list, so each entry is a small map.
            meta['cases_changes'] = (meta.get('cases_changes') or [])[-(CHANGE_LOG - 1):] + [{'v': meta[key], 'id': changed_id}]

    def save_case(self, case: CaseRecord) -> CaseRecord:
        from google.cloud import firestore
        @firestore.transactional
        def save(transaction):
            ref = self.cases.document(case.id)
            snapshot = ref.get(transaction=transaction)
            counter = self.numbers.get(transaction=transaction)
            meta = counter.to_dict() if counter.exists else {}
            existing = CaseRecord.model_validate(snapshot.to_dict()) if snapshot.exists else None
            saved = assign_case(case,existing,meta)
            self._bump(meta, 'cases_version', saved.id)
            transaction.set(self.numbers,meta)
            transaction.set(ref,saved.model_dump(mode='json'))
            return saved
        return sync_case(case,save(self.client.transaction()))

    def save_audit(self, original, audit):
        from google.cloud import firestore

        @firestore.transactional
        def commit(transaction):
            ref = self.cases.document(original.id)
            snapshot = ref.get(transaction=transaction)
            current = CaseRecord.model_validate(snapshot.to_dict()) if snapshot.exists else None
            if current and current == original:
                current.qa_checks, current.quality_score = audit.checks, audit.quality_score
                counter = self.numbers.get(transaction=transaction)
                meta = counter.to_dict() if counter.exists else {}
                self._bump(meta, 'cases_version', original.id)
                transaction.update(ref, {'qa_checks': current.model_dump(mode='json')['qa_checks'], 'quality_score': current.quality_score})
                transaction.set(self.numbers, meta)
            return current

        return commit(self.client.transaction())

    def get_case(self, case_id: str) -> CaseRecord | None:
        snapshot = self.cases.document(case_id).get()
        return CaseRecord.model_validate(snapshot.to_dict()) if snapshot.exists else None

    def list_cases(self) -> list[CaseRecord]:
        meta = self._versions()
        version = meta.get('cases_version', 0)
        with self._cache_lock:
            cached = self._cases_cache
        if cached and cached[0] == version:
            return [case.model_copy(deep=True) for case in cached[1]]
        changed = changed_since(meta.get('cases_changes'), cached[0] if cached else None, version)
        if changed is not None:
            # Only a few incidents changed since this copy was made: fetch just those.
            by_id = {case.id: case for case in cached[1]}
            for case_id in changed:
                snapshot = self.cases.document(case_id).get()
                if snapshot.exists:
                    by_id[case_id] = CaseRecord.model_validate(snapshot.to_dict())
            cases = sorted(by_id.values(), key=lambda c: c.created_at, reverse=True)
        else:
            cases = sorted((CaseRecord.model_validate(doc.to_dict()) for doc in self.cases.stream()), key=lambda c: c.created_at, reverse=True)
        with self._cache_lock:
            self._cases_cache = (version, cases)
        return [case.model_copy(deep=True) for case in cases]

    def list_cases_for_service(self, service: str) -> list[CaseRecord]:
        docs = self.cases.where('ticket.service', '==', service).stream()
        return [CaseRecord.model_validate(doc.to_dict()) for doc in docs]

    def list_knowledge(self) -> list[KnowledgeArticle]:
        version = self._versions().get('knowledge_version', 0)
        with self._cache_lock:
            cached = self._knowledge_cache
        if cached and cached[0] == version:
            return [article.model_copy(deep=True) for article in cached[1]]
        articles = [KnowledgeArticle.model_validate(doc.to_dict()) for doc in self.knowledge.stream()]
        articles = sorted(articles or [deepcopy(a) for a in SEED_ARTICLES], key=lambda a: a.id)
        with self._cache_lock:
            self._knowledge_cache = (version, articles)
        return [article.model_copy(deep=True) for article in articles]

    def add_knowledge(self, value: KnowledgeArticleInput) -> KnowledgeArticle:
        from google.cloud import firestore
        @firestore.transactional
        def save(transaction):
            snapshot = self.numbers.get(transaction=transaction)
            meta = snapshot.to_dict() if snapshot.exists else {}
            key = meta.get('knowledge_aliases',{}).get(value.id,value.id)
            current = self.knowledge.document(key).get(transaction=transaction) if key else None
            existing = KnowledgeArticle.model_validate(current.to_dict()) if current and current.exists else None
            saved = assign_article(value,existing,meta)
            self._bump(meta, 'knowledge_version')
            transaction.set(self.numbers,meta)
            transaction.set(self.knowledge.document(saved.id),saved.model_dump(mode='json'))
            return saved
        saved = save(self.client.transaction())
        if getattr(self, 'knowledge_changed', None):
            self.knowledge_changed()
        return saved

    def migrate_numbers(self):
        from google.cloud import firestore
        @firestore.transactional
        def convert(transaction):
            snapshot = self.numbers.get(transaction=transaction)
            meta = snapshot.to_dict() if snapshot.exists else {}
            case_docs = list(self.cases.stream(transaction=transaction))
            article_docs = list(self.knowledge.stream(transaction=transaction))
            cases = [CaseRecord.model_validate(doc.to_dict()) for doc in case_docs]
            articles = [KnowledgeArticle.model_validate(doc.to_dict()) for doc in article_docs] or deepcopy(SEED_ARTICLES)
            cases, articles, aliases = migrate(cases,articles,meta)
            for case in cases: transaction.set(self.cases.document(case.id),case.model_dump(mode='json'))
            old_ids = {doc.id for doc in article_docs} - {a.id for a in articles}
            for key in old_ids: transaction.delete(self.knowledge.document(key))
            for article in articles: transaction.set(self.knowledge.document(article.id),article.model_dump(mode='json'))
            self._bump(meta, 'cases_version'); self._bump(meta, 'knowledge_version')
            transaction.set(self.numbers,meta)
            return aliases
        return convert(self.client.transaction())

    def get_resolution_assessment(self, case_id: str) -> ResolutionAssessment | None:
        snapshot = self.radar_assessments.document(case_id).get()
        return ResolutionAssessment.model_validate(snapshot.to_dict()) if snapshot.exists else None

    def save_resolution_assessment(self, value: ResolutionAssessment) -> ResolutionAssessment:
        self.radar_assessments.document(value.case_id).set(value.model_dump(mode='json'))
        return value

    def list_resolution_assessments(self) -> list[ResolutionAssessment]:
        return [ResolutionAssessment.model_validate(doc.to_dict()) for doc in self.radar_assessments.stream()]

    def get_radar_cluster(self, cluster_id: str) -> IssueCluster | None:
        snapshot = self.radar_clusters.document(cluster_id).get()
        return IssueCluster.model_validate(snapshot.to_dict()) if snapshot.exists else None

    def save_radar_cluster(self, value: IssueCluster) -> IssueCluster:
        self.radar_clusters.document(value.id).set(value.model_dump(mode='json'))
        return value

    def list_radar_clusters(self) -> list[IssueCluster]:
        return [IssueCluster.model_validate(doc.to_dict()) for doc in self.radar_clusters.stream()]

    def save_engineering_followup(self, value: EngineeringFollowup) -> EngineeringFollowup:
        self.radar_followups.document(value.id).set(value.model_dump(mode='json'))
        return value

    def get_engineering_followup(self, followup_id: str) -> EngineeringFollowup | None:
        snapshot = self.radar_followups.document(followup_id).get()
        return EngineeringFollowup.model_validate(snapshot.to_dict()) if snapshot.exists else None

    def list_engineering_followups(self, cluster_id: str) -> list[EngineeringFollowup]:
        return [EngineeringFollowup.model_validate(doc.to_dict()) for doc in
                self.radar_followups.where('cluster_id', '==', cluster_id).stream()]


class SQLiteStore(MemoryStore):
    """Local durable tickets and knowledge; API keys never enter this database."""

    def __init__(self, path):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, body TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, body TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, body TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS resolution_assessments (case_id TEXT PRIMARY KEY, body TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS resolution_clusters (id TEXT PRIMARY KEY, body TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS engineering_followups (id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, body TEXT NOT NULL)")
            if db.execute('SELECT COUNT(*) FROM knowledge').fetchone()[0] == 0:
                for article in SEED_ARTICLES:
                    db.execute("INSERT INTO knowledge VALUES (?, ?)", (article.id, article.model_dump_json()))
        self.migrate_numbers()

    def connection(self):
        return sqlite3.connect(self.path, timeout=20)

    def save_case(self, case):
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            meta = self._read_meta(db)
            row = db.execute('SELECT body FROM cases WHERE id=?',(case.id,)).fetchone()
            existing = CaseRecord.model_validate_json(row[0]) if row else None
            saved = assign_case(case,existing,meta)
            db.execute("INSERT OR REPLACE INTO cases VALUES (?, ?)", (saved.id, saved.model_dump_json()))
            self._write_meta(db,meta)
        return sync_case(case,saved)

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

    def list_cases_for_service(self, service):
        with self.connection() as db:
            rows = db.execute("SELECT body FROM cases WHERE json_extract(body, '$.ticket.service') = ?",
                              (service,)).fetchall()
        return [CaseRecord.model_validate_json(row[0]) for row in rows]

    def list_knowledge(self):
        with self.connection() as db:
            return [KnowledgeArticle.model_validate_json(row[0]) for row in db.execute("SELECT body FROM knowledge ORDER BY id")]

    def add_knowledge(self, value):
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            meta = self._read_meta(db)
            key = meta.get('knowledge_aliases',{}).get(value.id,value.id)
            row = db.execute('SELECT body FROM knowledge WHERE id=?',(key,)).fetchone() if key else None
            existing = KnowledgeArticle.model_validate_json(row[0]) if row else None
            article = assign_article(value,existing,meta)
            db.execute("INSERT OR REPLACE INTO knowledge VALUES (?, ?)", (article.id, article.model_dump_json()))
            self._write_meta(db,meta)
        if getattr(self, 'knowledge_changed', None):
            self.knowledge_changed()
        return article

    @staticmethod
    def _read_meta(db):
        row = db.execute("SELECT body FROM metadata WHERE id='numbers'").fetchone()
        return json.loads(row[0]) if row else {}

    @staticmethod
    def _write_meta(db,meta):
        db.execute("INSERT OR REPLACE INTO metadata VALUES ('numbers',?)",(json.dumps(meta),))

    def migrate_numbers(self):
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            meta = self._read_meta(db)
            cases = [CaseRecord.model_validate_json(row[0]) for row in db.execute('SELECT body FROM cases')]
            articles = [KnowledgeArticle.model_validate_json(row[0]) for row in db.execute('SELECT body FROM knowledge')]
            cases, articles, aliases = migrate(cases,articles,meta)
            for case in cases: db.execute('UPDATE cases SET body=? WHERE id=?',(case.model_dump_json(),case.id))
            db.execute('DELETE FROM knowledge')
            db.executemany('INSERT INTO knowledge VALUES (?,?)',[(a.id,a.model_dump_json()) for a in articles])
            self._write_meta(db,meta)
            return aliases

    def get_resolution_assessment(self, case_id):
        with self.connection() as db:
            row = db.execute('SELECT body FROM resolution_assessments WHERE case_id = ?', (case_id,)).fetchone()
        return ResolutionAssessment.model_validate_json(row[0]) if row else None

    def save_resolution_assessment(self, value):
        with self.connection() as db:
            db.execute('INSERT OR REPLACE INTO resolution_assessments VALUES (?, ?)',
                       (value.case_id, value.model_dump_json()))
        return value

    def list_resolution_assessments(self):
        with self.connection() as db:
            rows = db.execute('SELECT body FROM resolution_assessments').fetchall()
        return [ResolutionAssessment.model_validate_json(row[0]) for row in rows]

    def get_radar_cluster(self, cluster_id):
        with self.connection() as db:
            row = db.execute('SELECT body FROM resolution_clusters WHERE id = ?', (cluster_id,)).fetchone()
        return IssueCluster.model_validate_json(row[0]) if row else None

    def save_radar_cluster(self, value):
        with self.connection() as db:
            db.execute('INSERT OR REPLACE INTO resolution_clusters VALUES (?, ?)',
                       (value.id, value.model_dump_json()))
        return value

    def list_radar_clusters(self):
        with self.connection() as db:
            rows = db.execute('SELECT body FROM resolution_clusters').fetchall()
        return [IssueCluster.model_validate_json(row[0]) for row in rows]

    def save_engineering_followup(self, value):
        with self.connection() as db:
            db.execute('INSERT OR REPLACE INTO engineering_followups VALUES (?, ?, ?)',
                       (value.id, value.cluster_id, value.model_dump_json()))
        return value

    def get_engineering_followup(self, followup_id):
        with self.connection() as db:
            row = db.execute('SELECT body FROM engineering_followups WHERE id = ?', (followup_id,)).fetchone()
        return EngineeringFollowup.model_validate_json(row[0]) if row else None

    def list_engineering_followups(self, cluster_id):
        with self.connection() as db:
            rows = db.execute('SELECT body FROM engineering_followups WHERE cluster_id = ?',
                              (cluster_id,)).fetchall()
        return [EngineeringFollowup.model_validate_json(row[0]) for row in rows]


def create_store(settings):
    if settings.data_backend == "firestore":
        return FirestoreStore(settings.google_cloud_project, settings.firestore_collection)
    if settings.data_backend == "sqlite":
        return SQLiteStore(settings.local_data_path)
    return MemoryStore()
