import asyncio
import hashlib
import math
import os
import struct
from types import SimpleNamespace
from unittest.mock import AsyncMock

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from test_calling import service, webapp, technician, request
from realapp import livekit_setup, livekit_transport, local_secrets
from realapp.config import Settings
from realapp.livekit_transport import AudioTurns, BrowserSession, LiveKitTransport


@pytest.fixture
def voice_app(webapp, monkeypatch):
    app, service = webapp
    room = SimpleNamespace(list_rooms=AsyncMock(return_value=SimpleNamespace(rooms=[])),
        create_room=AsyncMock(), delete_room=AsyncMock(), update_participant=AsyncMock(), remove_participant=AsyncMock(),
        list_participants=AsyncMock(return_value=SimpleNamespace(participants=[])))
    class Client:
        async def __aenter__(self): return SimpleNamespace(room=room)
        async def __aexit__(self, *args): pass
    monkeypatch.setattr(livekit_setup, 'livekit_client', lambda settings: Client())
    monkeypatch.setattr(livekit_transport, 'livekit_client', lambda settings: Client())
    monkeypatch.setattr(BrowserSession, 'connect', AsyncMock())
    monkeypatch.setattr(BrowserSession, 'close', AsyncMock())
    monkeypatch.setattr(livekit_setup.LiveKitSetup, 'available', property(lambda self: self.settings.environment == 'local'))
    saved=[]
    monkeypatch.setattr(livekit_setup, 'save_local_livekit_config', lambda value:saved.append(value.copy()))
    admin=TestClient(app)
    admin.post('/api/auth/setup',json={'name':'Admin','username':'admin','password':'test-admin-password'})
    return SimpleNamespace(app=app, service=service, client=admin, room=room, saved=saved, voice=app.state.voice)


def test_tokens_are_room_scoped_and_technician_cannot_listen_before_confirmation(service):
    service.settings.livekit_api_key='test-key'
    service.settings.livekit_api_secret='test-secret-at-least-32-characters'
    transport=LiveKitTransport(service.settings, service)
    token=transport.token('CALL-A','technician:1:offer','Agent','technician')
    payload=jwt.decode(token,service.settings.livekit_api_secret,algorithms=['HS256'])
    assert payload['video']['room']=='resolveai-call-a'
    assert payload['video']['canSubscribe'] is False
    assert payload['video']['canPublish'] is False
    assert payload['video']['canPublishData'] is False
    assert payload['exp']-payload['nbf']<=60
    assert not payload['video'].get('roomAdmin')


def customer_client(f):
    value={'name':'Customer','username':'customer','password':'isolated-customer-password','role':'customer'}
    assert f.client.post('/api/users',json=value).status_code==201
    client=TestClient(f.app)
    assert client.post('/api/auth/login',json=value).status_code==200
    return client


def test_signed_in_customer_call_capability_does_not_expose_workspace(voice_app):
    f=voice_app
    customer=customer_client(f)
    response=customer.post('/api/support/calls',json={'caller':'Customer','language':'en'})
    assert response.status_code==201
    connection=response.json(); call_id=connection['call_id']
    assert connection['url']=='ws://127.0.0.1:7880'
    assert customer.get('/api/calling').status_code==403
    assert customer.get('/api/support/calls/'+call_id).status_code==403
    assert customer.post('/api/support/calls/'+call_id+'/end',headers={'X-Support-Token':'wrong'}).status_code==403
    headers={'X-Support-Token':connection['access_token']}
    state=customer.get('/api/support/calls/'+call_id,headers=headers).json()
    assert 'transcript' not in state and 'customer_token_hash' not in state
    assert 'customer_token_hash' not in f.client.get('/api/calling').text
    assert f.service.get(call_id)['customer_token_hash']==hashlib.sha256(connection['access_token'].encode()).hexdigest()
    assert customer.post('/api/support/calls/'+call_id+'/end',headers=headers).status_code==200
    assert f.service.get(call_id)['status']=='Completed'


def test_start_failure_retains_failed_call_and_releases_capacity(voice_app, monkeypatch):
    f=voice_app
    monkeypatch.setattr(BrowserSession,'connect',AsyncMock(side_effect=RuntimeError('provider error')))
    response=f.client.post('/api/support/calls',json={'caller':'Customer'})
    assert response.status_code==502
    assert len(f.voice.sessions)==0
    assert f.service.snapshot()['calls'][0]['status']=='Failed'


def test_customer_rate_limit_and_cross_site_rejection(voice_app):
    f=voice_app
    customer=customer_client(f)
    assert customer.post('/api/support/calls',json={'caller':'Customer'},headers={'Origin':'https://attacker.test'}).status_code==403
    for _ in range(5):
        result=customer.post('/api/support/calls',json={'caller':'Customer'}).json()
        customer.post('/api/support/calls/'+result['call_id']+'/end',headers={'X-Support-Token':result['access_token']})
    assert customer.post('/api/support/calls',json={'caller':'Customer'}).status_code==429


