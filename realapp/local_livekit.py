"""Prepare local-only LiveKit credentials without printing secret values."""
import json
import secrets
from pathlib import Path

from realapp.config import Settings
from realapp.livekit_setup import restore_livekit_settings
from realapp.local_secrets import save_local_livekit_config


def prepare():
    settings = Settings()
    restore_livekit_settings(settings)
    if settings.livekit_url and settings.livekit_url != 'ws://127.0.0.1:7880':
        return {'mode':'external'}
    values = {'livekit_url':'ws://127.0.0.1:7880',
              'livekit_api_key':settings.livekit_api_key or 'resolveai_' + secrets.token_hex(10),
              'livekit_api_secret':settings.livekit_api_secret or secrets.token_urlsafe(48)}
    save_local_livekit_config(values)
    path = Path('data/local-livekit.yaml').resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('port: 7880\nbind_addresses: ["127.0.0.1"]\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  node_ip: 127.0.0.1\n  use_external_ip: false\nkeys:\n  '
                   + json.dumps(values['livekit_api_key']) + ': ' + json.dumps(values['livekit_api_secret'])
                   + '\nlogging:\n  level: warn\n', encoding='utf-8')
    return {'mode':'local', 'config_path':str(path)}


if __name__ == '__main__':
    print(json.dumps(prepare()))
