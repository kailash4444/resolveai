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
- Standard category, subcategory, service, and assignment-group choices with a custom-value option.
- Technician work notes and customer comments once an incident is In Progress.
- Automatic Activity history for every saved ticket-field change, including previous and new values.
- Resolution notes and AI QA only after the incident is moved to Resolved.
- A Resolution Notes panel beside Activity that resolves the ticket and runs QA in one step.
- Server-side background QA after resolution, so resolving returns immediately.
- A Quality Audit ticket list showing every resolved ticket as Pending or with its completed score.
- Ticket list, analytics, and a knowledge-gap insight.
- Resolution Debt Radar with recurring-incident clusters, cached durability assessments, explainable scores, investigation tracking, and editable internal engineering briefs.
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

Both scripts enable the required APIs and deploy with Google models, Firestore storage for incidents and accounts, and one continuously running instance for the current audio worker. To enable incident photo and video uploads, create a private Cloud Storage bucket and grant the Cloud Run service account `roles/storage.objectUser` on it, then pass its name as `ATTACHMENT_BUCKET` (or `-AttachmentBucket` in PowerShell). Before deployment, create the Firestore Native database and grant the runtime service account `roles/aiplatform.user` and `roles/datastore.user`. Attach LiveKit credentials and a first-admin setup token through Secret Manager. See [GOOGLE_SETUP.md](GOOGLE_SETUP.md) and [CALLING_SETUP.md](CALLING_SETUP.md). Deployment files are prepared; configuring them does not itself deploy the application.

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
| `ATTACHMENT_BUCKET` | empty | Required for photo/video uploads when using Firestore. Set it to a private Cloud Storage bucket and grant the Cloud Run service account object read/write access. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | empty | LiveKit calling connection. |
| `PUBLIC_BASE_URL` | empty | Public ResolveAI HTTPS origin. |

## Repository map

