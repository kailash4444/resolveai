import os
from urllib.parse import urlsplit

import aiohttp
from fastapi import HTTPException
from livekit import api
from pydantic import BaseModel, SecretStr

from realapp.local_secrets import load_local_livekit_config, save_local_livekit_config

FIELDS = ('livekit_url', 'livekit_api_key', 'livekit_api_secret')


class LiveKitCredentials(BaseModel):
    url: str
    api_key: str
    api_secret: SecretStr = SecretStr('')


def restore_livekit_settings(settings):
    if settings.environment != 'local':
        return
    values = load_local_livekit_config()
    if any(getattr(settings, key) for key in FIELDS):
        return  # Environment credentials are a complete, independent identity.
    for key in FIELDS:
        if isinstance(values.get(key), str):
            setattr(settings, key, values[key])


def validate_url(value):
    value = value.strip().rstrip('/')
    try:
        parsed = urlsplit(value)
        local = parsed.hostname in {'127.0.0.1', 'localhost', '::1'}
        if (not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
                or any(c.isspace() for c in value) or parsed.scheme not in ({'ws', 'wss'} if local else {'wss'})):
            raise ValueError()
        parsed.port
    except ValueError:
        raise HTTPException(400, 'Use your LiveKit wss:// project address, or ws://127.0.0.1:7880 for a local server.') from None
    return value


def livekit_client(settings):
    return api.LiveKitAPI(settings.livekit_url, settings.livekit_api_key, settings.livekit_api_secret,
                         timeout=aiohttp.ClientTimeout(total=12))


async def check_connection(settings):
    if not all(getattr(settings, key) for key in FIELDS):
        raise HTTPException(503, 'Connect LiveKit before starting a browser call.')
    try:
        async with livekit_client(settings) as client:
            await client.room.list_rooms(api.ListRoomsRequest())
    except Exception:
        raise HTTPException(502, 'Could not connect to LiveKit. Check the server address and credentials, and make sure the local server is running.') from None


class LiveKitSetup:
    def __init__(self, settings, service):
        self.settings, self.service = settings, service

    @property
    def available(self):
        return self.settings.environment == 'local' and os.name == 'nt'

    def status(self):
        s = self.settings
        return {'available': self.available, 'url': s.livekit_url, 'api_key': s.livekit_api_key,
                'credentials_saved': bool(s.livekit_api_key and s.livekit_api_secret)}

    async def save(self, value):
        from realapp.calling import TERMINAL
        if any(c['origin'] == 'browser' and c['status'] not in TERMINAL for c in self.service.snapshot()['calls']):
            raise HTTPException(409, 'Finish active browser calls before changing the connection.')
        url, key = validate_url(value.url), value.api_key.strip()
        secret = value.api_secret.get_secret_value().strip()
        if not secret and (url, key) == (self.settings.livekit_url, self.settings.livekit_api_key):
            secret = self.settings.livekit_api_secret
        if not key or len(key) > 128 or len(secret) < 16 or len(secret) > 512:
            raise HTTPException(400, 'Enter your LiveKit API key and secret.')
        values = dict(zip(FIELDS, (url, key, secret)))
        candidate = self.settings.model_copy(update=values)
        await check_connection(candidate)
        try:
            save_local_livekit_config(values)
        except OSError:
            raise HTTPException(503, 'Could not save the protected LiveKit credentials in this Windows profile.') from None
        for name, content in values.items():
            setattr(self.settings, name, content)
        return self.status()
