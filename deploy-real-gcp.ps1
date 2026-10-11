param(
  [Parameter(Mandatory=$true)][string]$ProjectId,
  [string]$Region = "us-central1",
  [string]$Repository = "resolveai"
)

$ErrorActionPreference = "Stop"
gcloud config set project $ProjectId
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com firestore.googleapis.com secretmanager.googleapis.com

$existing = gcloud artifacts repositories describe $Repository --location $Region --format="value(name)" 2>$null
if (-not $existing) {
  gcloud artifacts repositories create $Repository --repository-format=docker --location=$Region
}

gcloud builds submit --config cloudbuild-real.yaml --substitutions="_REGION=$Region,_REPOSITORY=$Repository"
