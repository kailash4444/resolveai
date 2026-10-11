# ResolveAI calling with LiveKit

ResolveAI uses LiveKit for real browser audio between customers, the AI assistant, and technicians. Browser calls do not need a telephone number. The application can use a local LiveKit server or LiveKit Cloud.

## Run locally on Windows

1. Run `./run-local-real.ps1 -Install`. It installs application dependencies, prepares a local LiveKit connection, downloads the official LiveKit server v1.13.9 after verifying its SHA-256 checksum, starts it in the background, and starts ResolveAI.
2. Open `http://127.0.0.1:8080/?view=calls`. Create the administrator account if needed, or sign in with your existing account.
3. In **Users**, create technician and customer accounts. Sign in as a technician, choose **Enable calls**, grant microphone permission, and select **Available**.
4. Open `http://127.0.0.1:8080/support` in another browser/profile. Sign in as a customer and choose **Call support**; the name comes from that account. Use headphones when demonstrating both participants on the same computer.
5. Describe the issue. The AI transcribes the conversation and creates an incident. Safe requests with matching knowledge can stay with AI; other requests enter the technician queue. Customers can choose **Ask for a technician** at any time.
6. Any available technician chooses **Answer** in the incoming queue (or **Accept** on their offered call). Only one technician can claim it. Once their browser joins the customer's room, the incident is assigned and moves to **In Progress**. Both can speak, mute, and end the call.

If ResolveAI is already running, `./start-livekit-local.ps1` starts only LiveKit. Pass `-PythonPath` when using a different virtual environment. An external LiveKit configuration is respected by the launcher. The local server uses ports 7880 (signaling/API), 7881 (TCP media), and 7882 (UDP media), bound to loopback. This configuration is for calls on this computer. It is not a public phone service.

The local server's process ID is recorded in `data/livekit-runtime/server.pid`. Its executable, checksum-verified download, logs, and configuration stay under `data/`, which is excluded from the project archive, Git, Docker, and Cloud Build uploads. The Windows server may log that CPU capacity monitoring is unsupported; local audio still works. Use Linux or LiveKit Cloud for production.

## Use LiveKit Cloud for callers on other devices

