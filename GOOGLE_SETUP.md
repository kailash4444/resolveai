# Google Gemini setup

ResolveAI uses the Google Gen AI SDK for all AI operations. LiveKit Cloud remains the audio transport. No OpenAI calls are made with `LLM_PROVIDER=google_ai` or `vertex`.

## Local development

1. Obtain a Gemini API key from https://aistudio.google.com/apikey for your Google project.
2. Sign in to ResolveAI as the administrator and select **Configure key**.
3. Save the Gemini key. All accounts use the same server-side credential.

The key is stored using Windows DPAPI in `%LOCALAPPDATA%/ResolveAI/gemini_api_key.dpapi`. It is excluded from source files, tests, archives, browser storage and Firestore. You can instead set `GEMINI_API_KEY` in the server environment. Credentials must have access and quota for the configured text, embedding and TTS models; saving a key alone does not verify all model permissions.

Defaults are `gemini-3.8-flash` for text and transcription, `gemini-embedding-001` for search, and `gemini-3.8-flash-lite-tts` with the Kore voice. Gemini's WAV replies are decoded into 24 kHz mono PCM for LiveKit. Audio is transcribed per utterance after a pause; supported uploads are WAV, MP3, WebM, OGG, FLAC, M4A, MP4 and AAC, up to 14 MB for inline requests.

## Deploy from Cloud Shell

Upload `ResolveAI_GCP_Platform.zip` using Cloud Shell's Upload file menu, then run:

```bash
unzip -o ResolveAI_GCP_Platform.zip -d resolveai-cloud
cd resolveai-cloud/resolveai-platform
bash scripts/deploy-cloud-shell.sh
```

The script targets `project-3b78e0f3-2562-4233-a7f` in Mumbai (`asia-south1`). It creates/reuses a Firestore Native database, dedicated build and runtime service accounts, and Secret Manager entries for LiveKit and first-admin setup. LiveKit key entry is hidden and sent through standard input to Secret Manager. Google models use the runtime identity. It deploys one always-on Cloud Run instance, which incurs ongoing charges. The package excludes local databases and credentials; local records are not migrated by this command. Existing cloud records are preserved on reruns.

After deployment, the script prints the website address and a command to retrieve the first-admin setup token. Use that token only in ResolveAI's first-account setup form. Test incident analysis and a browser call to verify model access and audio. A successful health check alone does not validate Google model access.

The source package and script are prepared and checked locally; actual cloud deployment must be run from the authenticated Cloud Shell session. `bash scripts/deploy-cloud-shell.sh --plan` prints a summary without changing cloud resources.

## GCP service identity

For project `project-3b78e0f3-2562-4233-a7f`, configure:

```text
LLM_PROVIDER=vertex
GEMINI_PROVIDER=vertex
GOOGLE_CLOUD_PROJECT=project-3b78e0f3-2562-4233-a7f
GOOGLE_CLOUD_LOCATION=global
GEMINI_MODEL=gemini-3.8-flash
GEMINI_TRANSCRIPTION_MODEL=gemini-3.8-flash
GEMINI_TTS_MODEL=gemini-3.8-flash-lite-tts
EMBEDDING_MODEL=gemini-embedding-001
DATA_BACKEND=firestore
CALLING_BACKEND=firestore
ENVIRONMENT=production
```

Enable `aiplatform.googleapis.com` and grant the Cloud Run runtime service account `roles/aiplatform.user`. Cloud Run supplies its credentials automatically; no Gemini key or downloadable service-account JSON key is needed. Firestore and deployment permissions are additional requirements. Keep LiveKit credentials in Secret Manager. Use the supplied deployment files after those prerequisites are configured. The existing call worker needs one instance with CPU outside requests.

For local Vertex development, install the Google Cloud CLI and run `gcloud auth application-default login`, then set the project and provider above. Do not confuse this with merely being signed in to the GCP website. Alternatively, local Gemini key entry is available without installing the CLI.

## Verification

The provider unit tests cover structured analysis/QA, per-document embeddings, upload transcription, WAV-to-PCM speech playback, admin-only shared key entry and isolated protected storage. Browser tests use actual local LiveKit audio with deterministic Google API responses. Real Google model access requires credentials and must be verified separately; the current setup has not made a successful live Google model request.

References: https://ai.google.dev/gemini-api/docs/models , https://ai.google.dev/gemini-api/docs/generate-content/audio , https://ai.google.dev/gemini-api/docs/generate-content/speech-generation , https://docs.cloud.google.com/vertex-ai/generative-ai/docs/speech/text-to-speech
