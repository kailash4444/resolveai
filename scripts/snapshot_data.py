"""Export shareable application records; restore only into an empty data directory."""
import argparse
from contextlib import closing
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import secrets
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_FIELDS = {'password', 'password_hash', 'salt', 'sessions', 'login_attempts',
                  'token', 'access_token', 'refresh_token', 'api_key', 'api_secret',
                  'setup_token', 'authorization', 'cookie', 'livekit_token',
                  'customer_token', 'join_token', 'session_token'}


def clean(value):
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()
                if key.lower() not in PRIVATE_FIELDS and not key.lower().endswith(('_token', '_token_hash', '_secret', '_password', '_api_key'))}
    if isinstance(value, list):
        return [clean(item) for item in value]
    return value


def read_records(path, table):
    with closing(sqlite3.connect(f'{path.resolve().as_uri()}?mode=ro', uri=True)) as db, db:
        return [json.loads(row[0]) for row in db.execute(f'SELECT body FROM {table} ORDER BY id')]


def export_data(data_dir, destination):
    destination.mkdir(parents=True, exist_ok=True)
    routing = read_records(data_dir/'calling.sqlite3', 'routing')[0]
    records = {
        'users': list(routing['technicians'].values()),
        'calls': list(routing['calls'].values()),
        'incidents': read_records(data_dir/'resolveai.sqlite3', 'cases'),
        'knowledge': read_records(data_dir/'resolveai.sqlite3', 'knowledge'),
    }
    with closing(sqlite3.connect(f'{(data_dir/"resolveai.sqlite3").resolve().as_uri()}?mode=ro', uri=True)) as db, db:
        records['metadata'] = {key: json.loads(body) for key, body in db.execute('SELECT id, body FROM metadata')}
    manifest = {'schema_version': 1, 'exported_at': datetime.now(timezone.utc).isoformat(),
                'counts': {key: len(value) for key, value in records.items()}, 'sha256': {},
                'excluded': ['Passwords and hashes', 'API credentials', 'Login sessions', 'Login attempts', 'Voice access tokens']}
    for name, value in records.items():
        payload = (json.dumps(clean(value), ensure_ascii=False, indent=2)+'\n').encode('utf-8')
        (destination/f'{name}.json').write_bytes(payload)
        manifest['sha256'][f'{name}.json'] = hashlib.sha256(payload).hexdigest()
    (destination/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
    return manifest['counts']


def restore_data(source, data_dir):
    # Never replace records, local credentials, or an existing installation.
    if data_dir.exists() and any(data_dir.iterdir()):
        raise ValueError('Restore requires an empty data directory. Existing data has not been changed.')
    manifest = json.loads((source/'manifest.json').read_text(encoding='utf-8'))
    if manifest['schema_version'] != 1:
        raise ValueError('Unsupported snapshot version.')
    records = {}
    for name in ['users', 'calls', 'incidents', 'knowledge', 'metadata']:
        payload = (source/f'{name}.json').read_bytes()
        if hashlib.sha256(payload).hexdigest() != manifest['sha256'][f'{name}.json']:
            raise ValueError(f'Snapshot checksum failed: {name}')
        records[name] = json.loads(payload)
    data_dir.mkdir(parents=True, exist_ok=True)
    accounts = []
    for user in records['users']:
        password, salt = secrets.token_urlsafe(24), secrets.token_hex(16)
        user.update(salt=salt, password_hash=hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex(),
                    status='Offline', voice_ready=False, last_seen=0, current_call_id=None)
        accounts.append([user['role'], user['name'], user['username'], password])
    with (data_dir/'restored_account_logins.csv').open('w', newline='', encoding='utf-8') as stream:
        writer = csv.writer(stream)
        writer.writerow(['role', 'name', 'username', 'password'])
        writer.writerows(accounts)
    with closing(sqlite3.connect(data_dir/'resolveai.sqlite3')) as db, db:
        for table, name in [('cases', 'incidents'), ('knowledge', 'knowledge')]:
            db.execute(f'CREATE TABLE {table} (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
            db.executemany(f'INSERT INTO {table} VALUES (?, ?)', [(item['id'], json.dumps(item)) for item in records[name]])
        db.execute('CREATE TABLE metadata (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
        db.executemany('INSERT INTO metadata VALUES (?, ?)', [(key, json.dumps(value)) for key, value in records['metadata'].items()])
    routing = {'technicians': {user['id']: user for user in records['users']},
               'calls': {call['id']: call for call in records['calls']}, 'sessions': {}, 'login_attempts': {}}
    # A restored checkout cannot resume another server's live audio connection.
    for call in routing['calls'].values():
        if call['status'] not in {'Completed', 'Callback requested', 'Failed'}:
            call.update(status='Callback requested', technician_id=None, technician_name=None)
    with closing(sqlite3.connect(data_dir/'calling.sqlite3')) as db, db:
        db.execute('CREATE TABLE routing (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
        db.execute('INSERT INTO routing VALUES (1, ?)', (json.dumps(routing),))
    return manifest['counts']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['export', 'restore'])
    parser.add_argument('--snapshot-dir', type=Path, default=ROOT/'snapshots/current')
    parser.add_argument('--data-dir', type=Path, default=ROOT/'data')
    args = parser.parse_args()
    result = export_data(args.data_dir, args.snapshot_dir) if args.action == 'export' else restore_data(args.snapshot_dir, args.data_dir)
    print(json.dumps(result))
    if args.action == 'restore':
        print('New passwords saved locally in the target data directory: restored_account_logins.csv')


if __name__ == '__main__':
    main()
