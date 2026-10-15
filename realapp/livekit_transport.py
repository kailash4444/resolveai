"""LiveKit room transport for the existing incident and technician workflow."""
import asyncio
import audioop
import hashlib
import hmac
import io
import secrets
import time
import wave
import logging
import json
import re
from collections import deque
from datetime import timedelta

from fastapi import HTTPException
from livekit import api, rtc

from realapp.calling import TERMINAL
from realapp.livekit_setup import check_connection, livekit_client


def _safe_provider_error(error):
    """Keep useful provider diagnostics in local logs without logging credentials."""
    message = getattr(error, 'message', None)
    if not isinstance(message, str):
        return ''
    message = re.sub(r'AIza[0-9A-Za-z_-]{20,}', '[redacted-key]', message)
    message = re.sub(r'(?i)(api[_ -]?key|authorization|access[_ -]?token)(\s*[=:]\s*)[^\s,}\]]+', r'\1\2[redacted]', message)
    return ' '.join(message.split())[:240]


class AudioTurns:
    """Adaptive endpointer for 16-bit 16 kHz mono audio.

    This detects acoustic activity only; transcription and meaning are handled later.
    """
    def __init__(self, threshold=450, silence_ms=400, max_seconds=12):
        self.silence_bytes = max(250, silence_ms) * 32
        self.max_bytes = max(2, min(12, max_seconds)) * 32000
        self.threshold = max(90, threshold)
        self.buffer = bytearray()
        self.silence = self.voiced = 0
        self.noise_floor = 30.0
        self.pre_roll = deque(maxlen=6)  # 120 ms at the 20 ms frames used by LiveKit.
        self.onset_frames = deque(maxlen=4)
        self.active = False

    def feed(self, pcm):
        if not pcm:
            return
        level = audioop.rms(pcm, 2)
        onset_threshold = min(self.threshold, max(90, self.noise_floor * 3.0))
        release_threshold = max(65, onset_threshold * 0.68)
        if not self.active:
            is_speech = level >= onset_threshold
            self.onset_frames.append((pcm, is_speech))
            if sum(is_speech for _, is_speech in self.onset_frames) >= 3:
                self.active = True
                self.buffer.extend(b''.join(self.pre_roll))
                self.buffer.extend(b''.join(frame for frame, _ in self.onset_frames))
                self.voiced = sum(len(frame) for frame, is_speech in self.onset_frames if is_speech)
                self.onset_frames.clear()
                self.silence = 0
            else:
                if not is_speech:
                    self.pre_roll.append(pcm)
                    self.noise_floor = self.noise_floor * .98 + level * .02
        elif level >= release_threshold:
            self.voiced += len(pcm)
            self.silence = 0
            self.buffer.extend(pcm)
        else:
            self.silence += len(pcm)
            self.buffer.extend(pcm)
        if self.active and (self.silence >= self.silence_bytes or len(self.buffer) >= self.max_bytes):
            return self.flush()

    def flush(self):
        raw = bytes(self.buffer) if self.voiced >= 6400 else None
        self.buffer.clear()
        self.silence = self.voiced = 0
        self.active = False
        self.onset_frames.clear()
        self.pre_roll.clear()
        if raw:
            output = io.BytesIO()
            with wave.open(output, 'wb') as stream:
                stream.setnchannels(1)
                stream.setsampwidth(2)
                stream.setframerate(16000)
                stream.writeframes(raw)
            return output.getvalue()


