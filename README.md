# ResolveAI

ResolveAI is an enterprise service desk configured for Google's Gemini services using the Google Gen AI SDK. Gemini handles incident understanding, routing, knowledge retrieval, ticket drafting, QA, transcription, and spoken replies. LiveKit handles the browser audio connection.

| Function | Default model |
| --- | --- |
| Text processing, classification, ticket generation, QA | `gemini-3.8-flash` |
| Audio transcription | `gemini-3.8-flash` |
| Knowledge embeddings | `gemini-embedding-001` |
| Spoken replies | `gemini-3.8-flash-lite-tts`, voice `Kore` |

Local mode defaults to `LLM_PROVIDER=google_ai`; set `LLM_PROVIDER=vertex` and `GEMINI_PROVIDER=vertex` to use Application Default Credentials (ADC) without an API key. The administrator can save one shared Gemini API key through **Configure key**. It is protected in the Windows profile and reused across restarts. No key is returned to technicians or customers. See [GOOGLE_SETUP.md](GOOGLE_SETUP.md).

Cloud deployment defaults to `LLM_PROVIDER=vertex`: Google services authenticate with the Cloud Run service account. Existing OpenAI credentials are preserved separately but are not used in Google mode. There is no automatic fallback to OpenAI.

## Accounts and access

Sign in before using ResolveAI. The initial setup creates the single administrator account; existing accounts and the protected Gemini key survive updates. In **Users**, the administrator creates Technician or Customer accounts. Share each account's credentials privately with its owner.

| Role | Access |
| --- | --- |
| Admin | All incidents and calls, user creation, incident assignment, and the shared Gemini/LiveKit configuration. |
| Technician | All incidents and incident QA/analytics, their assigned calls, available incoming call previews, and knowledge. |
| Customer | My support, their own incidents and calls, self-service incident creation, comments, and knowledge browsing. No QA or analytics. |

One server-side Google connection powers all users: Vertex AI uses ADC locally and a service identity on GCP, or Google AI can use a shared Gemini key. Only the administrator can configure it; the key is never sent to technicians or customers. Comments automatically use the signed-in account's name and role. Customers do not enter these manually.

Self-service incidents enter **New** and appear for the administrator to assign through the ticket's **Assigned to** dropdown. A technician can then progress and resolve the incident. Existing name-only assignments migrate when they uniquely match a staff account; unmatched old incidents remain available to the administrator for assignment.

**Calling and team routing:** Customers sign in and select **My support → Call support**. Technicians open **Calls & queue**, choose **Enable calls**, and set **Available**. Any available technician can answer an incoming call; the first successful pickup owns the call and its incident. Other technicians see minimal incoming queue previews until answering. All staff can open the linked incident and its saved transcript. Customers never appear as available call takers. See [CALLING_SETUP.md](CALLING_SETUP.md) for activation and GCP deployment instructions.

## Included product flows

- Overview dashboard with support metrics and issue trends.
- Live technician workspace with conversation, AI reasoning, knowledge, and ticket context.
- Audio upload and browser recording through Gemini.
- Free-form transcript analysis with Gemini structured outputs.
- Structured ticket generation with field-level confidence.
- Evidence-based ticket QA and human acceptance of recommendations.
- ServiceNow-style incident states: New, In Progress, On Hold, and Resolved.
- Editable incident fields, including short description, description, classification, priority, assignment, and state.
- Technician work notes and customer comments once an incident is In Progress.
- Automatic Activity history for every saved ticket-field change, including previous and new values.
- Resolution notes and AI QA only after the incident is moved to Resolved.
- A Resolution Notes panel beside Activity that resolves the ticket and runs QA in one step.
- Server-side background QA after resolution, so resolving returns immediately.
- A Quality Audit ticket list showing every resolved ticket as Pending or with its completed score.
- Ticket list, analytics, and a knowledge-gap insight.
- Google Gemini API locally and Vertex AI on GCP, with configurable model names.
- Persistent local SQLite storage, plus in-memory test and Cloud Firestore modes.
- Technician accounts, presence, language/skill matching, atomic call reservations, and wrap-up.
- LiveKit browser audio, customer call page, AI escalation, confirmed technician joins, and mute/end/transfer controls.
- Cloud Run container, source-deploy scripts, and Cloud Build configuration.

## Run locally

Python 3.11 or newer is recommended.

```bash
python -m venv .venv
source .venv/bin/activate        # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements-real.txt
uvicorn realapp.main:app --reload --port 8080
```

Open `http://localhost:8080`, sign in as the administrator (or complete first-time setup), choose **Configure key**, and enter your Gemini key if one is not already saved. Alternatively set `GEMINI_API_KEY` in the server environment. Defaults are `LLM_PROVIDER=google_ai`, `DATA_BACKEND=sqlite`, and `CALLING_BACKEND=sqlite`; local data survives restarts. Preserve the `data/` folder when updating the project.

Run tests:

```bash
pytest -q
```

## Deploy to Cloud Run

