#!/usr/bin/env bash
# Run from the uploaded ResolveAI project in authenticated Google Cloud Shell.
set -euo pipefail
set +x
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-project-3b78e0f3-2562-4233-a7f}"
REGION="${DEPLOY_REGION:-asia-south1}"
SERVICE="resolveai"
LIVEKIT_URL="${LIVEKIT_URL:-wss://reolveai-lfu9ponl.livekit.cloud}"
ATTACHMENT_BUCKET="${ATTACHMENT_BUCKET:-}"
RUNTIME_ACCOUNT="resolveai-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_ACCOUNT="resolveai-builder@${PROJECT_ID}.iam.gserviceaccount.com"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == '--plan' ]]; then
  printf 'Project: %s\nRegion: %s\nService: %s\n' "$PROJECT_ID" "$REGION" "$SERVICE"
  printf '%s\n' 'Creates/reuses Firestore, dedicated service accounts, and protected secrets.'
  printf '%s\n' 'Deploys Gemini through Vertex AI, LiveKit Cloud, and one always-on Cloud Run instance.'
  printf '%s\n' 'Existing local records and credentials are not uploaded. Cloud records are preserved on reruns.'
  printf 'Attachment bucket: %s\n' "${ATTACHMENT_BUCKET:-not configured}"
  exit 0
fi

command -v gcloud >/dev/null || { echo 'Run this script in Google Cloud Shell.' >&2; exit 1; }
command -v python3 >/dev/null
test -f Dockerfile && test -f realapp/main.py
test -n "$(gcloud auth list --filter=status:ACTIVE --format='value(account)')" || {
  echo 'Sign in to Google Cloud Shell first.' >&2; exit 1;
}
printf 'Preparing %s in %s. This deployment runs one continuously billed instance.\n' "$SERVICE" "$REGION"
gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com secretmanager.googleapis.com aiplatform.googleapis.com speech.googleapis.com storage.googleapis.com iam.googleapis.com \
  cloudresourcemanager.googleapis.com --project="$PROJECT_ID" --quiet

DATABASE_TYPE="$(gcloud firestore databases list --project="$PROJECT_ID" --format=json | python3 -c \
  'import json,sys; print(next((d.get("type", "") for d in json.load(sys.stdin) if d["name"].endswith("/(default)")), ""))')"
if [[ -z "$DATABASE_TYPE" ]]; then
  gcloud firestore databases create --database='(default)' --location="$REGION" \
    --type=firestore-native --project="$PROJECT_ID" --quiet
elif [[ "$DATABASE_TYPE" != 'FIRESTORE_NATIVE' ]]; then
  echo 'The default database is not Firestore Native. No database was changed.' >&2
  exit 1
fi

for NAME in resolveai-runtime resolveai-builder; do
  if ! gcloud iam service-accounts describe "${NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
      --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$NAME" --display-name="$NAME" --project="$PROJECT_ID" --quiet
  fi
done
for ROLE in roles/aiplatform.user roles/datastore.user roles/speech.client; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$RUNTIME_ACCOUNT" \
    --role="$ROLE" --condition=None --quiet >/dev/null
done
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$BUILD_ACCOUNT" \
  --role=roles/run.builder --condition=None --quiet >/dev/null

ensure_secret() {
  local name="$1" label="$2" value='' version=''
  if ! gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic --project="$PROJECT_ID" --quiet
  fi
  version="$(gcloud secrets versions list "$name" --project="$PROJECT_ID" \
    --filter=state:ENABLED --sort-by='~createTime' --limit=1 --format='value(name)')"
  if [[ -z "$version" ]]; then
    if [[ "$name" == resolveai-admin-setup ]]; then
      value="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
    else
      read -r -s -p "Enter $label (hidden): " value
      printf '\n'
      if [[ -z "$value" ]]; then echo "$label is required." >&2; exit 1; fi
    fi
    version="$(printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- \
      --project="$PROJECT_ID" --format='value(name)' --quiet)"
    unset value
  fi
  gcloud secrets add-iam-policy-binding "$name" --project="$PROJECT_ID" \
    --member="serviceAccount:$RUNTIME_ACCOUNT" --role=roles/secretmanager.secretAccessor \
    --condition=None --quiet >/dev/null
  SECRET_VERSION="${version##*/}"
  [[ "$SECRET_VERSION" =~ ^[0-9]+$ ]] || { echo "Could not resolve the version of $name." >&2; exit 1; }
}