class LiveKitTransport:
    def __init__(self, settings, service):
        self.settings, self.service = settings, service
        self.sessions = {}
        self.start_lock = asyncio.Lock()
        self.attempts = {}

    @property
    def configured(self):
        return bool(self.settings.livekit_url and self.settings.livekit_api_key and self.settings.livekit_api_secret)

    def config(self):
        import os
        s = self.settings
        return {'configured': self.configured, 'provider': 'LiveKit', 'url': s.livekit_url,
                'setup_available': s.environment == 'local' and os.name == 'nt',
                'local_server': s.livekit_url.startswith(('ws://localhost:', 'ws://127.0.0.1:')),
                'transcription_model': s.active_live_transcription_model,
                'checks': {'LiveKit address': bool(s.livekit_url), 'API credentials': bool(s.livekit_api_key and s.livekit_api_secret)},
                'customer_url': '/support'}

    @staticmethod
    def room_name(call_id):
        return 'resolveai-' + call_id.lower()

    @staticmethod
    def tech_identity(call):
        return f"technician:{call['technician_id']}:{call['dispatch_id']}"

    def token(self, call_id, identity, name, role='customer'):
        # A technician initially has no media access. It is enabled only after the
        # server confirms the current offer and their actual room membership.
        allowed = role != 'technician'
        grants = api.VideoGrants(room_join=True, room=self.room_name(call_id), can_publish=allowed,
            can_subscribe=allowed, can_publish_data=role == 'agent', can_publish_sources=['microphone'],
            can_update_own_metadata=False, agent=role == 'agent')
        return (api.AccessToken(self.settings.livekit_api_key, self.settings.livekit_api_secret)
                .with_identity(identity).with_name(name).with_ttl(timedelta(seconds=60 if role == 'technician' else 300))
                .with_grants(grants).to_jwt())

    def connection(self, call, identity, name, role):
        return {'url': self.settings.livekit_url, 'room': self.room_name(call['id']),
                'identity': identity, 'token': self.token(call['id'], identity, name, role)}

    async def start(self, caller, language, client_ip, customer_id=''):
        async with self.start_lock:
            await check_connection(self.settings)
            if not self.service.has_users():
                raise HTTPException(503, 'The support team has not finished setting up this workspace.')
            now = time.time()
            self.attempts = {ip: [t for t in times if now - t < 600] for ip, times in self.attempts.items() if any(now - t < 600 for t in times)}
            times = self.attempts.setdefault(client_ip, [])
            if len(times) >= 5:
                raise HTTPException(429, 'Please wait a few minutes before starting another call.')
            if len(self.sessions) >= self.settings.livekit_max_calls:
                raise HTTPException(429, 'All support lines are busy. Please try again shortly.')
            times.append(now)
            call = await asyncio.to_thread(self.service.create_call, caller, 'browser', None, language, customer_id)
            secret = secrets.token_urlsafe(32)
            await asyncio.to_thread(self.service.repository.mutate,
                lambda db: db['calls'][call['id']].update(customer_token_hash=hashlib.sha256(secret.encode()).hexdigest()))
            session = BrowserSession(self, call['id'])
            self.sessions[call['id']] = session
            try:
                async with livekit_client(self.settings) as client:
                    await client.room.create_room(api.CreateRoomRequest(name=self.room_name(call['id']), max_participants=3,
                        empty_timeout=60, departure_timeout=20))
                await session.connect()
            except Exception:
                await self.end(call['id'], 'Failed')
                raise HTTPException(502, 'The voice connection could not start. Check that LiveKit is running and try again.') from None
            return {'call_id': call['id'], 'access_token': secret,
                    **self.connection(call, f"customer:{call['id']}", caller, 'customer')}

    def customer_call(self, call_id, secret):
        call = self.service.get(call_id)
        expected = call.get('customer_token_hash', '')
        if not secret or not expected or not hmac.compare_digest(hashlib.sha256(secret.encode()).hexdigest(), expected):
            raise HTTPException(403, 'This call belongs to another customer.')
        return call

    @staticmethod
    def customer_status(call):
        return {
            key: call.get(key) for key in ('id', 'status', 'technician_name', 'last_error')
        } | {
            # The short-lived support token is scoped to this customer's call.
            # Return only their own transcript so the portal can show live captions.
            'transcript': [
                {key: turn.get(key) for key in ('speaker', 'text', 'timestamp')}
                | {'text': str(turn.get('text') or '')[:2000]}
                for turn in call.get('transcript', [])[-30:]
            ],
        }

    def offer(self, call_id, actor, call=None):
        call = call if call is not None else self.service.get(call_id)
        if call['origin'] != 'browser' or call['technician_id'] != actor['id']:
            raise HTTPException(403, 'This call is assigned to another technician.')
        if call['status'] != 'Ringing' or call['reserved_until'] <= self.service.now():
            raise HTTPException(409, 'This call offer has expired.')
        return self.connection(call, self.tech_identity(call), actor['name'], 'technician')

    async def confirm_join(self, call_id, actor):
        started = time.monotonic()
        call = await asyncio.to_thread(self.service.get, call_id)
        self.offer(call_id, actor, call)
        identity = self.tech_identity(call)
        try:
            async with livekit_client(self.settings) as client:
                members = await client.room.list_participants(api.ListParticipantsRequest(room=self.room_name(call_id)))
                if not any(p.identity == identity for p in members.participants):
                    raise HTTPException(409, 'The browser has not joined the call yet. Please retry.')
                connected = await asyncio.to_thread(self.service.accept, call_id, actor['id'], call['dispatch_id'])
                await client.room.update_participant(api.UpdateParticipantRequest(room=self.room_name(call_id), identity=identity,
                    permission=api.ParticipantPermission(can_publish=True, can_subscribe=True, can_publish_data=False,
                        can_publish_sources=[api.TrackSource.MICROPHONE])))
                session = self.sessions.get(call_id)
                if session:
                    session.interrupt()
                logging.getLogger('uvicorn.error.voice').info('Call pickup confirmed call=%s duration_ms=%.0f', call_id, (time.monotonic()-started)*1000)
                return connected
        except HTTPException:
            raise
        except Exception:
            try:
                await self.remove_technician(call)
            except Exception:
                pass
            def requeue(db):
                current = db['calls'][call_id]
                if current['status'] == 'Connected' and current['dispatch_id'] == call['dispatch_id']:
                    self.service._release(db, current, 'Could not enable technician audio. Requeued.', away=True)
            await asyncio.to_thread(self.service.repository.mutate, requeue)
            raise HTTPException(502, 'Could not connect your microphone to the customer. Please retry.') from None

    async def remove_technician(self, call):
        if not call.get('technician_id'):
            return
        try:
            async with livekit_client(self.settings) as client:
                identity = self.tech_identity(call)
                await client.room.update_participant(api.UpdateParticipantRequest(room=self.room_name(call['id']), identity=identity,
                    permission=api.ParticipantPermission(can_publish=False, can_subscribe=False, can_publish_data=False)))
                await client.room.remove_participant(api.RoomParticipantIdentity(room=self.room_name(call['id']), identity=identity))
        except api.TwirpError as error:
            if error.code != 'not_found':
                raise

    async def end(self, call_id, status='Completed'):
        session = self.sessions.pop(call_id, None)
        if session:
            await session.close()
        try:
            async with livekit_client(self.settings) as client:
                await client.room.delete_room(api.DeleteRoomRequest(room=self.room_name(call_id)))
        except Exception:
            pass  # Local RTC peers are closed even if the provider is unreachable.
        return await asyncio.to_thread(self.service.finish, call_id, status)

    async def maintenance(self):
        await asyncio.to_thread(self.service.dispatch)
        for call_id, session in list(self.sessions.items()):
            if session.finalizing:
                continue
            call = await asyncio.to_thread(self.service.get, call_id)
            now = time.time()
            if call['status'] in TERMINAL:
                await self.end(call_id, call['status'])
            elif now - session.started_at > self.settings.livekit_max_call_seconds:
                await self.end(call_id)
            elif not session.customer_seen and now - session.started_at > 45:
                await self.end(call_id, 'Failed')
            elif session.customer_left_at and now - session.customer_left_at > 10:
                await self.end(call_id)
            else:
                for identity in list(session.room.remote_participants):
                    if identity.startswith('technician:'):
                        await session.validate_technician(identity)

    async def close(self):
        for call_id in list(self.sessions):
            await self.end(call_id)


