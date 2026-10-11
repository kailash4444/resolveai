from dataclasses import dataclass
import os


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    app_name: str = os.getenv("APP_NAME", "ResolveAI")
    environment: str = os.getenv("ENVIRONMENT", "development")
    gemini_provider: str = os.getenv("GEMINI_PROVIDER", "google_ai")
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "gemini-embedding-001")
    gemini_api_key: str | None = os.getenv("GEMINI_API_KEY")
    google_cloud_project: str | None = os.getenv("GOOGLE_CLOUD_PROJECT")
    google_cloud_location: str = os.getenv("GOOGLE_CLOUD_LOCATION", "global")
    store_mode: str = os.getenv("STORE_MODE", "memory")
    firestore_collection: str = os.getenv("FIRESTORE_COLLECTION", "resolveai_cases")
    fallback_to_mock: bool = _bool("FALLBACK_TO_MOCK", False)
    enable_demo_data: bool = _bool("ENABLE_DEMO_DATA", False)


settings = Settings()
