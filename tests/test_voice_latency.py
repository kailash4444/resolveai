import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from test_calling import service
from realapp.calling_store import FirestoreCallingStore
from realapp.config import Settings
from realapp.livekit_transport import BrowserSession, LiveKitTransport
from realapp.streaming_speech import GoogleStreamingSpeech


def test_firestore_targeted_reads_do_not_scan_call_history(monkeypatch):
    from google.cloud import firestore
    monkeypatch.setattr(firestore, 'transactional', lambda function: function)
    reads, writes = [], []
    data = {'coordinator': {'technicians': {}, 'sessions': {}}, 'CALL-A': {'id': 'CALL-A', 'transcript': []}}
    class Document:
        def __init__(self, id): self.id = id
        def get(self, **kwargs):
            reads.append(self.id)
            return SimpleNamespace(id=self.id, exists=self.id in data, to_dict=lambda: deepcopy(data[self.id]))
    class Collection:
        def document(self, id): return Document(id)
        def stream(self, **kwargs): raise AssertionError('Full call scan on latency-critical path')
    store = object.__new__(FirestoreCallingStore)
    store.ref = Document('coordinator'); store.calls = Collection()
    store.client = SimpleNamespace(transaction=lambda: SimpleNamespace(set=lambda ref, value: writes.append((ref.id, value))))
    assert store.get_call('CALL-A')['id'] == 'CALL-A'
    assert reads == ['CALL-A']
    reads.clear()
    store.mutate(lambda db: db['sessions'], call_ids=())
    assert reads == ['coordinator'] and not writes
    reads.clear()
    store.mutate(lambda db: db['calls']['CALL-A']['transcript'].append('hello'), call_ids=('CALL-A',))
    assert reads == ['coordinator', 'CALL-A']
    assert [id for id, _ in writes] == ['CALL-A']


def test_streaming_stt_sends_audio_before_end_and_keeps_only_final_text():
    async def run():
        audio_seen = asyncio.Event()
        requests_seen = []
        class Client:
            async def streaming_recognize(self, requests, **kwargs):
                async def responses():
                    async for request in requests:
                        requests_seen.append(request)
                        if request.audio:
                            audio_seen.set()
                            yield SimpleNamespace(results=[SimpleNamespace(is_final=False, alternatives=[SimpleNamespace(transcript='incorrect partial')])])
                    yield SimpleNamespace(results=[SimpleNamespace(is_final=True, alternatives=[SimpleNamespace(transcript='The printer is offline.')])])
                return responses()
        speech = GoogleStreamingSpeech(Settings(_env_file=None, google_cloud_project='test'), Client())
        queue = asyncio.Queue(); partial = AsyncMock()
        task = asyncio.create_task(speech.transcribe(queue, partial))
        await queue.put(b'\0' * 640)
        await asyncio.wait_for(audio_seen.wait(), 1)
        assert not task.done(), 'Recognition must start while audio is still arriving'
        await queue.put(None)
        assert await task == 'The printer is offline.'
        assert partial.await_args_list[0].args[0] == 'incorrect partial'
        assert requests_seen[0].streaming_config.config.model == 'chirp_3'
        assert requests_seen[0].streaming_config.config.language_codes == ['en-IN']
    asyncio.run(run())


def test_recording_does_not_wait_for_ai_playback(service, monkeypatch):
    async def run():
        call = service.create_call('Customer', 'browser')
        session = BrowserSession(LiveKitTransport(service.settings, service), call['id'])
        session.request_knowledge = lambda: None
        entered, release = asyncio.Event(), asyncio.Event()
        async def slow_response(revision):
            entered.set(); await release.wait()
        session.respond = slow_response
        worker = asyncio.create_task(session.process_responses())
        try:
            await session.record_text('Customer', 'First sentence.')
            await entered.wait()
            await asyncio.wait_for(session.record_text('Technician', 'I can hear you.'), 1)
            await asyncio.wait_for(session.record_text('Customer', 'Another detail.'), 1)
            turns = service.get(call['id'])['transcript']
            assert [t['text'] for t in turns] == ['First sentence.', 'I can hear you.', 'Another detail.']
        finally:
            release.set(); worker.cancel(); await asyncio.gather(worker, return_exceptions=True)
    asyncio.run(run())


def test_gemini_tts_yields_audio_before_generation_finishes():
    from realapp.gemini import GeminiEngine
    from realapp.store import MemoryStore
    async def run():
        continuation = asyncio.Event()
        def response(pcm):
            return SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=[
                SimpleNamespace(inline_data=SimpleNamespace(data=pcm, mime_type='audio/L16;rate=24000'))]))])
        async def chunks():
            yield response(b'\x01\0' * 480)
            await continuation.wait()
            yield response(b'\x02\0' * 480)
        engine = GeminiEngine(Settings(_env_file=None, gemini_provider='google_ai', gemini_api_key='isolated-test-google-key'), MemoryStore().list_knowledge)
        engine._client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content_stream=AsyncMock(return_value=chunks()))))
        audio = engine.synthesize_stream('Hello')
        assert await asyncio.wait_for(anext(audio), 1) == b'\x01\0' * 480
        continuation.set()
        assert await anext(audio) == b'\x02\0' * 480
        await audio.aclose()
    asyncio.run(run())


def test_hangup_flushes_last_stream_before_finishing(service):
    async def run():
        call = service.create_call('Customer', 'browser')
        session = BrowserSession(LiveKitTransport(service.settings, service), call['id'])
        queue = asyncio.Queue()
        session.room = SimpleNamespace(disconnect=AsyncMock(), local_participant=SimpleNamespace(publish_data=AsyncMock()))
        async def recognize(queue, partial):
            while await queue.get() is not None:
                pass
            await asyncio.sleep(.01)
            return 'These are my final words.'
        session.streaming_speech = SimpleNamespace(transcribe=recognize, close=AsyncMock())
        async def capture():
            try:
                await asyncio.Future()
            finally:
                queue.put_nowait(None)
        session.task(capture())
        task = session.task(session.stream_segment(queue, 'Customer', 'customer:'+call['id'], None, 'last'))
        session.recognition_tasks.add(task)
        await asyncio.sleep(0)
        await session.close()
        assert service.get(call['id'])['transcript'][-1]['text'] == 'These are my final words.'
        session.streaming_speech.close.assert_awaited_once()
    asyncio.run(run())