From this directory:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_LOCATION="us-central1"
./scripts/deploy-gcp.sh
```

On Windows PowerShell:

```powershell
.\scripts\deploy-gcp.ps1 -ProjectId "your-project-id"
```

Both scripts enable the required APIs and deploy with Google models, Firestore storage for incidents and accounts, and one continuously running instance for the current audio worker. Before deployment, create the Firestore Native database and grant the runtime service account `roles/aiplatform.user` and `roles/datastore.user`. Attach LiveKit credentials and a first-admin setup token through Secret Manager. See [GOOGLE_SETUP.md](GOOGLE_SETUP.md) and [CALLING_SETUP.md](CALLING_SETUP.md). Deployment files are prepared; configuring them does not itself deploy the application.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `google_ai` locally; `vertex` in deployment | Google API key or GCP service identity. |
| `GEMINI_API_KEY` | empty | Shared Google key for local development or API-key deployments. |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Analysis, routing, ticket generation, QA and knowledge drafting. |
| `GEMINI_TRANSCRIPTION_MODEL` | `gemini-3.8-flash` | Uploaded and live utterance transcription. |
| `GEMINI_TTS_MODEL` | `gemini-3.8-flash-lite-tts` | Spoken AI replies. |
| `GEMINI_VOICE` | `Kore` | Google voice. |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | Knowledge search vectors. |
| `GOOGLE_CLOUD_PROJECT` | empty | Required for Vertex AI and Firestore. |
| `GOOGLE_CLOUD_LOCATION` | `global` | Model endpoint, independent of Cloud Run region. |
| `DEPLOY_REGION` | `asia-south1` | Cloud Run deployment region. |
| `DATA_BACKEND`, `CALLING_BACKEND` | `sqlite` locally; `firestore` in deployment | Persistent records and accounts. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | empty | LiveKit calling connection. |
| `PUBLIC_BASE_URL` | empty | Public ResolveAI HTTPS origin. |

## Repository map

```text
realapp/
  main.py                 FastAPI routes, key setup, and audio upload
  config.py               Provider and model configuration
  engine.py               Optional legacy OpenAI adapter
  gemini.py               Google AI / Vertex AI text, embeddings, transcription and TTS
  models.py               Structured case, ticket, and QA schemas
  knowledge.py            Knowledge repository and retrieval text
  store.py                Memory and Firestore stores
  static/                 Responsive product UI
docs/ARCHITECTURE.md       GCP topology and extension points
scripts/                   GCP deployment and secret setup
tests/                     Engine and API tests
Dockerfile                 Cloud Run container
cloudbuild.yaml            Optional Cloud Build pipeline
```

## Deliberate MVP boundaries

The interface supports live LiveKit browser calls, audio uploads, and browser microphone recording. Ordinary phone-number/SIP inbound calls, identity-changing actions, and writes to an external ITSM are not implemented. Those integrations need the target systems, security model, and API credentials.

All model names are configurable through the settings above.

## Knowledge from incidents

In Knowledge, select **Create from incidents** and enter up to 20 incident numbers separated by commas, spaces, semicolons, or new lines. The configured model drafts one editable article from current ticket fields, technician/customer comments, resolution notes, and the saved intake/call transcripts. Unresolved sources are flagged for review. Review the fields and select **Add to knowledge** to save; generation alone does not publish an article. Saved articles retain links to their source incidents.

Both background and manual quality audits exclude automatic System activity from work notes. Technician and customer comments remain available to the auditor alongside ticket fields and transcript evidence. The original activity history remains on the incident. Existing audit scores can be refreshed with **Rerun AI QA**.

QA treats Category / Subcategory as one classification check. State, ID, Call ID, and Assigned to are excluded from auditing and scoring. Ticket number and Call ID appear as reference details at the top of the audit. Older saved checks are combined/filtered for display; rerun QA to recalculate an older score under the current rules.

## Rerun all quality audits

Staff can select **Quality audit → Rerun all audits** to audit every currently resolved ticket in the background. The page reports completed, failed, and skipped records. Duplicate clicks share the active batch, failures do not stop other tickets, and concurrent ticket edits are preserved. Customers cannot start or inspect batches. Batch progress is held in memory for the single application worker; restarting the server ends an unfinished batch, which can be rerun.

## Call preferences and completed incidents

Staff accounts retain **Enable calls** and **Availability** across refreshes and sign-ins. Available is the initial preference; completing, declining, or timing out a call restores the saved preference. Routing still requires a recent heartbeat and, for browser calls, microphone readiness. Granted microphone permission is checked again automatically after refresh. Disabled calls and Away/Offline preferences remain unchanged until the user changes them.

The Calls page places call activity above the full-width conversation and displays its incident underneath, with an **Edit incident** link. New browser calls keep routing analysis as a draft until the call ends; the incident is generated from the completed transcript and starts with blank resolution notes. A provider failure retains the conversation in a fallback incident. Retries use the same incident ID and preserve subsequent edits. An empty call creates no incident. AI-confirmed resolutions are applied after incident creation and trigger the existing background QA workflow. Existing incidents and manually routed desk requests retain their current workflow.