```text
realapp/
  main.py                 FastAPI routes, key setup, and audio upload
  resolution_radar.py    Durability analysis, incident clustering, and debt scoring
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

## Requested demonstration dataset

Run `python scripts/seed_demo.py --export-dir ..` from this project to add 20 technicians, 30 customers and 85 synthetic, named, diarized support calls with matching incidents to the local SQLite website. An administrator account must already exist. The importer preserves existing data and credentials, creates only missing demo records, and can be rerun without duplicating records or replacing edited incidents. New account passwords are generated individually and saved only in ignored `data/demo_account_logins.csv`.

For a judge-facing demo deployment, the landing page shows **Try the demo** automatically once the database has at least one administrator, technician, and customer account; no environment switch or extra demo accounts are needed. Demo entry opens a shared session for an existing account in the selected role. Use it on the demonstration deployment because admin entry grants visitors administrator access.

The export contains individual transcripts, a combined text file, an account roster without passwords, a call index and incident JSON. The requested counts are AD login 15, display 10, CrowdStrike-related blue screens 12, printing 13 (6 connections, 3 toner, 4 blank output), Citrix 8, Kronos 5, Dragon microphone 3, Gmail/Calendar 9, keyboard replacement 1, monitor replacement 1, and MFA 8. Every conversation starts with the requested service-desk greeting and records Technician/Customer roles, names, timestamps and a unique Call ID. Calls can be searched by ID, participant or issue. The incident detail page includes the conversation, and the administrator’s Users page lists both account roles. Pending approval/replacement examples remain On Hold; resolved examples have outcome notes. QA scores remain pending genuine audits. No live model routing or historical vendor outage is claimed for these synthetic records.

## Transcript access, public numbers and call analytics

The sidebar has one **Analytics** page with **Tickets** and **Calls** tabs. **Quality audit** has the same tabs: ticket audits retain resolved-ticket field checks, while call audits provide searchable conversations, six evidence-based scores, transcript details and the **Evaluate completed calls** background action.

**Transcripts** lists and downloads recorded conversations. Administrators see all; technicians see their assigned calls/intakes; customers see their own. Access is enforced by account IDs on the API. Technicians can still work on all incidents, while transcript bodies on other technicians’ incidents are omitted. Customer transcript responses omit quality assessments.

## Included application data

The private repository includes a restorable JSON snapshot in [`snapshots/current`](snapshots/current/README.md): users, incidents and activity, calls and transcripts, knowledge, saved quality assessments, and numbering metadata. Run `python scripts/snapshot_data.py restore` on a fresh checkout before starting the app. Restore requires an empty `data` directory and generates new local account passwords in ignored `data/restored_account_logins.csv`. Existing local data and credentials are never overwritten. API keys, cloud credentials, passwords/hashes and active sessions are excluded from Git. See the snapshot README for alternate locations and refresh instructions.

Public incident numbers use `INC0000001` (seven digits); knowledge numbers use `KB00001` (five digits). Memory locks, SQLite write transactions, and Firestore transactions allocate increasing numbers and preserve them during edits and restarts. Existing public numbers are migrated chronologically for incidents; internal case/call IDs, owners and assignments stay stable. Transcript references, activity text, knowledge matches and KB source-incident references are converted too. Counters and legacy mappings remain in database metadata. Re-export the demo pack with the importer to refresh its numbers.

**Call analytics** shows scoped call totals, completion rate, average duration and queue wait, volume by service/day, statuses, and technician performance. Its six conversation metrics are Greeting, Problem-solving ability, Empathy, Communication clarity, Verification, and Closure. Each uses a 0–100 score, explanation, exact transcript evidence and an improvement. Insufficient or unverifiable evidence is unscored and excluded from averages. Text assessments do not infer tone of voice, and appropriate escalation/approval waits are not treated as failed resolutions. New completed calls are assessed in the background; **Evaluate completed calls** refreshes existing calls visible to the current staff account. Results are retained on call records and invalidated if transcript text changes. Batch progress is per user and in memory; after restarting a worker, rerun an interrupted batch. Call conversation assessment is separate from incident-field QA, which still requires a resolved ticket. The configured Gemini/Vertex provider performs the live assessments.

### Low-latency browser calls

With Vertex/ADC, `LIVE_TRANSCRIPTION_BACKEND=auto` uses Google Speech-to-Text V2
`chirp_3` (`SPEECH_LOCATION=us`, `SPEECH_LANGUAGE=en-IN`). Audio is streamed as
speech arrives, with temporary live captions and finalized, speaker-labeled
transcripts stored for incidents/audits. Partial hypotheses are never audited.
Streams end at utterance boundaries and are capped at 12 seconds; they reconnect
for each new segment using the same client. Speech and AI response processing run
independently, and Gemini speech output plays incrementally.

Install `requirements-real.txt`, enable `speech.googleapis.com`, and grant
`roles/speech.client` to the Cloud Run runtime service account. The Cloud Shell
deployment script configures these. Use ADC locally; no additional API key is
required. `SPEECH_LOCATION` must support Chirp 3 streaming for the chosen language;
`us` was verified for this project, while `asia-southeast1` rejected `en-IN`.
Set `LIVE_TRANSCRIPTION_BACKEND=batch` to explicitly return to the configured
Gemini/OpenAI file-transcription path. Other providers use batch in `auto` mode.

Keep the voice worker on an always-allocated CPU with at least one warm instance.
The deployment scripts use one instance because active voice workers live in
process memory; do not scale this implementation across instances without shared
worker dispatch. These settings incur idle compute charges. Provider timings
(first speech audio, transcription, pickup confirmation) are logged without
transcript text or credentials. Uploaded audio transcription is unchanged.

### Conversation lists and navigation

Tickets, Transcripts, Knowledge, Resolution debt, and both ticket and call Quality audit lists show 10 records per page. Previous/Next controls work on the filtered results; changing a filter starts at page 1. Opening a transcript shows a dedicated detail page with the newest message first and a shareable `?transcript=...` URL. Back to transcripts retains the current filters and page during the session. Call activity displays elapsed days (including “Less than 1 day” for recent calls).

Answer gives immediate connection feedback and starts microphone capture alongside the call reservation. The server still confirms room membership and publishing permission before microphone audio is published.
