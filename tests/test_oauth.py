"""Log in with Google / Microsoft. The providers' token endpoints are replaced with a stub that returns an ID token."""
import base64
import json
import time
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from realapp import oauth
from test_calling import webapp  # noqa: F401  (fixture)


def _id_token(claims):
    part = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=').decode()
    return f"{part({'alg': 'RS256'})}.{part(claims)}.signature"


@pytest.fixture
def signin(webapp, monkeypatch):
    app, service = webapp
    settings = service.settings
    settings.google_client_id, settings.google_client_secret = 'google-client', 'google-secret'
    settings.microsoft_client_id, settings.microsoft_client_secret = 'ms-client', 'ms-secret'
    admin = TestClient(app)
    admin.post('/api/auth/setup', json={'name': 'Admin', 'username': 'admin', 'password': 'test-admin-password'})
    admin.post('/api/users', json={'role': 'technician', 'name': 'Tara', 'username': 'tara', 'email': 'tara@company.com',
                                   'password': 'tara-password-1234', 'skills': ['general'], 'languages': ['en']})
    admin.post('/api/users', json={'role': 'customer', 'name': 'Casey', 'username': 'casey', 'email': 'casey@gmail.com',
                                   'password': 'casey-password-1234', 'skills': ['general'], 'languages': ['en']})
    sent = {}

    def fake_tokens(settings, provider, code, redirect_uri, verifier):
        sent.update(provider=provider, code=code, redirect_uri=redirect_uri, verifier=verifier)
        return {'id_token': _id_token(sent['claims'])}
    monkeypatch.setattr(oauth, 'fetch_tokens', fake_tokens)

    def run(provider, claims, side='customer', client=None, tamper=None):
        """Start a sign-in, have the provider 'return' with `claims`, and give back (client, final response)."""
        client = client or TestClient(app, follow_redirects=False)
        start = client.get(f'/api/auth/oauth/{provider}/start', params={'side': side})
        assert start.status_code == 303
        query = parse_qs(urlparse(start.headers['location']).query)
        nonce = query['nonce'][0]
        audience = 'google-client' if provider == 'google' else 'ms-client'
        sent['claims'] = {'aud': audience, 'exp': time.time() + 300, 'nonce': nonce, **claims(nonce)}
        params = {'state': query['state'][0], 'code': 'one-time-code'}
        if tamper:
            tamper(params, client)
        return client, client.get(f'/api/auth/oauth/{provider}/callback', params=params), query
    return app, service, run, sent


def google(email, verified=True, name='Casey Customer'):
    return lambda nonce: {'iss': 'https://accounts.google.com', 'email': email, 'email_verified': verified, 'name': name}


def microsoft(email, tenant=oauth.MICROSOFT_CONSUMER_TENANT, **extra):
    return lambda nonce: {'iss': f'https://login.microsoftonline.com/{tenant}/v2.0', 'tid': tenant, 'email': email, 'name': 'Mo', **extra}


def signed_in(client):
    return client.get('/api/auth/status').json()['user']


def test_buttons_only_show_for_providers_with_keys(webapp):
    app, service = webapp
    client = TestClient(app)
    assert client.get('/api/auth/status').json()['oauth'] == []
    assert client.get('/api/auth/oauth/google/start').status_code == 404
    service.settings.google_client_id, service.settings.google_client_secret = 'id', 'secret'
    assert client.get('/api/auth/status').json()['oauth'] == [{'id': 'google', 'label': 'Google'}]


def test_start_sends_the_person_to_google_with_pkce_and_a_browser_bound_state(signin):
    _, _, run, sent = signin
    client, response, query = run('google', google('casey@gmail.com'))
    assert query['client_id'] == ['google-client'] and query['code_challenge_method'] == ['S256'] and query['scope'] == ['openid email profile']
    assert query['redirect_uri'] == ['https://calls.example.test/api/auth/oauth/google/callback']
    assert sent['redirect_uri'] == query['redirect_uri'][0] and sent['verifier']


def test_an_existing_customer_logs_in_with_google(signin):
    _, service, run, _ = signin
    before = len(service.snapshot()['technicians'])
    client, response, _ = run('google', google('Casey@Gmail.com'))
    assert response.status_code == 200 and 'location.replace("/portal")' in response.text
    assert 'resolveai_session' in response.cookies
    assert signed_in(client)['username'] == 'casey'
    assert len(service.snapshot()['technicians']) == before


