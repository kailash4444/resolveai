import json
import sqlite3

import pytest

from scripts.snapshot_data import export_data, restore_data


def test_snapshot_roundtrip_excludes_credentials_preserves_records(tmp_path):
    data = tmp_path/'original'
    data.mkdir()
    routing = {'technicians': {'u1': {'id': 'u1', 'name': 'Test User', 'username': 'test', 'role': 'admin',
                                    'salt': 'private', 'password_hash': 'private', 'availability': 'Away'}},
               'calls': {'c1': {'id': 'c1', 'status': 'Completed', 'customer_id': 'u1',
                                'transcript': [{'text': 'Issue resolved'}], 'join_token': 'private'}},
               'sessions': {'private': {}}, 'login_attempts': {'private': {}}}
    with sqlite3.connect(data/'calling.sqlite3') as db:
        db.execute('CREATE TABLE routing (id INTEGER, body TEXT)')
        db.execute('INSERT INTO routing VALUES (1, ?)', (json.dumps(routing),))
    with sqlite3.connect(data/'resolveai.sqlite3') as db:
        for table, item in [('cases', {'id': 'case1', 'customer_id': 'u1', 'ticket': {'id': 'INC0000001'}}),
                            ('knowledge', {'id': 'KB00001'}), ('metadata', {'incident': 1})]:
            db.execute(f'CREATE TABLE {table} (id TEXT, body TEXT)')
            db.execute(f'INSERT INTO {table} VALUES (?, ?)', (item.get('id', 'numbers'), json.dumps(item)))
    snapshot = tmp_path/'snapshot'
    assert export_data(data, snapshot)['users'] == 1
    assert 'private' not in ''.join(file.read_text() for file in snapshot.glob('*.json'))
    restored = tmp_path/'restored'
    restore_data(snapshot, restored)
    with sqlite3.connect(restored/'calling.sqlite3') as db:
        result = json.loads(db.execute('SELECT body FROM routing').fetchone()[0])
    assert result['sessions'] == {}
    assert result['calls']['c1']['transcript'] == routing['calls']['c1']['transcript']
    assert result['technicians']['u1']['availability'] == 'Away'
    assert result['technicians']['u1']['status'] == 'Offline'
    assert result['technicians']['u1']['password_hash'] != 'private'
    original_bytes = (restored/'calling.sqlite3').read_bytes()
    with pytest.raises(ValueError, match='empty data directory'):
        restore_data(snapshot, restored)
    assert (restored/'calling.sqlite3').read_bytes() == original_bytes
    (snapshot/'calls.json').write_text('[]')
    with pytest.raises(ValueError, match='checksum'):
        restore_data(snapshot, tmp_path/'corrupt')
    assert not (tmp_path/'corrupt').exists()