ensure_secret resolveai-livekit-key 'LiveKit API key'
KEY_VERSION="$SECRET_VERSION"
ensure_secret resolveai-livekit-secret 'LiveKit API secret'
LIVEKIT_SECRET_VERSION="$SECRET_VERSION"
ensure_secret resolveai-admin-setup 'administrator setup token'
ADMIN_VERSION="$SECRET_VERSION"

DEPLOY_ENV="ENVIRONMENT=production,LLM_PROVIDER=vertex,GEMINI_PROVIDER=vertex,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=global,LIVE_TRANSCRIPTION_BACKEND=auto,SPEECH_MODEL=chirp_3,SPEECH_LOCATION=${SPEECH_LOCATION:-us},SPEECH_LANGUAGE=${SPEECH_LANGUAGE:-en-IN},GEMINI_MODEL=gemini-3.8-flash,GEMINI_TRANSCRIPTION_MODEL=gemini-3.8-flash,GEMINI_TTS_MODEL=gemini-3.8-flash-lite-tts,EMBEDDING_MODEL=gemini-embedding-001,DATA_BACKEND=firestore,CALLING_BACKEND=firestore,FIRESTORE_COLLECTION=resolveai_cases,LIVEKIT_URL=$LIVEKIT_URL"
if [[ -n "$ATTACHMENT_BUCKET" ]]; then
  gcloud storage buckets add-iam-policy-binding "gs://$ATTACHMENT_BUCKET" \
    --member="serviceAccount:$RUNTIME_ACCOUNT" --role=roles/storage.objectUser --project="$PROJECT_ID" --quiet
  DEPLOY_ENV="$DEPLOY_ENV,ATTACHMENT_BUCKET=$ATTACHMENT_BUCKET"
fi

gcloud run deploy "$SERVICE" --source . --project="$PROJECT_ID" --region="$REGION" \
  --build-service-account="projects/$PROJECT_ID/serviceAccounts/$BUILD_ACCOUNT" \
  --service-account="$RUNTIME_ACCOUNT" --allow-unauthenticated --port=8080 \
  --cpu=1 --memory=1Gi --min=1 --max=1 --no-cpu-throttling --timeout=3600 \
  --update-env-vars="$DEPLOY_ENV" \
  --update-secrets="LIVEKIT_API_KEY=resolveai-livekit-key:$KEY_VERSION,LIVEKIT_API_SECRET=resolveai-livekit-secret:$LIVEKIT_SECRET_VERSION,ADMIN_SETUP_TOKEN=resolveai-admin-setup:$ADMIN_VERSION" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
[[ "$URL" == https://* ]] || { echo 'Deployment did not return an HTTPS address.' >&2; exit 1; }
gcloud run services update "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --update-env-vars="PUBLIC_BASE_URL=$URL" --quiet
curl --fail --silent --show-error "$URL/api/health"
printf '\nResolveAI website: %s\nCustomer calls: %s/support\n' "$URL" "$URL"
printf '%s\n' 'Create the first admin on the website. Retrieve its setup token privately with:'
printf 'gcloud secrets versions access %s --secret=resolveai-admin-setup --project=%s\n' "$ADMIN_VERSION" "$PROJECT_ID"
printf '%s\n' 'Paste that token only into the website setup form. Do not share it in chat.'
printf '%s\n' 'A health check does not verify Gemini model access. Test an incident and call after setup.'
