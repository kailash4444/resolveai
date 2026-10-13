import io
import math
import re
from collections.abc import Callable
from uuid import uuid4

from realapp.config import Settings
from realapp.gemini import GeminiEngine
from realapp.knowledge import article_document
from realapp.incident_context import audit_ticket_json, KNOWLEDGE_PROMPT, AUDIT_PROMPT
from realapp.models import (
    AnalysisPayload,
    AnalysisRequest,
    CaseRecord,
    KnowledgeArticle,
    KnowledgeContent,
    KnowledgeMatch,
    QAAuditPayload,
    ScopedQAAuditPayload,
    QACheck,
    RoutingDecision,
    Ticket,
    TicketDraft,
    TranscriptTurn,
    Understanding,
)


def parse_transcript(raw: str) -> list[TranscriptTurn]:
    turns: list[TranscriptTurn] = []
    for line in (item.strip() for item in raw.splitlines() if item.strip()):
        match = re.match(r"(?:\[([^]]+)\]\s*)?([^:]{1,40}):\s*(.+)", line)
        if match:
            stamp, speaker, text = match.groups()
            named = re.fullmatch(r"(Technician|Customer)\s*\(([^)]+)\)", speaker.strip(), re.IGNORECASE)
            role = named.group(1).capitalize() if named else speaker.strip()
            name = named.group(2).strip() if named else ''
            turns.append(TranscriptTurn(speaker=role, speaker_name=name, text=text.strip(), timestamp=stamp))
        elif turns:
            turns[-1].text += f" {line}"
        else:
            turns.append(TranscriptTurn(speaker="Customer", text=line))
    return turns


def cosine(left: list[float], right: list[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right))
    norm = math.sqrt(sum(a * a for a in left)) * math.sqrt(sum(b * b for b in right))
    return dot / norm if norm else 0.0


