param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [string]$Region = "asia-south1",
  [string]$Service = "resolveai",
  [ValidateSet("openai", "mock", "google_ai", "vertex")][string]$LlmProvider = "vertex",
  [string]$LlmModel = "gemini-3.8-flash",
  [string]$TranscriptionModel = "gemini-3.8-flash",
  [ValidateSet("memory", "firestore")][string]$DataBackend = "firestore",
  [string]$AttachmentBucket = ""
)

$ErrorActionPreference = "Stop"
gcloud config set project $ProjectId
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com aiplatform.googleapis.com firestore.googleapis.com storage.googleapis.com
$envVars = "ENVIRONMENT=production,LLM_PROVIDER=$LlmProvider,GEMINI_PROVIDER=$LlmProvider,GEMINI_MODEL=$LlmModel,GEMINI_TRANSCRIPTION_MODEL=$TranscriptionModel,GEMINI_TTS_MODEL=gemini-3.8-flash-lite-tts,EMBEDDING_MODEL=gemini-embedding-001,DATA_BACKEND=$DataBackend,CALLING_BACKEND=$DataBackend,GOOGLE_CLOUD_PROJECT=$ProjectId,GOOGLE_CLOUD_LOCATION=global"
if ($AttachmentBucket) { $envVars += ",ATTACHMENT_BUCKET=$AttachmentBucket" }
gcloud run deploy $Service --source . --region $Region --allow-unauthenticated --port 8080 --memory 1Gi --cpu 1 --min 1 --max 1 --no-cpu-throttling --timeout 3600 --update-env-vars $envVars
Write-Host "ResolveAI deployed. The Cloud Run URL is printed above."
