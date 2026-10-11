import os

os.environ["LLM_PROVIDER"] = "mock"
os.environ["DATA_BACKEND"] = "memory"
os.environ["GEMINI_PROVIDER"] = "mock"
os.environ["FALLBACK_TO_MOCK"] = "false"
os.environ["ENABLE_DEMO_DATA"] = "true"
os.environ["CALLING_BACKEND"] = "memory"


def signed_in_admin(client):
    credentials = {'name':'Test Admin','username':'suite_admin','password':'isolated-suite-password'}
    path = '/api/auth/setup' if client.get('/api/auth/status').json()['setup_required'] else '/api/auth/login'
    assert client.post(path,json=credentials).status_code in {200,201}
    return client