class OpenAIEngine:
    def __init__(self, settings: Settings, knowledge_provider: Callable[[], list[KnowledgeArticle]]) -> None:
        self.settings = settings
        self.knowledge_provider = knowledge_provider
        self._runtime_api_key = settings.openai_api_key
        self._client = None
        self._document_vectors: dict[str, list[float]] = {}

    @property
    def configured(self) -> bool:
        return self.settings.llm_provider == "mock" or bool(self._runtime_api_key)

    def set_api_key(self, api_key: str) -> None:
        value = api_key.strip()
        if len(value) < 20:
            raise ValueError("The OpenAI API key appears incomplete.")
        self._runtime_api_key = value
        self._client = None

    def _client_or_raise(self):
        if self.settings.llm_provider == "mock":
            return None
        if not self._runtime_api_key:
            raise RuntimeError("OpenAI is not configured. Add your API key in ResolveAI settings or set OPENAI_API_KEY on the server.")
        if self._client is None:
            from openai import OpenAI

            self._client = OpenAI(api_key=self._runtime_api_key)
        return self._client

    def _embed(self, contents: list[str]) -> list[list[float]]:
        response = self._client_or_raise().embeddings.create(
            model=self.settings.openai_embedding_model,
            input=contents,
        )
        return [list(item.embedding) for item in response.data]

    def retrieve(self, transcript: str, limit: int = 3) -> list[KnowledgeMatch]:
        articles = self.knowledge_provider()
        if not articles:
            return []
        if self.settings.llm_provider == "mock":
            query_words = set(re.findall(r"[a-z0-9]+", transcript.lower()))
            ranked = []
            for article in articles:
                article_words = set(re.findall(r"[a-z0-9]+", article_document(article).lower()))
                ranked.append((len(query_words & article_words) / max(1, len(query_words | article_words)), article))
        else:
            missing = [article for article in articles if article.id not in self._document_vectors]
            if missing:
                vectors = self._embed([article_document(article) for article in missing])
                self._document_vectors.update({article.id: vector for article, vector in zip(missing, vectors)})
            query_vector = self._embed([transcript])[0]
            ranked = [(cosine(query_vector, self._document_vectors[article.id]), article) for article in articles]
        ranked.sort(key=lambda row: row[0], reverse=True)
        return [
            KnowledgeMatch(
                id=article.id,
                title=article.title,
                score=max(0.0, min(1.0, round(score, 3))),
                excerpt=article.symptoms,
                steps=article.steps,
            )
            for score, article in ranked[:limit]
        ]

    def _generate(self, system_prompt: str, user_prompt: str, schema):
        response = self._client_or_raise().responses.parse(
            model=self.settings.openai_model,
            input=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            text_format=schema,
            reasoning={"effort": "low"},
            store=False,
            timeout=45,
        )
        if response.output_parsed is None:
            raise RuntimeError("OpenAI returned no structured result.")
        return schema.model_validate(response.output_parsed)

    def analyze(self, request: AnalysisRequest) -> CaseRecord:
        matches = self.retrieve(request.transcript)
        if self.settings.llm_provider == "mock":
            payload = self._mock_analysis(request.transcript)
        else:
            knowledge = "\n\n".join(
                f"{match.id}: {match.title}\n{match.excerpt}\nSteps: {'; '.join(match.steps)}"
                for match in matches
            )
            payload = self._generate(
                "You are the decision engine for an enterprise IT service desk. Analyze the transcript, decide whether a safe routine request can be handled by AI or requires a human, and draft a ServiceNow-style incident. AI routing is allowed only for low-risk, high-confidence routine actions. The initial incident state must be New. Do not generate resolution information when creating the incident. Never claim an action was completed unless the transcript proves it. Use concise operational language.",
                f"TRANSCRIPT:\n{request.transcript}\n\nRETRIEVED KNOWLEDGE:\n{knowledge}",
                AnalysisPayload,
            )
        case = CaseRecord(
            id=f"CASE-{uuid4().hex[:8].upper()}",
            caller=request.caller,
            channel=request.channel,
            transcript=parse_transcript(request.transcript),
            issue_title=payload.issue_title,
            handler_label=f"{payload.routing.handler} handling",
            understanding=payload.understanding,
            routing=payload.routing,
            knowledge_matches=matches,
            next_question=payload.next_question,
            recommended_action=payload.recommended_action,
            ticket=Ticket(id=f"INC-{uuid4().hex[:8].upper()}", **payload.ticket.model_dump(), resolution="", work_notes=[]),
            qa_checks=[],
            quality_score=None,
        )
        return case

    def draft_knowledge(self, context: str) -> KnowledgeContent:
        return self._generate(KNOWLEDGE_PROMPT, context, KnowledgeContent)

    def audit(self, case: CaseRecord) -> QAAuditPayload:
        if case.ticket.state != "Resolved":
            raise RuntimeError("AI QA is available only after the ticket is resolved.")
        transcript = "\n".join(f"{turn.speaker}: {turn.text}" for turn in case.transcript)
        if self.settings.llm_provider == "mock":
            checks = [
                QACheck(field="Category / Subcategory", result="PASS", observed=f"{case.ticket.category} / {case.ticket.subcategory}", recommended="Use a consistent category and subcategory for the reported issue.", evidence=transcript[:220]),
                QACheck(field="Description", result="PASS" if len(case.ticket.description) >= 30 else "FAIL", observed=case.ticket.description, recommended="Include the issue, impact, and evidence.", evidence=transcript[:220]),
                QACheck(field="Priority", result="PASS", observed=case.ticket.priority, recommended=case.ticket.priority, evidence=f"Urgency: {case.understanding.urgency}"),
                QACheck(field="Resolution", result="WARN" if not case.ticket.resolution.strip() else "PASS", observed=case.ticket.resolution or "Empty", recommended="Record a verified outcome or state that work remains.", evidence=transcript[-220:]),
            ]
            penalty = sum(18 if check.result == "FAIL" else 7 if check.result == "WARN" else 0 for check in checks)
            return QAAuditPayload(checks=checks, quality_score=max(0, 100 - penalty))
        return self._generate(
            AUDIT_PROMPT,
            f"TRANSCRIPT:\n{transcript}\n\nTICKET:\n{audit_ticket_json(case.ticket)}",
            ScopedQAAuditPayload,
        )

    def transcribe(self, filename: str, content: bytes) -> str:
        audio = io.BytesIO(content)
        audio.name = filename or "recording.webm"
        response = self._client_or_raise().audio.transcriptions.create(
            model=self.settings.transcription_model,
            file=audio,
            response_format="json",
            timeout=25,
        )
        return response.text.strip()

    def synthesize(self, text: str) -> bytes:
        response = self._client_or_raise().audio.speech.create(
            model=self.settings.voice_tts_model, voice=self.settings.voice_tts_voice,
            input=text, response_format="pcm", timeout=25,
        )
        return response.content

    def _mock_analysis(self, transcript: str) -> AnalysisPayload:
        lower = transcript.lower()
        routine = any(term in lower for term in ["password", "locked account", "unlock"])
        title = "Account access request" if routine else "Enterprise support request"
        return AnalysisPayload(
            issue_title=title,
            understanding=Understanding(summary=transcript[:240], intent="Restore access" if routine else "Diagnose reported issue", product="Identity and Access Management" if routine else "Enterprise IT", urgency="Medium", sentiment="Frustrated" if "frustrat" in lower else "Neutral", entities=[]),
            routing=RoutingDecision(handler="AI" if routine else "Human", confidence=0.91 if routine else 0.72, risk="Low" if routine else "Medium", rationale="Routine access request with a defined verification workflow." if routine else "The issue requires diagnosis and human judgment."),
            next_question="Can you confirm your identity using the approved verification method?" if routine else "What exact error and business impact are you seeing?",
            recommended_action="Follow the retrieved knowledge steps and verify the outcome.",
            ticket=TicketDraft(short_description=title, description=transcript[:500], category="Access" if routine else "Incident", subcategory="Account" if routine else "Investigation", service="Identity" if routine else "Enterprise IT", priority="P3", assignment_group="Service Desk", state="New"),
        )


def create_engine(settings: Settings, knowledge_provider: Callable[[], list[KnowledgeArticle]]):
    if settings.llm_provider in {"openai", "mock"}:
        return OpenAIEngine(settings, knowledge_provider)
    settings.gemini_provider = settings.llm_provider
    return GeminiEngine(settings, knowledge_provider)
