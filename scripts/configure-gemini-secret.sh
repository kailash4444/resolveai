#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT before running this script.}"
REGION="${DEPLOY_REGION:-asia-south1}"
SERVICE="${SERVICE_NAME:-resolveai}"
SECRET_NAME="${SECRET_NAME:-resolveai-gemini-api-key}"

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "Set GEMINI_API_KEY in your current shell. It will be sent to Secret Manager through stdin." >&2
  exit 1
fi

if ! gcloud secrets describe "$SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets create "$SECRET_NAME" --replication-policy=automatic --project "$PROJECT_ID"
fi

printf '%s' "$GEMINI_API_KEY" | gcloud secrets versions add "$SECRET_NAME" --data-file=- --project "$PROJECT_ID"
gcloud run services update "$SERVICE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --update-secrets "GEMINI_API_KEY=$SECRET_NAME:latest" \
  --update-env-vars "LLM_PROVIDER=google_ai,GEMINI_PROVIDER=google_ai"

echo "Gemini secret attached to $SERVICE."
