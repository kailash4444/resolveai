# Persistent knowledge search

ResolveAI uses Google `gemini-embedding-001` with 768 dimensions by default. In GCP,
Firestore stores passage vectors in `resolveai_cases_knowledge_vectors` and article
content hashes/index metadata in `resolveai_cases_knowledge_embedding_state`.
Firestore performs cosine nearest-neighbor search and the application returns up
to five distinct, current articles. The collection prefix follows `FIRESTORE_COLLECTION`.

## Provision and backfill

Use ADC with Vertex AI access and permissions to create Firestore indexes:

```powershell
python -m realapp.manage_knowledge_index --project YOUR_PROJECT_ID --create-index --backfill
python -m realapp.manage_knowledge_index --project YOUR_PROJECT_ID --create-index
python -m realapp.manage_knowledge_index --project YOUR_PROJECT_ID --query "How do I clear Chrome cache?"
```

Wait for the index to report `READY` before deploying the search code. The CLI is
idempotent: unchanged articles are skipped. Index creation is an administrator
operation; the runtime service account only needs its existing datastore access
and Vertex AI permissions. No new API key is needed. `firestore.indexes.json`
records the default index definition; the CLI supports custom collection prefixes
and `EMBEDDING_DIMENSIONS` (maximum 2048 for Firestore).

## Article lifecycle

Article saves wake a background indexer. New articles receive vectors; edits replace
all passages atomically, including removal of obsolete passages. A content hash
prevents stale vectors from appearing in search while the new version is indexing.
Firestore rejects an indexing write if the source article changed during generation.
Changes to provenance alone do not regenerate embeddings.

Startup reconciliation and a 30-second reconciliation loop retry incomplete/failed
indexing. Keep CPU allocated for background processing on Cloud Run (as required
for the existing voice dispatcher). After downtime, reconciliation resumes from
Firestore metadata. Calls never generate document embeddings: they generate one
query embedding and search the stored index. Model, dimensions and chunking version
form the embedding namespace, so incompatible vectors cannot mix.

Local SQLite installations keep vectors in a sibling `.vectors.sqlite3` database;
memory/mock environments remain isolated. Do not commit runtime vector databases.

## Avoiding duplicate articles

Before auto-publishing from a resolved incident, or generating a manual incident
draft, ResolveAI retrieves candidate articles and asks Gemini whether one already
covers the incident's product, symptoms and documented resolution. A similar topic
alone is insufficient. A high-confidence match skips generation; the manual UI
shows the existing article. If the coverage check fails, generation is deferred
rather than assuming there is no existing article. Automatic publishing logs the
failure; retry the incident's resolution workflow after restoring the provider.

Semantic checks are probabilistic. Low-confidence matches are treated as new
knowledge; staff should still review the KB. Existing duplicate articles are not
automatically merged or deleted. Auto-publish jobs are serialized within a server
process; this does not provide a cross-instance semantic uniqueness constraint.

References: [Firestore vector search](https://firebase.google.com/docs/firestore/vector-search)
and [Google text embeddings](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings).
