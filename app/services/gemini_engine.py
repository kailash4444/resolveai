import asyncio
import json

from app.config import Settings
from app.models import CaseResult
from app.services.knowledge import article_context
from app.services.mock_engine import analyze_mock


SYSTEM_PROMPT = """You are ResolveAI, an enterprise service-desk reasoning system.
Analyze the supplied support conversation. Decide whether the issue is authorized for an AI workflow or needs a human. Select relevant knowledge from the supplied catalog. Produce a structured ticket and independently audit the ticket fields.

Rules:
- AI may handle only low-risk, high-confidence password reset or account-unlock workflows after identity verification.
- Production outages, security issues, high-risk actions, and low-confidence cases are human-only.
- Impact represents scope of affected users; urgency represents time sensitivity.
- Every FAIL or REVIEW QA result must cite evidence from the conversation.
- Return valid JSON matching the supplied example shape. Do not add markdown.
"""


class GeminiEngine:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def analyze(self, transcript: str, scenario: str | None = None) -> CaseResult:
        if self.settings.gemini_provider == "mock":
            return analyze_mock(transcript, scenario)
        try:
            return await asyncio.to_thread(self._analyze_sync, transcript, scenario)
        except Exception as exc:
            if not self.settings.fallback_to_mock:
                raise
            result = analyze_mock(transcript, scenario)
            result.warnings.append(f"Gemini was unavailable; mock analysis used: {type(exc).__name__}")
            return result

    def _analyze_sync(self, transcript: str, scenario: str | None) -> CaseResult:
        from google import genai
        from google.genai import types

        if self.settings.gemini_provider == "vertex":
            if not self.settings.google_cloud_project:
                raise RuntimeError("GOOGLE_CLOUD_PROJECT is required for Vertex AI")
            client = genai.Client(vertexai=True, project=self.settings.google_cloud_project, location=self.settings.google_cloud_location)
        elif self.settings.gemini_provider == "google_ai":
            if not self.settings.gemini_api_key:
                raise RuntimeError("GEMINI_API_KEY is required for Google AI")
            client = genai.Client(api_key=self.settings.gemini_api_key)
        else:
            raise RuntimeError(f"Unsupported GEMINI_PROVIDER: {self.settings.gemini_provider}")

        example = analyze_mock(transcript, scenario).model_dump()
        example["source"] = self.settings.gemini_provider
        prompt = (
            SYSTEM_PROMPT
            + "\nKNOWLEDGE CATALOG:\n"
            + article_context()
            + "\n\nCONVERSATION:\n"
            + transcript
            + "\n\nJSON SHAPE EXAMPLE (replace all values with your analysis):\n"
            + json.dumps(example)
        )
        response = client.models.generate_content(
            model=self.settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.2),
        )
        data = json.loads(response.text)
        data["source"] = self.settings.gemini_provider
        return CaseResult.model_validate(data)
