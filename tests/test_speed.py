from realapp.config import Settings
from realapp.gemini import GeminiEngine


def test_out_of_quota_model_is_skipped_for_later_calls():
    engine = GeminiEngine(Settings(gemini_provider='google_ai', gemini_model='main-model', gemini_fallback_model='backup-model'), lambda: [])
    tried = []
    def call(model):
        tried.append(model)
        if model == 'main-model':
            raise RuntimeError('429 RESOURCE_EXHAUSTED: You exceeded your current quota')
        return 'ok'
    assert engine._resilient(call) == ('ok', 'backup-model')
    assert engine._resilient(call) == ('ok', 'backup-model')
    assert tried == ['main-model', 'backup-model', 'backup-model']      # the second call skips the exhausted model


def test_overloaded_transcription_model_falls_back_instead_of_dropping_speech():
    from types import SimpleNamespace
    from unittest.mock import Mock
    engine = GeminiEngine(Settings(gemini_provider='google_ai', gemini_api_key='isolated-test-key', gemini_transcription_model='transcribe-model', gemini_fallback_model='backup-model'), lambda: [])
    def generate(model, contents):
        if model == 'transcribe-model':
            raise RuntimeError('503 UNAVAILABLE: This model is currently experiencing high demand.')
        assert isinstance(contents[0], str) and 'Transcribe' in contents[0]      # the general model gets an instruction
        return SimpleNamespace(text='My printer is offline.')
    engine._client = SimpleNamespace(models=SimpleNamespace(generate_content=Mock(side_effect=generate)))
    assert engine.transcribe('speech.wav', b'RIFFaudio') == 'My printer is offline.'
    assert engine.transcribe('speech.wav', b'RIFFaudio') == 'My printer is offline.'
    models = [call.kwargs['model'] for call in engine._client.models.generate_content.call_args_list]
    assert models == ['transcribe-model', 'backup-model', 'backup-model']       # no retry storm; overloaded model skipped
