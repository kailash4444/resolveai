import io
import os
import wave
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from realapp import main, local_secrets
from realapp.config import Settings
from realapp.engine import create_engine
from realapp.gemini import GeminiEngine
from realapp.store import MemoryStore
from realapp.models import AnalysisRequest
from test_roles import accounts


def engine(provider='google_ai'):
    settings = Settings(llm_provider=provider, gemini_provider=provider, gemini_api_key='isolated-test-google-key',
                        google_cloud_project='test-project')
    value = create_engine(settings, MemoryStore().list_knowledge)
    value._client = SimpleNamespace(models=SimpleNamespace(generate_content=Mock(), embed_content=Mock()))
    return value


def test_google_engine_uses_single_text_embedding_requests_and_separate_models():
    value = engine('vertex')
    value._client.models.embed_content.return_value = SimpleNamespace(embeddings=[SimpleNamespace(values=[1., 2.])])
    assert value._embed(['first', 'second'], 'RETRIEVAL_DOCUMENT') == [[1., 2.], [1., 2.]]
    calls = value._client.models.embed_content.call_args_list
    assert [call.kwargs['contents'] for call in calls] == ['first', 'second']
    assert all(call.kwargs['model'] == 'gemini-embedding-001' for call in calls)
    value._client.models.generate_content.return_value = SimpleNamespace(candidates=[], text='The browser is frozen.')
    assert value.transcribe('utterance.wav', b'RIFFtest-audio') == 'The browser is frozen.'
    request = value._client.models.generate_content.call_args.kwargs
    assert request['model'] == value.settings.gemini_transcription_model
    assert request['contents'][0].inline_data.mime_type == 'audio/wav'
    assert request['contents'][0].inline_data.data == b'RIFFtest-audio'
    assert value.settings.active_tts_model == 'gemini-3.8-flash-lite-tts'


def test_google_tts_decodes_wav_for_livekit_and_selects_voice():
    value = engine()
    raw = b'\x01\x00' * 2400
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(24000); wav.writeframes(raw)
    value._client.models.generate_content.return_value = SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(
        parts=[SimpleNamespace(inline_data=SimpleNamespace(data=output.getvalue(), mime_type='audio/wav'))]))])
    assert value.synthesize('Hello customer.') == raw
    request = value._client.models.generate_content.call_args.kwargs
    assert request['model'] == 'gemini-3.8-flash-lite-tts'
    assert request['config'].speech_config.voice_config.voice == 'Kore'
    assert request['contents'][0].parts[0].text == 'Hello customer.'
    assert value._pcm(raw, 'audio/L16;rate=24000') == raw
    with pytest.raises(RuntimeError):
        value._pcm(b'bad', 'audio/mpeg')
    value._client.models.generate_content.return_value = SimpleNamespace(candidates=[])
    with pytest.raises(RuntimeError, match='no speech'):
        value.synthesize('Hello')


def test_gemini_audio_validation_precedes_api_requests():
    value = engine()
    for name, audio in [('file.exe', b'data'), ('empty.wav', b''), ('large.wav', b'x'*(14*1024*1024+1))]:
        with pytest.raises(ValueError):
            value.transcribe(name, audio)
    value._client.models.generate_content.assert_not_called()


def test_gemini_analysis_and_qa_use_google_structured_output():
    value = engine()
    value._client.models.embed_content.return_value = SimpleNamespace(embeddings=[SimpleNamespace(values=[1.] + [0.]*767)])
    value.knowledge_index.sync_all(strict=True)
    payload = value._mock_analysis('The payroll application crashes when I log in.')
    value._client.models.generate_content.return_value = SimpleNamespace(parsed=payload)
    case = value.analyze(AnalysisRequest(caller='Customer', channel='Voice', transcript='The payroll application crashes when I log in.'))
    assert case.ticket.state == 'New' and case.ticket.resolution == ''
    assert value._client.models.generate_content.call_args.kwargs['model'] == 'gemini-3.8-flash'
    case.ticket.state, case.ticket.resolution = 'Resolved', 'Reinstalled and verified.'
    value._client.models.generate_content.return_value = SimpleNamespace(parsed={'checks': [], 'quality_score': 95})
    assert value.audit(case).quality_score == 95


def test_gemini_admin_key_and_upload_are_shared_and_customer_cannot_configure(accounts, monkeypatch):
    value = engine()
    monkeypatch.setattr(main, 'engine', value)
    monkeypatch.setattr(main, 'settings', value.settings)
    saved = []
    monkeypatch.setattr(main, 'save_local_gemini_key', saved.append)
    key = 'isolated-new-shared-google-key'
    for client in [accounts.tech_a, accounts.customer_a]:
        assert client.post('/api/config/gemini-key', json={'api_key': key}).status_code == 403
        assert client.get('/api/config').json()['runtime_key_supported'] is False
    response = accounts.admin.post('/api/config/gemini-key', json={'api_key': key})
    assert response.status_code == 200 and saved == [key]
    assert key not in response.text
    assert value.settings.gemini_api_key == key
    assert accounts.admin.get('/api/config').json()['transcription_model'] == value.settings.gemini_transcription_model
    monkeypatch.setattr(value, 'transcribe', lambda filename, content: 'Google transcript')
    result = accounts.tech_a.post('/api/transcribe', files={'file': ('speech.wav', b'audio', 'audio/wav')})
    assert result.json() == {'text': 'Google transcript', 'model': value.settings.gemini_transcription_model}
    assert accounts.customer_a.post('/api/transcribe', files={'file': ('speech.wav', b'audio')}).status_code == 403


@pytest.mark.skipif(os.name != 'nt', reason='Windows protected storage')
def test_gemini_key_persists_separately_from_openai_and_livekit(tmp_path, monkeypatch):
    monkeypatch.setenv('RESOLVEAI_LOCAL_GEMINI_FILE', str(tmp_path/'google.dpapi'))
    monkeypatch.setenv('RESOLVEAI_LOCAL_KEY_FILE', str(tmp_path/'openai.dpapi'))
    monkeypatch.setenv('RESOLVEAI_LOCAL_LIVEKIT_FILE', str(tmp_path/'livekit.dpapi'))
    local_secrets.save_local_openai_key('old-isolated-openai-key')
    local_secrets.save_local_livekit_config({'livekit_api_secret': 'isolated-livekit-secret'})
    old = [(tmp_path/name).read_bytes() for name in ['openai.dpapi', 'livekit.dpapi']]
    local_secrets.save_local_gemini_key('new-isolated-gemini-key')
    assert local_secrets.load_local_gemini_key() == 'new-isolated-gemini-key'
    assert b'new-isolated-gemini-key' not in (tmp_path/'google.dpapi').read_bytes()
    assert old == [(tmp_path/name).read_bytes() for name in ['openai.dpapi', 'livekit.dpapi']]
    assert local_secrets.load_local_openai_key() == 'old-isolated-openai-key'


def test_google_transcription_reads_audio_transcription_response():
    value = engine()
    value._client.models.generate_content.return_value = SimpleNamespace(text=None, candidates=[
        SimpleNamespace(content=SimpleNamespace(parts=[SimpleNamespace(audio_transcription=SimpleNamespace(text='The printer is offline.'))]))])
    assert value.transcribe('utterance.wav', b'RIFFtest-audio') == 'The printer is offline.'
