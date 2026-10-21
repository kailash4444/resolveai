import os

os.environ["LLM_PROVIDER"] = "mock"
os.environ["DATA_BACKEND"] = "memory"
os.environ["GEMINI_PROVIDER"] = "mock"
os.environ["FALLBACK_TO_MOCK"] = "false"
os.environ["CALLING_BACKEND"] = "memory"
# Never let a developer's real keys in .env reach the test run (no network calls, no quota use).
for _name in ("GEMINI_API_KEY", "OPENAI_API_KEY", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
    os.environ[_name] = ""


def signed_in_admin(client):
    credentials = {'name':'Test Admin','username':'suite_admin','password':'isolated-suite-password'}
    path = '/api/auth/setup' if client.get('/api/auth/status').json()['setup_required'] else '/api/auth/login'
    assert client.post(path,json={**credentials,'expected_role':'technician'}).status_code in {200,201}
    return client