def test_technician_join_is_authoritative_and_rejects_other_technicians(voice_app):
    f=voice_app
    actor=f.client.get('/api/auth/status').json()['user']
    f.service.presence(actor['id'],'Available');f.service.heartbeat(actor['id'],True)
    call=f.service.create_call('Customer','browser')
    f.service.add_turn(call['id'],'Customer','I need a technician to fix the payroll outage.')
    f.service.triage(call['id']);f.service.mark_waiting(call['id'])
    f.service.repository.mutate(lambda db:db['calls'][call['id']].update(ready_at=0))
    f.service.dispatch()
    result=f.client.post('/api/calling/'+call['id']+'/accept')
    assert result.status_code==200 and result.json()['token']
    assert f.service.get(call['id'])['status']=='Ringing'
    assert f.client.post('/api/calling/'+call['id']+'/connected').status_code==409
    f.room.list_participants.return_value=SimpleNamespace(participants=[SimpleNamespace(identity=result.json()['identity'])])
    assert f.client.post('/api/calling/'+call['id']+'/connected').status_code==200
    current=f.service.get(call['id'])
    assert current['status']=='Connected'
    assert current['case_id'] is None
    assert f.service.case_store.list_cases() == []
    assert f.client.post('/api/calling/'+call['id']+'/transfer').status_code==200
    assert f.service.get(call['id'])['status']=='Queued'
    assert f.client.post('/api/calling/'+call['id']+'/connected').status_code==403
    f.room.remove_participant.assert_awaited()


def test_expired_offer_cannot_get_join_token(voice_app):
    f=voice_app
    actor=f.client.get('/api/auth/status').json()['user']
    call=f.service.create_call('Customer','browser')
    f.service.repository.mutate(lambda db:db['calls'][call['id']].update(technician_id=actor['id'],status='Ringing',reserved_until=0))
    assert f.client.post('/api/calling/'+call['id']+'/accept').status_code==409


def test_permission_failure_requeues_and_does_not_leave_technician_busy(voice_app):
    f=voice_app
    actor=f.client.get('/api/auth/status').json()['user']
    f.service.presence(actor['id'],'Available');f.service.heartbeat(actor['id'],True)
    call=f.service.create_call('Customer','browser')
    f.service.add_turn(call['id'],'Customer','Payroll failed. Please send a technician.')
    f.service.triage(call['id'])
    f.service.repository.mutate(lambda db:db['calls'][call['id']].update(ready_at=0))
    f.service.dispatch()
    connection=f.client.post('/api/calling/'+call['id']+'/accept').json()
    f.room.list_participants.return_value=SimpleNamespace(participants=[SimpleNamespace(identity=connection['identity'])])
    f.room.update_participant.side_effect=RuntimeError('connection failure')
    assert f.client.post('/api/calling/'+call['id']+'/connected').status_code==502
    assert f.service.get(call['id'])['status']=='Queued'
    assert f.client.get('/api/auth/status').json()['user']['status']=='Available'


def test_ai_voice_resolution_only_after_confirmed_outcome(service,monkeypatch):
    from realapp.calling import VoiceReply
    from realapp.models import AnalysisRequest
    async def run():
        case=service.engine.analyze(AnalysisRequest(transcript='Customer: How to restart my printer?'))
        case.routing.handler,case.routing.risk,case.routing.confidence='AI','Low',.97
        monkeypatch.setattr(service.engine,'analyze',lambda _:case)
        monkeypatch.setattr(service.engine,'transcribe',lambda *args:'How to restart my printer?')
        monkeypatch.setattr(service,'reply',lambda _:VoiceReply(reply='Please restart your printer.',escalate=False,customer_confirmed_resolved=False))
        call=service.create_call('Customer','browser')
        transport=LiveKitTransport(service.settings,service);transport.resolve=AsyncMock()
        session=BrowserSession(transport,call['id']);session.say=AsyncMock()
        await session.process_utterance('Customer',b'audio')
        assert service.get(call['id'])['status']=='AI'
        transport.resolve.assert_not_awaited()
        monkeypatch.setattr(service.engine,'transcribe',lambda *args:'It works now. My issue is fixed.')
        monkeypatch.setattr(service,'reply',lambda _:VoiceReply(reply='Glad it is working.',escalate=False,customer_confirmed_resolved=True))
        await session.process_utterance('Customer',b'audio')
        transport.resolve.assert_awaited_once()
        assert transport.resolve.call_args.args[0]['case_id']
        assert service.get(call['id'])['status']=='Completed'
    asyncio.run(run())