class BrowserSession:
    def __init__(self, transport, call_id):
        self.transport, self.service, self.call_id = transport, transport.service, call_id
        self.room = rtc.Room()
        self.source = None
        self.tasks = set()
        self.streams = set()
        self.queue = asyncio.Queue(maxsize=12)
        self.responses = asyncio.Queue(maxsize=24)
        self.turn_revision = 0
        self.caption_interruptions = set()
        self.recognition_tasks = set()
        self.call_state = None
        self.streaming_speech = None
        self.use_streaming = transport.settings.streaming_transcription_enabled
        self.speech_task = None
        self.closed = False
        self.finalizing = False
        self.customer_seen = False
        self.customer_left_at = None
        self.started_at = time.time()
        self.speech_lock = asyncio.Lock()
        self.knowledge_task = None
        self.knowledge_pending = False

    def request_knowledge(self):
        self.knowledge_pending = True
        if not self.knowledge_task or self.knowledge_task.done():
            self.knowledge_task = self.task(self.refresh_knowledge())

    async def refresh_knowledge(self):
        # Coalesce speech bursts; embeddings must never delay transcription or voice replies.
        while self.knowledge_pending and not self.closed:
            await asyncio.sleep(0.5)
            self.knowledge_pending = False
            await asyncio.to_thread(self.service.refresh_knowledge, self.call_id)

    def task(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        def consume_error(done):
            if not done.cancelled():
                error = done.exception()
                if error and not self.closed:
                    code = getattr(error, 'code', None)
                    safe_code = code if isinstance(code, (str, int)) else 'unknown'
                    detail = _safe_provider_error(error)
                    logging.getLogger('uvicorn.error.voice').error('Call worker failed (%s; provider code %s): %s', type(error).__name__, safe_code, detail)
                    self.service.error(self.call_id, 'ResolveAI could not produce a voice response. The call is being routed to a technician.')
                    self.task(self.recover_voice_failure())
        task.add_done_callback(consume_error)
        return task

    async def recover_voice_failure(self):
        call = await asyncio.to_thread(self.service.get, self.call_id)
        if call['status'] in {'Triage', 'AI'}:
            await self.escalate('Voice assistant unavailable')

    async def connect(self):
        @self.room.on('track_subscribed')
        def subscribed(track, publication, participant):
            if track.kind == rtc.TrackKind.KIND_AUDIO:
                self.task(self.listen(track, participant.identity))

        @self.room.on('track_subscription_failed')
        def subscription_failed(*args):
            self.service.error(self.call_id, 'Could not receive microphone audio. Restart your microphone to reconnect it.')

        @self.room.on('participant_connected')
        def joined(participant):
            if participant.identity == f'customer:{self.call_id}':
                first = not self.customer_seen
                self.customer_seen, self.customer_left_at = True, None
                if first:
                    self.task(self.say('Welcome to ResolveAI. This call is transcribed. Please describe the issue you are having.'))
            elif participant.identity.startswith('technician:'):
                self.task(self.validate_technician(participant.identity))

        @self.room.on('participant_disconnected')
        def left(participant):
            if participant.identity == f'customer:{self.call_id}':
                self.customer_left_at = time.time()
            elif participant.identity.startswith('technician:'):
                self.task(self.technician_left(participant.identity))

        @self.room.on('disconnected')
        def disconnected(reason):
            if not self.closed:
                self.task(asyncio.to_thread(self.service.error, self.call_id, 'Voice connection interrupted. Please start a new call.'))
                self.task(asyncio.to_thread(self.service.finish, self.call_id, 'Failed'))

        token = self.transport.token(self.call_id, f'agent:{self.call_id}', 'ResolveAI', 'agent')
        await asyncio.wait_for(self.room.connect(self.transport.settings.livekit_url, token), 20)
        self.source = rtc.AudioSource(24000, 1)
        track = rtc.LocalAudioTrack.create_audio_track('ResolveAI voice', self.source)
        await self.room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        self.call_state = await asyncio.to_thread(self.service.get, self.call_id)
        self.task(self.watch_call())
        self.task(self.process())
        self.task(self.process_responses())

    async def validate_technician(self, identity):
        call = await asyncio.to_thread(self.service.get, self.call_id)
        valid = identity == self.transport.tech_identity(call) and (call['status'] == 'Connected' or
            call['status'] == 'Ringing' and call['reserved_until'] > self.service.now())
        if not valid:
            async with livekit_client(self.transport.settings) as client:
                await client.room.remove_participant(api.RoomParticipantIdentity(room=self.transport.room_name(self.call_id), identity=identity))

    async def technician_left(self, identity):
        await asyncio.sleep(8)
        if self.closed or identity in self.room.remote_participants:
            return
        call = self.service.get(self.call_id)
        if call['status'] == 'Connected' and identity == self.transport.tech_identity(call):
            def requeue(db):
                current = db['calls'][self.call_id]
                if current['status'] == 'Connected' and identity == self.transport.tech_identity(current):
                    self.service._release(db, current, 'Technician disconnected. Requeued.', away=True)
            await asyncio.to_thread(self.service.repository.mutate, requeue)

    def interrupt(self):
        if self.speech_task and not self.speech_task.done():
            self.speech_task.cancel()
        if self.source:
            self.source.clear_queue()

    async def watch_call(self):
        while not self.closed:
            self.call_state = await asyncio.to_thread(self.service.get, self.call_id)
            await asyncio.sleep(0.5)

    async def caption(self, speaker, text, segment, final=False):
        # Acoustic activity can be a fan, echo or a click. Only recognized words
        # should interrupt playback, once per segment (not on every audio frame).
        if speaker == 'Customer' and text.strip() and not final and segment not in self.caption_interruptions:
            self.caption_interruptions.add(segment)
            self.interrupt()
        try:
            await self.room.local_participant.publish_data(json.dumps({
                'speaker': speaker, 'text': text[:4000], 'segment': segment, 'final': final,
            }), reliable=True, topic='resolveai.caption')
        except Exception:
            # Captions are supplementary; transcript storage must still succeed.
            logging.getLogger('uvicorn.error.voice').debug('Caption delivery unavailable call=%s', self.call_id)

    async def stream_segment(self, queue, speaker, identity, previous, segment):
        started = time.monotonic()
        try:
            if self.streaming_speech is None:
                from realapp.streaming_speech import GoogleStreamingSpeech
                self.streaming_speech = GoogleStreamingSpeech(self.transport.settings)
            text = await self.streaming_speech.transcribe(queue,
                lambda text: self.caption(speaker, text, segment))
            if previous:
                await asyncio.shield(previous)
            call = await asyncio.to_thread(self.service.get, self.call_id)
            # A former technician cannot append speech after reassignment.
            if speaker == 'Technician' and identity != self.transport.tech_identity(call):
                return
            if text:
                await self.record_text(speaker, text)
                await self.caption(speaker, text, segment, final=True)
            logging.getLogger('uvicorn.error.voice').info('Streaming STT call=%s speaker=%s duration_ms=%.0f',
                self.call_id, speaker, (time.monotonic()-started)*1000)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logging.getLogger('uvicorn.error.voice').warning('Streaming STT failed call=%s type=%s: %s',
                self.call_id, type(error).__name__, _safe_provider_error(error))
            await asyncio.to_thread(self.service.error, self.call_id,
                'Live transcription is unavailable. Check the Speech-to-Text API, speech.client permission and speech region. Voice audio is still connected.')
        finally:
            self.caption_interruptions.discard(segment)

    async def listen(self, track, identity):
        stream = rtc.AudioStream(track, sample_rate=16000, num_channels=1, frame_size_ms=20)
        self.streams.add(stream)
        settings = self.transport.settings
        detector = AudioTurns(settings.voice_activity_threshold, settings.voice_silence_ms, settings.voice_max_segment_seconds)
        segment_queue, previous = None, None
        try:
            async for event in stream:
                if self.closed:
                    break
                call = self.call_state
                if not call:
                    continue
                customer = identity == f'customer:{self.call_id}'
                technician = call['status'] == 'Connected' and identity == self.transport.tech_identity(call)
                if not customer and not technician:
                    continue
                speaker = 'Customer' if customer else 'Technician'
                pcm = bytes(event.frame.data)
                was_active = detector.active
                chunk = detector.feed(pcm)
                if self.use_streaming:
                    if segment_queue is None and detector.active and detector.voiced >= 6400:
                        segment_queue = asyncio.Queue(maxsize=650)
                        segment_queue.put_nowait(bytes(detector.buffer))
                        previous = self.task(self.stream_segment(segment_queue, speaker, identity, previous, secrets.token_hex(8)))
                        self.recognition_tasks.add(previous)
                        previous.add_done_callback(self.recognition_tasks.discard)
                    elif segment_queue is not None:
                        segment_queue.put_nowait(pcm)
                    if was_active and not detector.active and segment_queue is not None:
                        segment_queue.put_nowait(None)
                        segment_queue = None
                elif chunk:
                    try:
                        self.queue.put_nowait((speaker, chunk))
                    except asyncio.QueueFull:
                        self.service.error(self.call_id, 'Transcription is falling behind. Please pause between sentences.')
        finally:
            if segment_queue is not None:
                segment_queue.put_nowait(None)
            self.streams.discard(stream)
            await stream.aclose()

    async def say(self, text):
        async with self.speech_lock:
            if self.closed:
                return
            async def publish():
                started, recorded = time.monotonic(), False
                async def audio():
                    if hasattr(self.service.engine, 'synthesize_stream'):
                        async for pcm in self.service.engine.synthesize_stream(text):
                            yield pcm
                    else:
                        yield await asyncio.to_thread(self.service.engine.synthesize, text)
                async for pcm in audio():
                    if not pcm:
                        continue
                    if not recorded:
                        recorded = True
                        logging.getLogger('uvicorn.error.voice').info('Speech first audio call=%s duration_ms=%.0f', self.call_id, (time.monotonic()-started)*1000)
                        await asyncio.to_thread(self.service.add_turn, self.call_id, 'AI Agent', text)
                    for start in range(0, len(pcm), 960):
                        chunk = pcm[start:start + 960]
                        if len(chunk) % 2:
                            chunk = chunk[:-1]
                        if chunk:
                            await self.source.capture_frame(rtc.AudioFrame(chunk, 24000, 1, len(chunk) // 2))
                if not recorded:
                    raise RuntimeError('Speech synthesis returned empty audio.')
                await self.source.wait_for_playout()
            self.speech_task = asyncio.create_task(publish())
            try:
                await self.speech_task
            except asyncio.CancelledError:
                if self.closed:
                    raise
                return False
            return True

    async def escalate(self, reason):
        call = self.service.get(self.call_id)
        if call['status'] in TERMINAL:
            return
        await asyncio.to_thread(self.service.enqueue, self.call_id, reason)
        try:
            await self.say('I am connecting you to an available technician. Please stay on the call.')
        except Exception:
            self.service.error(self.call_id, 'Audio replies are unavailable. Your request is in the technician queue.')
        await asyncio.to_thread(self.service.mark_waiting, self.call_id)

    async def process_utterance(self, speaker, chunk, wait_response=True):
        if chunk is None:
            await asyncio.to_thread(self.service.add_turn, self.call_id, 'Customer', 'Please connect me with a technician.')
            if wait_response:
                await self.escalate('Customer requested a technician')
            else:
                await self.responses.put(('escalate', self.turn_revision))
            return
        started = time.monotonic()
        text = await asyncio.to_thread(self.service.engine.transcribe, 'utterance.wav', chunk)
        logging.getLogger('uvicorn.error.voice').info('Batch STT call=%s duration_ms=%.0f', self.call_id, (time.monotonic()-started)*1000)
        await self.record_text(speaker, text, wait_response)

    async def record_text(self, speaker, text, wait_response=False):
        if not text.strip():
            return
        call = await asyncio.to_thread(self.service.add_turn, self.call_id, speaker, text)
        if self.closed:
            return
        if speaker == 'Customer' and call['status'] not in TERMINAL:
            self.interrupt()
            if call['status'] in {'Connected', 'Ringing', 'Queued'}:
                self.request_knowledge()
            self.turn_revision += 1
        if speaker != 'Customer' or call['status'] in TERMINAL | {'Connected', 'Ringing', 'Queued'}:
            return
        if wait_response:
            await self.respond(self.turn_revision)
        else:
            # One worker handles reasoning/playback; STT continues independently.
            if self.responses.full():
                self.responses.get_nowait()
                self.responses.task_done()
            self.responses.put_nowait(('respond', self.turn_revision))

    async def process_responses(self):
        while not self.closed:
            action, revision = await self.responses.get()
            try:
                if action == 'escalate':
                    await self.escalate('Customer requested a technician')
                elif revision == self.turn_revision:
                    await self.respond(revision)
            finally:
                self.responses.task_done()

    async def respond(self, revision):
        started = time.monotonic()
        call = await asyncio.to_thread(self.service.get, self.call_id)
        if call['status'] in TERMINAL | {'Connected', 'Ringing', 'Queued'}:
            return
        if call['status'] == 'Queued':
            await self.escalate('Technician assistance required')
        elif call['status'] in {'Triage', 'AI'}:
            if revision != self.turn_revision:
                return
            reply = await asyncio.to_thread(self.service.reply, self.call_id)
            # Finish recognition already in flight before speaking. Empty/noise
            # segments leave this answer valid; a new customer turn supersedes it
            # and already has its own response queued by record_text.
            pending = [task for task in self.recognition_tasks if not task.done()]
            if pending:
                await asyncio.gather(*(asyncio.shield(task) for task in pending), return_exceptions=True)
            current = await asyncio.to_thread(self.service.get, self.call_id)
            if current['status'] != 'AI' or revision != self.turn_revision:
                logging.getLogger('uvicorn.error.voice').info('Voice reply superseded call=%s revision=%s', self.call_id, revision)
                return
            logging.getLogger('uvicorn.error.voice').info('Voice reply ready call=%s revision=%s duration_ms=%.0f',
                self.call_id, revision, (time.monotonic()-started)*1000)
            if reply.escalate:
                await self.escalate('AI requested technician assistance')
                return
            if reply.customer_confirmed_resolved and not reply.escalate:
                customer_turn = next((t for t in reversed(current['transcript']) if t['speaker'] == 'Customer'), None)
                await asyncio.to_thread(self.service.confirm_ai_resolution, self.call_id, customer_turn)
            if await self.say(reply.reply) is False:
                return
            current = await asyncio.to_thread(self.service.get, self.call_id)
            if current['status'] != 'AI' or revision != self.turn_revision:
                return
            if reply.customer_confirmed_resolved:
                self.finalizing = True
                try:
                    await asyncio.to_thread(self.service.finish, self.call_id)
                finally:
                    self.finalizing = False

    async def process(self):
        while not self.closed:
            speaker, chunk = await self.queue.get()
            try:
                await self.process_utterance(speaker, chunk, wait_response=False)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                code = getattr(error, 'code', None)
                safe_code = code if isinstance(code, (str, int)) else 'unknown'
                detail = _safe_provider_error(error)
                logging.getLogger('uvicorn.error.voice').error('Voice turn failed (%s; provider code %s): %s', type(error).__name__, safe_code, detail)
                self.service.error(self.call_id, 'ResolveAI could not process or speak that turn. The request is retained for technician assistance.')
                call = self.service.get(self.call_id)
                if call['status'] in {'Triage', 'AI'}:
                    try:
                        await self.escalate('Voice assistant unavailable')
                    except Exception:
                        self.service.error(self.call_id, 'Could not route the call. Please try again or create an incident.')
            finally:
                self.queue.task_done()

    async def close(self):
        self.closed = True
        self.interrupt()
        current = asyncio.current_task()
        tasks = [task for task in self.tasks if task is not current and task not in self.recognition_tasks]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.recognition_tasks:
            # Capture cancellation closes the input streams. Keep their final words
            # before finish() generates the incident from the conversation.
            pending = asyncio.gather(*list(self.recognition_tasks), return_exceptions=True)
            try:
                await asyncio.wait_for(pending, timeout=8)
            except asyncio.TimeoutError:
                await asyncio.to_thread(self.service.error, self.call_id, 'The final transcript segment timed out during hang-up.')
        if self.streaming_speech:
            await self.streaming_speech.close()
        await self.room.disconnect()
        if self.source:
            await self.source.aclose()
