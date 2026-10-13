#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT before running this script.}"
REGION="${DEPLOY_REGION:-asia-south1}"
SERVICE="${SERVICE_NAME:-resolveai}"
PROVIDER="${LLM_PROVIDER:-vertex}"
MODEL="${GEMINI_MODEL:-gemini-3.8-flash}"
TRANSCRIPTION_MODEL="${GEMINI_TRANSCRIPTION_MODEL:-gemini-3.8-flash}"
STORE="${DATA_BACKEND:-firestore}"
ATTACHMENT_BUCKET="${ATTACHMENT_BUCKET:-}"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com aiplatform.googleapis.com firestore.googleapis.com storage.googleapis.com

ENV_VARS="ENVIRONMENT=production,LLM_PROVIDER=$PROVIDER,GEMINI_PROVIDER=$PROVIDER,GEMINI_MODEL=$MODEL,GEMINI_TRANSCRIPTION_MODEL=$TRANSCRIPTION_MODEL,GEMINI_TTS_MODEL=gemini-3.8-flash-lite-tts,EMBEDDING_MODEL=gemini-embedding-001,DATA_BACKEND=$STORE,CALLING_BACKEND=$STORE,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=global"
if [[ -n "$ATTACHMENT_BUCKET" ]]; then
  ENV_VARS="$ENV_VARS,ATTACHMENT_BUCKET=$ATTACHMENT_BUCKET"
fi

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --min 1 \
  --max 1 \
  --no-cpu-throttling \
  --timeout 3600 \
  --update-env-vars "$ENV_VARS"

echo "ResolveAI deployed. The Cloud Run URL is printed above."
