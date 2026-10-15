"""Durable KB passage embeddings; document indexing never runs on a voice turn."""
import hashlib
import json
import logging
import math
import sqlite3
import threading
import time
from pathlib import Path

from realapp.knowledge import article_document
from realapp.models import KnowledgeArticle, KnowledgeMatch

log = logging.getLogger(__name__)


def fingerprint(article):
    # Provenance changes do not change the text presented to the embedding model.
    return hashlib.sha256(article_document(article).encode()).hexdigest()


def cosine(a, b):
    norm = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
    return sum(x*y for x, y in zip(a, b)) / norm if norm else 0.0


class LocalVectors:
    """SQLite persistence locally; an isolated in-memory connection for tests."""
    def __init__(self, path, space):
        self.space = space
        self.lock = threading.RLock()
        if path != ':memory:':
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=20)
        self.db.execute('CREATE TABLE IF NOT EXISTS knowledge_vectors (space TEXT, article_id TEXT, body TEXT, PRIMARY KEY(space,article_id))')
        self.db.commit()

    def states(self):
        with self.lock:
            return {key: json.loads(body) for key, body in self.db.execute(
                'SELECT article_id,body FROM knowledge_vectors WHERE space=?', (self.space,))}

    def replace(self, article, digest, rows):
        body = {'digest': digest, 'rows': rows, 'updated_at': time.time()}
        with self.lock, self.db:
            self.db.execute('INSERT OR REPLACE INTO knowledge_vectors VALUES (?,?,?)',
                            (self.space, article.id, json.dumps(body)))
        return True

    def search(self, vector, limit):
        hits = []
        for article_id, state in self.states().items():
            for row in state['rows']:
                hits.append({'article_id': article_id, 'digest': state['digest'],
                             'score': cosine(vector, row['embedding'])})
        return sorted(hits, key=lambda row: row['score'], reverse=True)[:limit]


class FirestoreVectors:
    def __init__(self, source, collection, space):
        self.source, self.client, self.space = source, source.client, space
        self.rows = self.client.collection(collection + '_knowledge_vectors')
        self.metadata = self.client.collection(collection + '_knowledge_embedding_state')

    def states(self):
        from google.cloud.firestore_v1.base_query import FieldFilter
        return {doc.to_dict()['article_id']: doc.to_dict() for doc in
                self.metadata.where(filter=FieldFilter('embedding_space', '==', self.space)).stream()}

    def replace(self, article, digest, rows):
        from google.cloud import firestore
        from google.cloud.firestore_v1.vector import Vector
        key = hashlib.sha256((self.space + ':' + article.id).encode()).hexdigest()
        meta_ref = self.metadata.document(key)
        @firestore.transactional
        def commit(transaction):
            current = self.source.knowledge.document(article.id).get(transaction=transaction)
            old = meta_ref.get(transaction=transaction)
            # An edit during embedding generation must not publish obsolete vectors.
            if not current.exists or fingerprint(KnowledgeArticle.model_validate(current.to_dict())) != digest:
                return False
            previous = old.to_dict() if old.exists else {}
            if previous.get('digest') == digest:
                return True
            ids = [key + '-' + str(i) for i in range(len(rows))]
            for obsolete in set(previous.get('row_ids', [])) - set(ids):
                transaction.delete(self.rows.document(obsolete))
            for row_id, row in zip(ids, rows):
                transaction.set(self.rows.document(row_id), {
                    **row, 'embedding': Vector(row['embedding']), 'article_id': article.id,
                    'digest': digest, 'embedding_space': self.space})
            transaction.set(meta_ref, {'article_id': article.id, 'digest': digest,
                'embedding_space': self.space, 'row_ids': ids, 'updated_at': firestore.SERVER_TIMESTAMP})
            return True
        return commit(self.client.transaction())

    def search(self, vector, limit):
        from google.cloud.firestore_v1.vector import Vector
        from google.cloud.firestore_v1.base_query import FieldFilter
        from google.cloud.firestore_v1.base_vector_query import DistanceMeasure
        query = self.rows.where(filter=FieldFilter('embedding_space', '==', self.space)).select(
            ['article_id', 'digest', 'distance']).find_nearest(
            vector_field='embedding', query_vector=Vector(vector), limit=limit,
            distance_measure=DistanceMeasure.COSINE, distance_result_field='distance')
        return [dict(doc.to_dict(), score=1.0-doc.to_dict()['distance']) for doc in query.stream()]


