# ResolveAI architecture

## Runtime topology

```text
Browser
  |
  | HTTPS
  v
Cloud Run: ResolveAI FastAPI service
  |-- Static technician and manager UI
  |-- Conversation analysis API
  |-- Routing policy
  |-- Ticket and QA workflow
  |
  +--> Gemini on Vertex AI (recommended for GCP-native auth)
  |      or Gemini Developer API (API key in Secret Manager)
  |
  +--> Cloud Firestore (optional durable case state)
  |
  +--> Cloud Logging / Error Reporting
```

## Operating modes

| Mode | Configuration | Purpose |
|---|---|---|
| Local demo | `GEMINI_PROVIDER=mock`, `STORE_MODE=memory` | Runs without credentials and produces deterministic scenarios. |
| Google AI | `GEMINI_PROVIDER=google_ai`, Secret Manager supplies `GEMINI_API_KEY` | Uses the Gemini Developer API. |
| Vertex AI | `GEMINI_PROVIDER=vertex`, Cloud Run service account has Vertex AI permissions | Keeps authentication and billing within the GCP project. |
| Durable storage | `STORE_MODE=firestore` | Saves cases in the configured Firestore collection. |

## Current request flow

1. The browser submits a scenario or transcript.
2. The AI engine extracts service, problem, symptoms, attempted actions, scope, impact, and urgency.
3. A policy-constrained routing decision selects AI or human handling.
4. Knowledge articles are retrieved and included in the recommendation.
5. The same case state produces a structured ticket with field-level confidence.
6. Independent QA checks ticket fields against evidence from the conversation.
7. A human can accept a recommendation; the decision is preserved with the case.

## Production extensions

- Replace browser speech recognition with streaming Gemini Live or Cloud Speech-to-Text.
- Replace seeded knowledge matching with Gemini embeddings and Vertex AI Vector Search or a Firestore vector index.
- Stream closed-case facts to BigQuery for large-scale operations reporting.
- Add Identity-Aware Proxy or Identity Platform for role-aware access.
- Add Pub/Sub events for ticket status changes and long-running integrations.
- Integrate ServiceNow, Jira Service Management, or another ITSM platform behind a dedicated adapter.

The application keeps these boundaries explicit so they can be added without rewriting the technician experience.