def test_livekit_config_admin_only_local_and_secret_not_returned(voice_app):
    f=voice_app
    secret='new-secret-at-least-32-characters'
    value={'url':'wss://project.livekit.cloud','api_key':'project-key','api_secret':secret}
    result=f.client.post('/api/config/livekit',json=value)
    assert result.status_code==200 and secret not in result.text
    assert f.saved[-1]['livekit_api_secret']==secret
    assert secret not in f.client.get('/api/config/livekit').text
    f.client.post('/api/technicians',json={'name':'Worker','username':'worker','password':'test-worker-password'})
    worker=TestClient(f.app);worker.post('/api/auth/login',json={'username':'worker','password':'test-worker-password'})
    assert worker.post('/api/config/livekit',json=value).status_code==403
    remote=TestClient(f.app,base_url='https://calls.example.test')
    remote.post('/api/auth/login',json={'username':'admin','password':'test-admin-password'})
    assert remote.post('/api/config/livekit',json=value).status_code==403
    f.room.list_rooms.side_effect=RuntimeError(secret)
    failed=f.client.post('/api/config/livekit',json={**value,'api_key':'wrong'})
    assert failed.status_code==502 and secret not in failed.text
    assert f.service.settings.livekit_api_key=='project-key'


@pytest.mark.parametrize('url',['http://example.com','ws://example.com','wss://user:pass@example.com','wss://example.com/path','wss://example.com?x=1','wss://example.com:bad'])
def test_config_url_rejects_insecure_or_ambiguous_addresses(url):
    with pytest.raises(HTTPException): livekit_setup.validate_url(url)


def test_audio_segments_wav_and_ignores_silence():
    detector=AudioTurns()
    silence=b'\x00'*640
    assert all(detector.feed(silence) is None for _ in range(40))
    tone=struct.pack('<320h',*(int(8000*math.sin(i*.2)) for i in range(320)))
    for _ in range(20): detector.feed(tone)
    chunks=[detector.feed(silence) for _ in range(40)]
    assert sum(c is not None for c in chunks)==1
    assert next(c for c in chunks if c).startswith(b'RIFF')


def test_quiet_microphone_speech_is_not_discarded():
    detector = AudioTurns(450)
    silence = b'\x00' * 640
    quiet = struct.pack('<320h', *(int(220 * math.sin(i * .2)) for i in range(320)))
    noise = struct.pack('<320h', *(int(25 * math.sin(i * .2)) for i in range(320)))
    assert all(detector.feed(noise) is None for _ in range(80))
    for _ in range(30):
        detector.feed(quiet)
    chunks = [detector.feed(silence) for _ in range(40)]
    assert sum(chunk is not None for chunk in chunks) == 1


def test_audio_worker_failure_is_reported_instead_of_silenced(service):
    async def run():
        call = service.create_call('Customer', 'browser')
        session = BrowserSession(LiveKitTransport(service.settings, service), call['id'])
        async def failed_capture():
            raise RuntimeError('capture stopped')
        session.task(failed_capture())
        await asyncio.sleep(.02)
        assert 'Audio processing was interrupted' in service.get(call['id'])['last_error']
    asyncio.run(run())


def test_voice_transcription_routes_and_preserves_technician_comments(service,monkeypatch):
    async def run():
        call=service.create_call('Customer','browser')
        transport=LiveKitTransport(service.settings,service)
        session=BrowserSession(transport,call['id'])
        session.say=AsyncMock()
        monkeypatch.setattr(service.engine,'transcribe',lambda *args:'The payroll app crashes. I need a technician.')
        await session.process_utterance('Customer',b'test-audio')
        current=service.get(call['id'])
        assert current['status']=='Queued' and current['case_id'] is None and current['ready_at'] is not None
        monkeypatch.setattr(service.engine,'transcribe',lambda *args:'I am checking the application logs.')
        await session.process_utterance('Technician',b'test-audio')
        completed = service.finish(call['id'])
        case=service.case_store.get_case(completed['case_id'])
        assert case.transcript[-1].speaker=='Technician'
        assert case.ticket.resolution=='' and case.quality_score is None
    asyncio.run(run())


@pytest.mark.skipif(os.name!='nt',reason='Windows DPAPI')
def test_livekit_credentials_survive_restart_without_changing_openai(tmp_path,monkeypatch):
    monkeypatch.setenv('RESOLVEAI_LOCAL_LIVEKIT_FILE',str(tmp_path/'livekit.dpapi'))
    monkeypatch.setenv('RESOLVEAI_LOCAL_KEY_FILE',str(tmp_path/'openai.dpapi'))
    local_secrets.save_local_openai_key('test-existing-openai-key')
    before=(tmp_path/'openai.dpapi').read_bytes()
    values={'livekit_url':'ws://127.0.0.1:7880','livekit_api_key':'test-key','livekit_api_secret':'test-secret-at-least-32-characters'}
    local_secrets.save_local_livekit_config(values)
    assert values['livekit_api_secret'].encode() not in (tmp_path/'livekit.dpapi').read_bytes()
    settings=Settings(_env_file=None);livekit_setup.restore_livekit_settings(settings)
    assert settings.livekit_api_secret==values['livekit_api_secret']
    assert (tmp_path/'openai.dpapi').read_bytes()==before
    assert local_secrets.load_local_openai_key()=='test-existing-openai-key'
