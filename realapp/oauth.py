"""Log in with Google or Microsoft (OAuth 2.0 authorization code flow with PKCE, OpenID Connect).

A provider is offered only when both its client ID and secret are set. The identity comes from the ID token the
provider returns straight to the server over TLS, in exchange for the one-time code plus our client secret, so its
signature isn't checked again here (OpenID Connect Core 3.1.3.7); its issuer, audience, expiry and nonce are.
Only an email the provider vouches for is used to find or create an account.
"""
import base64
import hashlib
import json
import secrets
import time
from urllib.parse import urlencode

import httpx

# Personal Microsoft accounts (outlook.com, hotmail.com, live.com) all sign in through this tenant.
MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'
GOOGLE_ISSUERS = {'https://accounts.google.com', 'accounts.google.com'}


class OAuthError(Exception):
    """Sign-in failed. `code` picks the message the log-in page shows (see auth.js)."""
    def __init__(self, code, detail=''):
        super().__init__(detail or code)
        self.code = code


def providers(settings):
    """Providers with keys set, in the order the buttons appear."""
    found = []
    if settings.google_client_id and settings.google_client_secret:
        found.append({'id': 'google', 'label': 'Google'})
    if settings.microsoft_client_id and settings.microsoft_client_secret:
        found.append({'id': 'microsoft', 'label': 'Microsoft'})
    return found


def _endpoints(settings, provider):
    if provider == 'google':
        return ('https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token',
                settings.google_client_id, settings.google_client_secret)
    tenant = settings.microsoft_tenant or 'common'
    base = f'https://login.microsoftonline.com/{tenant}/oauth2/v2.0'
    return f'{base}/authorize', f'{base}/token', settings.microsoft_client_id, settings.microsoft_client_secret


def new_request():
    """Single-use values for one sign-in attempt: state (ties the return to this browser), PKCE verifier, nonce."""
    return {'state': secrets.token_urlsafe(32), 'verifier': secrets.token_urlsafe(48), 'nonce': secrets.token_urlsafe(24)}


def authorize_url(settings, provider, redirect_uri, request):
    authorize, _, client_id, _ = _endpoints(settings, provider)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(request['verifier'].encode()).digest()).rstrip(b'=').decode()
    query = {'client_id': client_id, 'response_type': 'code', 'redirect_uri': redirect_uri, 'scope': 'openid email profile',
             'state': request['state'], 'nonce': request['nonce'], 'code_challenge': challenge, 'code_challenge_method': 'S256',
             'prompt': 'select_account'}
    return f'{authorize}?{urlencode(query)}'


def fetch_tokens(settings, provider, code, redirect_uri, verifier):
    """Swap the one-time code for tokens. Kept separate so tests can replace the network call."""
    _, token_url, client_id, client_secret = _endpoints(settings, provider)
    try:
        response = httpx.post(token_url, timeout=15, data={
            'grant_type': 'authorization_code', 'code': code, 'redirect_uri': redirect_uri, 'code_verifier': verifier,
            'client_id': client_id, 'client_secret': client_secret})
    except httpx.HTTPError as error:
        raise OAuthError('failed', f'{provider} token request failed: {type(error).__name__}') from error
    if response.status_code != 200:
        raise OAuthError('failed', f'{provider} token request returned {response.status_code}')
    return response.json()


def _claims(id_token):
    try:
        payload = id_token.split('.')[1]
        return json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    except (AttributeError, IndexError, ValueError) as error:
        raise OAuthError('failed', 'The ID token could not be read') from error


def identity(settings, provider, tokens, nonce):
    """The verified email and display name from the provider's ID token."""
    claims = _claims(tokens.get('id_token'))
    _, _, client_id, _ = _endpoints(settings, provider)
    audience = claims.get('aud')
    if (audience if isinstance(audience, list) else [audience]).count(client_id) != 1:
        raise OAuthError('failed', 'ID token audience mismatch')
    if claims.get('exp', 0) < time.time() - 60:
        raise OAuthError('expired', 'ID token expired')
    if not nonce or claims.get('nonce') != nonce:
        raise OAuthError('failed', 'ID token nonce mismatch')
    email = (claims.get('email') or '').strip().lower()
    if provider == 'google':
        if claims.get('iss') not in GOOGLE_ISSUERS:
            raise OAuthError('failed', 'Unexpected Google issuer')
        if not email or claims.get('email_verified') is not True:
            raise OAuthError('unverified')
    else:
        tenant = claims.get('tid', '')
        if claims.get('iss') != f'https://login.microsoftonline.com/{tenant}/v2.0':
            raise OAuthError('failed', 'Unexpected Microsoft issuer')
        configured = (settings.microsoft_tenant or 'common').lower()
        # Work and school accounts can carry any email their organisation typed in. Trust it only for personal Microsoft
        # accounts, for the one organisation this server is set up for, or when Microsoft confirms the domain owner.
        trusted = (tenant == MICROSOFT_CONSUMER_TENANT or claims.get('xms_edov') is True
                   or (configured not in {'common', 'organizations', 'consumers'} and tenant.lower() == configured))
        if not email or not trusted:
            raise OAuthError('unverified')
    name = (claims.get('name') or email.split('@')[0]).strip()[:80]
    return email, name if len(name) >= 2 else email.split('@')[0][:80]
