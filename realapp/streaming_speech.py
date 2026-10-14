"""Google streaming STT for individual LiveKit microphone tracks (16 kHz PCM).

Audio enters the RPC while the speaker is talking. Short, bounded streams end at
utterance boundaries, so long calls never hit Google's stream-duration limit.
Speaker labels come from authenticated room identities, not inferred diarization.
"""
import asyncio


class GoogleStreamingSpeech:
    def __init__(self, settings, client=None):
        from google.cloud import speech_v2
        self.settings = settings
        self.client = client or speech_v2.SpeechAsyncClient(client_options={
            'api_endpoint': f'{settings.speech_location}-speech.googleapis.com',
            'quota_project_id': settings.google_cloud_project,
        })

    async def transcribe(self, queue, partial):
        from google.cloud.speech_v2.types import cloud_speech as stt
        s = self.settings
        async def requests():
            yield stt.StreamingRecognizeRequest(
                recognizer=f'projects/{s.google_cloud_project}/locations/{s.speech_location}/recognizers/_',
                streaming_config=stt.StreamingRecognitionConfig(
                    config=stt.RecognitionConfig(model=s.speech_model, language_codes=[s.speech_language],
                        explicit_decoding_config=stt.ExplicitDecodingConfig(
                            encoding=stt.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
                            sample_rate_hertz=16000, audio_channel_count=1)),
                    streaming_features=stt.StreamingRecognitionFeatures(interim_results=True,
                        endpointing_sensitivity=stt.StreamingRecognitionFeatures.EndpointingSensitivity.ENDPOINTING_SENSITIVITY_SHORT)))
            while True:
                chunk = await queue.get()
                if chunk is None:
                    break
                yield stt.StreamingRecognizeRequest(audio=chunk)
        responses = await self.client.streaming_recognize(requests=requests(), timeout=35)
        final = []
        try:
            async for response in responses:
                for result in response.results:
                    if not result.alternatives:
                        continue
                    text = result.alternatives[0].transcript.strip()
                    if result.is_final:
                        final.append(text)
                    await partial(' '.join(final + ([] if result.is_final else [text])))
        finally:
            # Closing/cancelling a call must also close the gRPC stream.
            cancel = getattr(responses, 'cancel', None)
            if cancel:
                cancel()
        return ' '.join(final).strip()

    async def close(self):
        await self.client.transport.close()
