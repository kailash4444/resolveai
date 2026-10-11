# ResolveAI — Provider architecture

> Current runtime: OpenAI with `gpt-6-luna`, `gpt-4o-mini-transcribe`, and `text-embedding-3-small`. See `OPENAI_SETUP.md`. The Gemini details below describe the retained provider used when `LLM_PROVIDER` is changed to `google_ai` or `vertex`.

ResolveAI is a locally runnable enterprise service-desk workflow designed for deployment to Google Cloud. It accepts a real customer conversation, uses Gemini embeddings to retrieve relevant knowledge, uses Gemini to understand and route the issue, drafts a structured ticket, and performs a separate QA review against transcript evidence.

## What is implemented

- Free-form transcript intake for voice, chat, email, and walk-up conversations
- Optional browser speech capture for live note-taking
- Gemini structured issue understanding: summary, intent, product, urgency, sentiment, and entities
- Risk and confidence-based routing to AI or a human technician
- Gemini embedding search across editable knowledge articles
- Structured incident generation with short description, description, category, service, priority, assignment, and an initial New state
- Editable incident lifecycle with New, In Progress, On Hold, and Resolved states
- Technician work notes and customer comments after work begins; resolution notes are captured only at resolution
- Ticket editing and lifecycle updates
- Independent AI QA pass after resolution with transcript evidence, recommendations, and a quality score
- QA rerun after edits to a resolved ticket
- Dynamic operations overview, ticket list, themes, and quality metrics
- In-memory persistence for local work and Firestore persistence for Google Cloud
- Cloud Run container and Cloud Build deployment configuration

The browser never receives the Gemini API key. All Gemini calls originate from the FastAPI server.

## Run locally

Open PowerShell in this folder and set the Gemini key only for the current terminal session:

```powershell
$env:GEMINI_API_KEY="your-key"
$env:GEMINI_PROVIDER="google_ai"
.\run-local-real.ps1 -Install
```

Then open `http://127.0.0.1:8080`. On later runs, omit `-Install`.

For a temporary offline development fixture, set `GEMINI_PROVIDER=mock`. That mode exists for automated tests and does not make Gemini calls.

## Request flow

```text
Conversation
    │
    ├─ Gemini Embeddings ──> rank knowledge articles
    │
    ├─ Gemini Analysis ────> understanding + routing + ticket draft
    │
    └─ Independent Gemini QA ──> field checks + evidence + score
                                      │
Ticket edit ──────────────────────────┘  (rerun on demand)
```

The server uses structured Pydantic response schemas for both generative calls. If Gemini is not configured, analysis returns a clear `503` response; the system does not silently substitute a mock answer.

## API surface

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/analyze` | Retrieve knowledge, analyze a transcript, and create a New incident |
| `GET` | `/api/cases` | List cases and tickets |
| `GET` | `/api/cases/{id}` | Retrieve one case |
| `PATCH` | `/api/cases/{id}/ticket` | Save reviewed ticket fields |
| `POST` | `/api/cases/{id}/work-notes` | Add technician work notes or customer comments after work begins |
| `POST` | `/api/cases/{id}/qa` | Run the independent QA model after the incident is Resolved |
| `GET` | `/api/knowledge` | List searchable knowledge articles |
| `POST` | `/api/knowledge` | Add a searchable article |
| `GET` | `/api/overview` | Return metrics calculated from stored cases |
| `GET` | `/api/config` | Return non-secret model and connection status |

## Deploy to Google Cloud

The included production path uses Cloud Run, Vertex AI Gemini, Firestore, Artifact Registry, and Cloud Build. This avoids distributing a Gemini API key to the deployed service; Cloud Run uses its service identity to call Vertex AI.

1. Install and authenticate the Google Cloud CLI.
2. Grant the Cloud Run service identity `Vertex AI User` and Firestore access appropriate to your project.
3. From this folder run:

```powershell
.\deploy-real-gcp.ps1 -ProjectId "your-project-id" -Region "us-central1"
```

The deployment script enables the required APIs, creates the Artifact Registry repository when needed, and submits `cloudbuild-real.yaml`. For a production environment, restrict Cloud Run ingress/authentication and use least-privilege service-account roles before handling customer data.

## Key project files

- `realapp/main.py` — HTTP API and dynamic overview
- `realapp/gemini.py` — Gemini embeddings, structured analysis, routing, and QA
- `realapp/store.py` — memory and Firestore stores
- `realapp/static/` — responsive operator interface
- `Dockerfile.gcp` — Cloud Run image
- `cloudbuild-real.yaml` — Google Cloud build and deploy pipeline
- `tests/test_real_api.py` — end-to-end API workflow tests using the deterministic test provider

## Current local limitation

The full interface can run before credentials are supplied, but real analysis is intentionally unavailable until `GEMINI_API_KEY` is configured. Once the key is set and the server is restarted, the same interface uses Gemini embeddings, Gemini structured generation, and Gemini QA without code changes.