class KnowledgeIndex:
    def __init__(self, settings, source, embed, vectors=None):
        if not settings.embedding_model.startswith(('gemini-embedding-', 'text-embedding-', 'text-multilingual-embedding-')):
            raise ValueError('Knowledge retrieval requires a Google embedding model.')
        self.settings, self.source, self.embed = settings, source, embed
        self.space = f'{settings.embedding_model}:{settings.embedding_dimensions}:passage-v1'
        self.lock = threading.RLock()
        if vectors is not None:
            self.vectors = vectors
        elif hasattr(source, 'knowledge') and hasattr(source, 'client'):
            self.vectors = FirestoreVectors(source, settings.firestore_collection, self.space)
        else:
            path = str(Path(source.path).with_suffix('.vectors.sqlite3')) if hasattr(source, 'path') else ':memory:'
            self.vectors = LocalVectors(path, self.space)

    def sync_all(self, strict=False):
        counts = {'indexed': 0, 'unchanged': 0, 'failed': 0}
        with self.lock:
            states = self.vectors.states()
            for article in self.source.list_knowledge():
                digest = fingerprint(article)
                if states.get(article.id, {}).get('digest') == digest:
                    counts['unchanged'] += 1
                    continue
                try:
                    body = article_document(article)
                    chunks = [f'{article.title}\n{body[start:start+1200]}' for start in range(0, len(body), 1000)]
                    # Stay below Firestore's per-transaction write limit.
                    if len(chunks) > 200:
                        raise ValueError('Knowledge article is too long to index.')
                    embeddings = self.embed(chunks, 'RETRIEVAL_DOCUMENT')
                    if len(embeddings) != len(chunks):
                        raise ValueError('Incomplete document embeddings.')
                    rows = []
                    for chunk, vector in zip(chunks, embeddings):
                        self.validate(vector)
                        rows.append({'text': chunk, 'embedding': vector,
                                     'model': self.settings.embedding_model, 'dimensions': len(vector)})
                    if not self.vectors.replace(article, digest, rows):
                        raise RuntimeError('Article changed during indexing; retrying next pass.')
                    counts['indexed'] += 1
                except Exception:
                    counts['failed'] += 1
                    log.exception('Knowledge indexing failed article=%s; retrying next pass', article.id)
                    if strict:
                        raise
        return counts

    def validate(self, vector):
        if len(vector) != self.settings.embedding_dimensions or not all(math.isfinite(v) for v in vector) or not any(vector):
            raise ValueError('Invalid embedding dimensions or values.')

    def retrieve(self, text, limit=5):
        if not text.strip():
            return []
        started = time.monotonic()
        vector = self.embed([text[-4000:]], 'RETRIEVAL_QUERY')[0]
        self.validate(vector)
        articles = {a.id: a for a in self.source.list_knowledge()}
        matches = {}
        for hit in self.vectors.search(vector, min(1000, max(50, limit*20))):
            article = articles.get(hit['article_id'])
            # Never offer stale passages while an edited article is being reindexed.
            if not article or hit['digest'] != fingerprint(article) or hit['score'] <= 0:
                continue
            if article.id not in matches:
                matches[article.id] = KnowledgeMatch(id=article.id, title=article.title,
                    score=round(max(0, min(1, hit['score'])), 3), excerpt=article.symptoms, steps=article.steps)
            if len(matches) == limit:
                break
        log.info('Knowledge vector search matches=%s duration_ms=%.0f', len(matches), (time.monotonic()-started)*1000)
        return list(matches.values())


def install_index_worker(app, source, engine):
    """Wake on saves; periodically reconcile edits and retry failures after restarts."""
    import asyncio
    from contextlib import asynccontextmanager
    previous = app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(application):
        index = getattr(engine, 'knowledge_index', None)
        async with previous(application):
            if not index:
                yield
                return
            wake = asyncio.Event()
            loop = asyncio.get_running_loop()
            source.knowledge_changed = lambda: loop.call_soon_threadsafe(wake.set)
            async def reconcile():
                while True:
                    wake.clear()
                    try:
                        if engine.configured:
                            result = await asyncio.to_thread(index.sync_all)
                            if result['indexed'] or result['failed']:
                                log.info('Knowledge indexing %s', result)
                    except Exception:
                        log.exception('Knowledge index reconciliation failed; retrying')
                    try:
                        await asyncio.wait_for(wake.wait(), timeout=30)
                    except asyncio.TimeoutError:
                        pass
            task = asyncio.create_task(reconcile())
            try:
                yield
            finally:
                source.knowledge_changed = None
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    app.router.lifespan_context = lifespan