def test_a_new_email_gets_a_customer_account(signin):
    _, _, run, _ = signin
    client, response, _ = run('google', google('new.person@gmail.com', name='New Person'))
    account = signed_in(client)
    assert account['role'] == 'customer' and account['email'] == 'new.person@gmail.com' and account['name'] == 'New Person'


def test_staff_log_in_on_the_technician_side_and_are_never_created(signin):
    _, _, run, _ = signin
    client, response, _ = run('google', google('tara@company.com'), side='technician')
    assert 'location.replace("/console")' in response.text and signed_in(client)['username'] == 'tara'
    # A customer email on the technician side, or an unknown one, gets the same refusal as a wrong password.
    for email in ('casey@gmail.com', 'stranger@gmail.com'):
        client, response, _ = run('google', google(email), side='technician')
        assert response.status_code == 303 and response.headers['location'] == '/login?as=staff&oauth_error=no_account'
        assert signed_in(client) is None
    # A staff email on the customer side doesn't log in as staff either.
    client, response, _ = run('google', google('tara@company.com'))
    assert response.headers['location'] == '/login?oauth_error=no_account' and signed_in(client) is None


def test_unverified_emails_are_refused(signin):
    _, _, run, _ = signin
    _, response, _ = run('google', google('casey@gmail.com', verified=False))
    assert response.headers['location'] == '/login?oauth_error=unverified'
    # A work account from an organisation this server doesn't know could carry anyone's email.
    _, response, _ = run('microsoft', microsoft('casey@gmail.com', tenant='11111111-2222-3333-4444-555555555555'))
    assert response.headers['location'] == '/login?oauth_error=unverified'
    # ...unless Microsoft confirms the email domain belongs to that organisation.
    client, response, _ = run('microsoft', microsoft('casey@gmail.com', tenant='11111111-2222-3333-4444-555555555555', xms_edov=True))
    assert signed_in(client)['username'] == 'casey'


def test_personal_microsoft_accounts_log_in(signin):
    _, _, run, _ = signin
    client, response, _ = run('microsoft', microsoft('mo@outlook.com'))
    assert signed_in(client)['email'] == 'mo@outlook.com'


def test_tampered_or_replayed_returns_are_refused(signin):
    app, _, run, _ = signin
    # Another browser (no state cookie) can't finish someone else's sign-in.
    def other_browser(params, client):
        client.cookies.clear()
    _, response, _ = run('google', google('casey@gmail.com'), tamper=other_browser)
    assert response.headers['location'] == '/login?oauth_error=expired'
    # A wrong nonce in the ID token is refused.
    _, response, _ = run('google', lambda nonce: {**google('casey@gmail.com')(nonce), 'nonce': 'other'})
    assert response.headers['location'] == '/login?oauth_error=failed'
    # The same return can't be used twice.
    client, first, query = run('google', google('casey@gmail.com'))
    replay = client.get('/api/auth/oauth/google/callback', params={'state': query['state'][0], 'code': 'one-time-code'})
    assert replay.headers['location'] == '/login?oauth_error=expired'
    # Pressing Cancel at Google comes back with an error, not a code.
    client = TestClient(app, follow_redirects=False)
    start = client.get('/api/auth/oauth/google/start')
    state = parse_qs(urlparse(start.headers['location']).query)['state'][0]
    assert client.get('/api/auth/oauth/google/callback', params={'state': state, 'error': 'access_denied'}).headers['location'] == '/login?oauth_error=cancelled'


def test_new_accounts_follow_the_sign_up_switch(signin):
    _, service, run, _ = signin
    service.settings.allow_customer_signup = False
    _, response, _ = run('google', google('another@gmail.com'))
    assert response.headers['location'] == '/login?oauth_error=signup_off'
    client, response, _ = run('google', google('casey@gmail.com'))
    assert signed_in(client)['username'] == 'casey'


def test_a_sign_in_started_on_localhost_moves_to_127_0_0_1(webapp):
    app, service = webapp
    service.settings.public_base_url = ''
    service.settings.google_client_id, service.settings.google_client_secret = 'google-client', 'google-secret'
    client = TestClient(app, base_url='http://localhost:8095', follow_redirects=False)
    response = client.get('/api/auth/oauth/google/start', params={'side': 'customer'})
    assert response.status_code == 303 and response.headers['location'] == 'http://127.0.0.1:8095/api/auth/oauth/google/start?side=customer'
