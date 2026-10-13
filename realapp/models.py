from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


class TranscriptTurn(BaseModel):
    speaker: str
    speaker_name: str = ''
    text: str
    timestamp: str | None = None


class AnalysisRequest(BaseModel):
    transcript: str = Field(min_length=20)
    caller: str = "Customer"
    channel: str = "Voice"


class Understanding(BaseModel):
    summary: str
    intent: str
    product: str
    urgency: Literal["Low", "Medium", "High", "Critical"]
    sentiment: str
    entities: list[str] = []


class RoutingDecision(BaseModel):
    handler: Literal["AI", "Human"]
    confidence: float = Field(ge=0, le=1)
    risk: Literal["Low", "Medium", "High"]
    rationale: str


class KnowledgeContent(BaseModel):
    title: str = Field(min_length=3)
    product: str = Field(min_length=2)
    symptoms: str = Field(min_length=3)
    steps: list[str] = Field(min_length=1)
    resolution: str = Field(min_length=3)
    tags: list[str] = []


class KnowledgeArticleInput(KnowledgeContent):
    id: str | None = None
    source_ticket_ids: list[str] = Field(default_factory=list, max_length=20)


class KnowledgeFromIncidentsRequest(BaseModel):
    ticket_numbers: list[str] = Field(min_length=1, max_length=20)


class KnowledgeArticle(KnowledgeArticleInput):
    id: str


class KnowledgeMatch(BaseModel):
    id: str
    title: str
    score: float = Field(ge=0, le=1)
    excerpt: str
    steps: list[str] = []


class TicketDraft(BaseModel):
    short_description: str
    description: str
    category: str
    subcategory: str
    service: str
    priority: Literal["P1", "P2", "P3", "P4"]
    assignment_group: str
    state: Literal["New", "In Progress", "On Hold", "Resolved"] = "New"


class WorkNote(BaseModel):
    id: str
    author: str
    author_type: Literal["Technician", "Customer", "System"]
    text: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class WorkNoteCreate(BaseModel):
    # Legacy input accepted for old clients but never trusted for authorship.
    author: str = Field(default='', max_length=100)
    author_type: Literal["Technician", "Customer"] = 'Technician'
    text: str = Field(min_length=1, max_length=4000)


class Attachment(BaseModel):
    id: str
    filename: str
    content_type: str
    size_bytes: int
    url: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class VisualAnalysisPayload(BaseModel):
    analysis_source: str = "AI"
    visual_observations: str
    technical_diagnosis: str
    suggested_category: str = "Incident"
    suggested_subcategory: str = "Investigation"
    suggested_service: str = "General"
    suggested_priority: Literal["P1", "P2", "P3", "P4"] = "P3"
    recommended_action: str


class Ticket(TicketDraft):
    id: str
    assigned_to: str = ""
    assigned_user_id: str = ""
    call_id: str = ""
    resolution: str = ""
    work_notes: list[WorkNote] = Field(default_factory=list)
    attachments: list[Attachment] = Field(default_factory=list)


class QACheck(BaseModel):
    field: str
    result: Literal["PASS", "FAIL", "WARN"]
    observed: str
    recommended: str
    evidence: str


class AnalysisPayload(BaseModel):
    issue_title: str
    understanding: Understanding
    routing: RoutingDecision
    next_question: str
    recommended_action: str
    ticket: TicketDraft


class QAAuditPayload(BaseModel):
    checks: list[QACheck]
    quality_score: int = Field(ge=0, le=100)


class ScopedQACheck(QACheck):
    field: Literal['Short description', 'Description', 'Category / Subcategory', 'Service',
                   'Priority', 'Assignment group', 'Resolution', 'Work notes']


class ScopedQAAuditPayload(QAAuditPayload):
    checks: list[ScopedQACheck]


class CaseRecord(BaseModel):
    id: str
    demo_dataset: str = ''
    customer_id: str = ''
    created_by: str = ''
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    caller: str
    channel: str
    transcript: list[TranscriptTurn]
    issue_title: str
    status: str = "Open"
    handler_label: str
    understanding: Understanding
    routing: RoutingDecision
    knowledge_matches: list[KnowledgeMatch]
    next_question: str
    recommended_action: str
    ticket: Ticket
    qa_checks: list[QACheck]
    quality_score: int | None = None


class TicketUpdate(BaseModel):
    assigned_user_id: str | None = None
    assigned_to: str | None = None
    short_description: str | None = None
    description: str | None = None
    category: str | None = None
    subcategory: str | None = None
    service: str | None = None
    priority: Literal["P1", "P2", "P3", "P4"] | None = None
    assignment_group: str | None = None
    resolution: str | None = None
    state: Literal["New", "In Progress", "On Hold", "Resolved"] | None = None


class CustomerIncidentCreate(BaseModel):
    short_description: str = Field(min_length=3, max_length=200)
    description: str = Field(min_length=10, max_length=8000)
    service: str = Field(default='General', min_length=2, max_length=100)
