from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "ResolveAI"
    environment: str = "local"
    llm_provider: str = "google_ai"
    openai_api_key: str | None = None
    openai_model: str = "gpt-6-luna"
    transcription_model: str = "gpt-4o-mini-transcribe"
    openai_embedding_model: str = "text-embedding-3-small"
    gemini_provider: str = "google_ai"
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-3.8-flash"
    gemini_transcription_model: str = "gemini-3.5-transcribe"
    gemini_tts_model: str = "gemini-3.8-flash-lite-tts"
    gemini_voice: str = "Kore"
    embedding_model: str = "gemini-embedding-001"
    google_cloud_project: str | None = None
    google_cloud_location: str = "global"
    data_backend: str = "sqlite"
    local_data_path: str = "data/resolveai.sqlite3"
    attachment_bucket: str = ""
    calling_backend: str = "sqlite"
    calling_data_path: str = "data/calling.sqlite3"
    public_base_url: str = ""
    livekit_url: str = ""
    livekit_api_key: str = ""
    livekit_api_secret: str = ""
    livekit_max_calls: int = 5
    livekit_max_call_seconds: int = 1800
    admin_setup_token: str = ""
    voice_tts_model: str = "gpt-4o-mini-tts"
    voice_tts_voice: str = "coral"
    voice_activity_threshold: int = 450
    call_reservation_seconds: int = 25
    technician_heartbeat_seconds: int = 45
    call_queue_timeout_seconds: int = 300
    ai_routing_confidence: float = 0.85
    firestore_collection: str = "resolveai_cases"
    enable_demo_data: bool = False

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def active_transcription_model(self) -> str:
        return self.transcription_model if self.llm_provider in {'openai', 'mock'} else self.gemini_transcription_model

    @property
    def active_tts_model(self) -> str:
        return self.voice_tts_model if self.llm_provider in {'openai', 'mock'} else self.gemini_tts_model

    @property
    def gemini_configured(self) -> bool:
        if self.gemini_provider == "google_ai":
            return bool(self.gemini_api_key)
        if self.gemini_provider == "vertex":
            return bool(self.google_cloud_project)
        return self.gemini_provider == "mock"

    @property
    def provider_configured(self) -> bool:
        if self.llm_provider == "openai":
            return bool(self.openai_api_key)
        if self.llm_provider == "mock":
            return True
        return self.gemini_configured


@lru_cache
def get_settings() -> Settings:
    return Settings()