1. Create a project in [LiveKit Cloud](https://cloud.livekit.io/).
2. On the local administrator website, open **Calls & queue → Manage LiveKit**. Enter the project's `wss://` URL, API key, and API secret. **Verify and save connection** validates them against the LiveKit API.
3. Give ResolveAI itself a public HTTPS address, for example through an HTTPS tunnel or its later GCP deployment. Set `PUBLIC_BASE_URL` to that origin when needed for origin validation.
4. Share `https://YOUR-RESOLVEAI-HOST/support`. Customer and technician browsers connect directly to LiveKit for audio; ResolveAI processes the audio as a participant in each call.

The local app must remain running while using LiveKit Cloud. No external callback URL or public media port on the local app is needed for this browser workflow. Browser microphone access requires HTTPS except on localhost. LiveKit Cloud usage is subject to its current [free allowances and limits](https://docs.livekit.io/deploy/admin/quotas-and-limits/).

## Credentials and persistence

| Setting | Purpose |
| --- | --- |
| `LIVEKIT_URL` | `ws://127.0.0.1:7880` locally, or a LiveKit Cloud `wss://` URL |
| `LIVEKIT_API_KEY` | Server API key |
| `LIVEKIT_API_SECRET` | Server signing secret; never returned to the browser |
| `PUBLIC_BASE_URL` | ResolveAI's public HTTPS origin when shared remotely |
| `LIVEKIT_MAX_CALLS` | Maximum concurrent browser calls; default 5 |
| `LIVEKIT_MAX_CALL_SECONDS` | Maximum duration; default 1800 seconds |
| `GEMINI_MODEL` | `gemini-3.8-flash` |
| `GEMINI_TRANSCRIPTION_MODEL` | `gemini-3.8-flash` |
| `GEMINI_TTS_MODEL` | `gemini-3.8-flash-lite-tts` |
| `GEMINI_VOICE` | `Kore` |

The shared Gemini key is protected separately in the Windows profile. Previously saved OpenAI credentials remain unchanged and are unused in Google mode. LiveKit credentials are stored separately in `%LOCALAPPDATA%/ResolveAI/livekit.dpapi`. A local server also needs its generated key in `data/local-livekit.yaml`; keep this file private. It is excluded from distributable artifacts. Cloud credentials entered through the website are stored in the protected profile only. Setting any LiveKit environment credential uses the complete environment configuration instead of mixing it with a saved identity.

Only a signed-in administrator on localhost can change credentials through the website. Finish active calls before changing the connection. In production, configure credentials as environment secrets. Tickets and knowledge remain in `data/resolveai.sqlite3`; accounts, sessions, and calls remain in `data/calling.sqlite3`. Builds and tests must preserve these files.

## Call behavior

- Customers must sign in and can access only their own calls and incidents. Call controls also require an unguessable call token. Customers have read-only incident fields and can comment once the incident is In Progress. The technician directory, QA, and analytics are restricted to staff.
- The server issues short-lived, room-specific LiveKit tokens. Technician tokens initially cannot publish or subscribe to audio; media access is granted only for the current reserved offer after the server verifies room membership.
- Audio is segmented at silence or 12 seconds and sent to the configured transcription API. The transcript updates after each utterance. Speaker labels distinguish customer, AI, and technician. Raw audio is not saved by the application.
- AI gives brief knowledge-based guidance. It does not reset accounts or execute device changes. Human requests, identity/security actions, low confidence, missing knowledge, and model failures escalate to technicians.
- Routing matches language and service skills, then chooses the longest-idle eligible technician. A technician must be Available, have microphone permission, and send current heartbeats. Each technician handles one call/request at a time.
- Declined and expired offers are requeued. Technicians whose offers expire become Away. Transfers revoke the departing technician's audio access before requeueing. A disconnected technician is requeued after an eight-second grace period.
- Ending a call moves its technician to Wrap-up. Select Available when ready for another call. Ending a call does not resolve the incident.
- Incidents start without resolution notes. Technicians can edit their assigned incidents; only the administrator can reassign an incident to another account. Only an explicit resolution triggers the existing background QA. An AI call resolves a ticket only after the customer explicitly confirms the issue is fixed.
- A customer who never joins is timed out after 45 seconds. A disconnected customer has a ten-second grace period. Waiting requests time out after five minutes and are retained for follow-up; automatic outbound callbacks are not implemented.
- The authenticated customer call endpoint is limited to five attempts per ten minutes per client IP, plus the concurrent-call limit. For public production use, add identity/abuse controls suited to your organization.

## Microphone checks during a call

Customer and technician call pages show **Your microphone**, an input level meter, and a **Speech detected** indicator based on captured audio. If the input stays silent, select the correct microphone or choose **Restart microphone** to capture and publish a fresh track without ending the call. A stopped or interrupted input is shown explicitly. Browser/OS microphone permissions and hardware mute still need to allow capture. Transcription updates after a pause in speech, rather than word by word.

The server detects quieter utterances relative to background silence and reports audio-worker/subscription failures on the call instead of silently stopping transcription.

## GCP deployment later

Use LiveKit Cloud (or a separate LiveKit server) for media. Do not run the LiveKit media server inside Cloud Run. Deploy ResolveAI using `Dockerfile.gcp` / `cloudbuild-real.yaml`, set `ENVIRONMENT=production`, `DATA_BACKEND=firestore`, `CALLING_BACKEND=firestore`, and configure `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `PUBLIC_BASE_URL`, and `LLM_PROVIDER=vertex`. Store secrets in Secret Manager. Grant the runtime service account `roles/aiplatform.user` for Google models, `roles/datastore.user` for Firestore, and access to the specific secrets it needs. First administrator setup on a public origin also requires `ADMIN_SETUP_TOKEN`.

This implementation keeps the audio worker in the web application process. Run one Uvicorn worker and one Cloud Run instance, with CPU allocated outside requests. The provided Cloud Build configuration sets minimum and maximum instances to one. A restart ends active audio sessions; tickets survive. Before scaling, move room workers to a separately dispatched LiveKit Agents deployment and use durable QA jobs. Hosting and AI model usage have their own costs.

## Scope and verification

The browser client uses LiveKit's dual peer connection mode. This waits for server connection settings before creating WebRTC peers and avoids a mid-startup `setConfiguration()` call that some embedded browsers reject. If an older page still shows that error, reload both the customer and technician tabs to load the updated calling client.

The completed integration supports browser-to-AI and browser-to-technician calls. Dialing an ordinary phone number is not connected by this implementation. LiveKit Cloud phone numbers can be added later with a SIP/inbound-agent integration.

Run `python -m pytest -q` for routing, authentication, scoped tokens, credential persistence, customer isolation, provider failure, confirmed room joins, audio segmentation, and ticket/QA regression checks. Browser acceptance checks use a real local LiveKit server with separate customer and technician sessions; model providers are replaced with deterministic test providers there to avoid API charges. Your production local app continues to use its configured AI models.

References: [LiveKit media publishing](https://docs.livekit.io/transport/media/publish/), [LiveKit media subscriptions](https://docs.livekit.io/transport/media/subscribe/), [LiveKit server](https://github.com/livekit/livekit), [LiveKit Cloud](https://docs.livekit.io/intro/cloud/).
