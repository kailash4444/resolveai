# ResolveAI — OpenAI setup

ResolveAI currently uses three OpenAI model roles:

| Workload | Model |
|---|---|
| Conversation understanding, routing, ticket generation, and QA | `gpt-6-luna` |
| Uploaded files and browser-recorded audio | `gpt-4o-mini-transcribe` |
| Knowledge article retrieval | `text-embedding-3-small` |

The analysis and QA calls use the OpenAI Responses API with Pydantic Structured Outputs. Transcription uses the Audio Transcriptions API. The provider remains configurable so the workflow can switch back to Gemini or Vertex AI later.

## Use your key in the website

1. Start ResolveAI and open `http://127.0.0.1:8080`.
2. Select **Configure key** in the lower-left connection card.
3. Enter your existing OpenAI API key and select **Use this key**.

The key is sent to the FastAPI backend and protected with Windows Data Protection API in the current user's local profile. It is reused after builds, tests, and server restarts. It is not returned by any API, saved to browser storage, written to a project file, stored with cases, or included in downloadable archives. Website key entry and local persistence are disabled outside the local environment.

For a deployed service or regular local use, set `OPENAI_API_KEY` as a server environment variable or attach it from a secret manager. The website setup is intended for local development and short-lived testing. Only use the website setup over HTTPS outside localhost.

## Run locally

```powershell
.\run-local-real.ps1 -Install
```

You can also configure the key before starting:

```powershell
$env:OPENAI_API_KEY="your-existing-key"
.\run-local-real.ps1
```

Do not commit a real key to `.env.example`, source control, Docker images, or build arguments.

## Audio workflow

- **Audio recording:** choose an audio file and select **Transcribe file**.
- **Browser recording:** select **Record call**, allow microphone access, then select **Stop and transcribe**.
- The returned transcript is placed in the conversation field for review before analysis.
- Speaker labels can be added manually when the recording contains multiple speakers.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/config/openai-key` | Protect and save an OpenAI key in the local user profile |
| `POST` | `/api/transcribe` | Transcribe uploaded audio |
| `POST` | `/api/analyze` | Retrieve knowledge, analyze the transcript, and create a New incident without resolution data |
| `PATCH` | `/api/cases/{id}/ticket` | Edit incident fields and move through New, In Progress, On Hold, and Resolved |
| `POST` | `/api/cases/{id}/work-notes` | Add a technician work note or customer comment after work begins |
| `POST` | `/api/cases/{id}/qa` | Run or rerun QA after the incident is Resolved |
| `GET` | `/api/config` | Return model names and non-secret connection status |

## Switch to Google later

Set `LLM_PROVIDER=google_ai` for the Gemini Developer API or `LLM_PROVIDER=vertex` for Vertex AI. The existing Google adapter uses `GEMINI_MODEL`, `EMBEDDING_MODEL`, and the corresponding Google credentials. Audio transcription will need a Google Speech-to-Text or Gemini audio adapter before the OpenAI transcription endpoint can be removed.
