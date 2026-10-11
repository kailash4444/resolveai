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
from datetime import timedelta

from fastapi import HTTPException
from livekit import api, rtc

from realapp.calling import TERMINAL
from realapp.livekit_setup import check_connection, livekit_client


class AudioTurns:
    """Bound 16-bit, 16 kHz mono utterances by silence and duration."""
    def __init__(self, threshold=450):
        self.threshold, self.buffer, self.silence, self.voiced = threshold, bytearray(), 0, 0
        self.noise_floor = 30.0

    def feed(self, pcm):
        level = audioop.rms(pcm, 2)
        # Adapt to quiet microphones instead of dropping everything below a fixed
        # loudness threshold. Only learn background noise between utterances.
        threshold = min(self.threshold, max(90, self.noise_floor * 3))
        speech = level >= threshold
        if not speech and not self.buffer:
            self.noise_floor = self.noise_floor * .95 + level * .05
        if speech:
            self.voiced += len(pcm)
            self.silence = 0
        elif self.buffer:
            self.silence += len(pcm)
        if speech or self.buffer:
            self.buffer.extend(pcm)
        if self.buffer and (self.silence >= 22400 or len(self.buffer) >= 384000):
            return self.flush()

    def flush(self):
        raw = bytes(self.buffer) if self.voiced >= 6400 else None
        self.buffer.clear()
        self.silence = self.voiced = 0
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
        self.resolve = None

    @property
    def configured(self):
        return bool(self.settings.livekit_url and self.settings.livekit_api_key and self.settings.livekit_api_secret)

    def config(self):
        import os
        s = self.settings
        return {'configured': self.configured, 'provider': 'LiveKit', 'url': s.livekit_url,
                'setup_available': s.environment == 'local' and os.name == 'nt',
                'local_server': s.livekit_url.startswith(('ws://localhost:', 'ws://127.0.0.1:')),
                'transcription_model': s.active_transcription_model,
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
            can_subscribe=allowed, can_publish_data=False, can_publish_sources=['microphone'],
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
        return {key: call.get(key) for key in ('id', 'status', 'technician_name', 'last_error')}

    def offer(self, call_id, actor):
        call = self.service.get(call_id)
        if call['origin'] != 'browser' or call['technician_id'] != actor['id']:
            raise HTTPException(403, 'This call is assigned to another technician.')
        if call['status'] != 'Ringing' or call['reserved_until'] <= self.service.now():
            raise HTTPException(409, 'This call offer has expired.')
        return self.connection(call, self.tech_identity(call), actor['name'], 'technician')

    async def confirm_join(self, call_id, actor):
        call = self.service.get(call_id)
        self.offer(call_id, actor)
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
        call = await asyncio.to_thread(self.service.finish, call_id, status)
        session = self.sessions.pop(call_id, None)
        if session:
            await session.close()
        try:
            async with livekit_client(self.settings) as client:
                await client.room.delete_room(api.DeleteRoomRequest(room=self.room_name(call_id)))
        except Exception:
            pass  # Local RTC peers are closed even if the provider is unreachable.
        return call

    async def maintenance(self):
        await asyncio.to_thread(self.service.dispatch)
        for call_id, session in list(self.sessions.items()):
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
        self.speech_task = None
        self.closed = False
        self.customer_seen = False
        self.customer_left_at = None
        self.started_at = time.time()
        self.speech_lock = asyncio.Lock()

    def task(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        def consume_error(done):
            if not done.cancelled():
                error = done.exception()
                if error and not self.closed:
                    logging.getLogger(__name__).error('Call worker failed: %s', type(error).__name__)
                    self.service.error(self.call_id, 'Audio processing was interrupted. Restart your microphone or start a new call.')
        task.add_done_callback(consume_error)
        return task

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
                self.service.error(self.call_id, 'Voice connection interrupted. Please start a new call.')
                self.service.finish(self.call_id, 'Failed')

        token = self.transport.token(self.call_id, f'agent:{self.call_id}', 'ResolveAI', 'agent')
        await asyncio.wait_for(self.room.connect(self.transport.settings.livekit_url, token), 20)
        self.source = rtc.AudioSource(24000, 1)
        track = rtc.LocalAudioTrack.create_audio_track('ResolveAI voice', self.source)
        await self.room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        self.task(self.process())

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

    async def listen(self, track, identity):
        stream = rtc.AudioStream(track, sample_rate=16000, num_channels=1, frame_size_ms=20)
        self.streams.add(stream)
        detector = AudioTurns(self.transport.settings.voice_activity_threshold)
        call, checked_at = None, 0
        try:
            async for event in stream:
                if self.closed:
                    break
                if time.monotonic() - checked_at > 0.5:
                    call = await asyncio.to_thread(self.service.get, self.call_id)
                    checked_at = time.monotonic()
                customer = identity == f'customer:{self.call_id}'
                technician = call['status'] == 'Connected' and identity == self.transport.tech_identity(call)
                if not customer and not technician:
                    continue
                chunk = detector.feed(bytes(event.frame.data))
                if customer and detector.voiced >= 6400:
                    self.interrupt()
                if chunk:
                    try:
                        self.queue.put_nowait(('Customer' if customer else 'Technician', chunk))
                    except asyncio.QueueFull:
                        self.service.error(self.call_id, 'Transcription is falling behind. Please pause between sentences.')
        finally:
            self.streams.discard(stream)
            await stream.aclose()

    async def say(self, text):
        async with self.speech_lock:
            if self.closed:
                return
            self.service.add_turn(self.call_id, 'AI Agent', text)
            async def publish():
                pcm = await asyncio.to_thread(self.service.engine.synthesize, text)
                for start in range(0, len(pcm), 960):
                    chunk = pcm[start:start + 960]
                    if len(chunk) % 2:
                        chunk = chunk[:-1]
                    if chunk:
                        await self.source.capture_frame(rtc.AudioFrame(chunk, 24000, 1, len(chunk) // 2))
                await self.source.wait_for_playout()
            self.speech_task = asyncio.create_task(publish())
            try:
                await self.speech_task
            except asyncio.CancelledError:
                if self.closed:
                    raise

    async def escalate(self, reason):
        call = self.service.get(self.call_id)
        if call['status'] in TERMINAL:
            return
        if not call['case_id']:
            await asyncio.to_thread(self.service.triage, self.call_id)
        await asyncio.to_thread(self.service.enqueue, self.call_id, reason)
        try:
            await self.say('I am connecting you to an available technician. Please stay on the call.')
        except Exception:
            self.service.error(self.call_id, 'Audio replies are unavailable. Your request is in the technician queue.')
        await asyncio.to_thread(self.service.mark_waiting, self.call_id)

    async def process_utterance(self, speaker, chunk):
        if chunk is None:
            await asyncio.to_thread(self.service.add_turn, self.call_id, 'Customer', 'Please connect me with a technician.')
            await self.escalate('Customer requested a technician')
            return
        text = await asyncio.to_thread(self.service.engine.transcribe, 'utterance.wav', chunk)
        if not text.strip():
            return
        call = await asyncio.to_thread(self.service.add_turn, self.call_id, speaker, text)
        if speaker != 'Customer' or call['status'] in TERMINAL | {'Connected', 'Ringing', 'Queued'}:
            return
        if call['status'] == 'Triage':
            call = await asyncio.to_thread(self.service.triage, self.call_id)
        if call['status'] == 'Queued':
            await self.escalate('Technician assistance required')
        elif call['status'] == 'AI':
            reply = await asyncio.to_thread(self.service.reply, self.call_id)
            if self.service.get(self.call_id)['status'] != 'AI':
                return
            await self.say(reply.reply)
            if reply.escalate:
                await self.escalate('AI requested technician assistance')
            elif reply.customer_confirmed_resolved:
                if self.transport.resolve:
                    await self.transport.resolve(call, reply.reply)
                await asyncio.to_thread(self.service.finish, self.call_id)

    async def process(self):
        while not self.closed:
            speaker, chunk = await self.queue.get()
            try:
                await self.process_utterance(speaker, chunk)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.service.error(self.call_id, 'Voice processing failed. The request is retained for technician assistance.')
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
        tasks = [task for task in self.tasks if task is not current]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.room.disconnect()
        if self.source:
            await self.source.aclose()
