from typing import Any, Literal
from pydantic import BaseModel, Field


class TranscriptLine(BaseModel):
    speaker: str
    text: str
    timestamp: str = "00:00"


class IssueUnderstanding(BaseModel):
    service: str
    problem: str
    symptoms: list[str]
    actions_tried: list[str]
    users_affected: str
    business_impact: str
    urgency_signal: str


class RoutingDecision(BaseModel):
    handler: Literal["AI", "HUMAN"]
    complexity: Literal["simple", "medium", "complex"]
    confidence: float = Field(ge=0, le=1)
    risk: Literal["low", "medium", "high"]
    reason: str
    policy: str


class KnowledgeMatch(BaseModel):
    id: str
    title: str
    score: float = Field(ge=0, le=1)
    reason: str
    steps: list[str]


class TicketField(BaseModel):
    value: str
    confidence: float = Field(ge=0, le=1)


class Ticket(BaseModel):
    id: str
    short_description: TicketField
    description: TicketField
    service: TicketField
    category: TicketField
    subcategory: TicketField
    impact: TicketField
    urgency: TicketField
    priority: TicketField
    assignment_group: TicketField
    resolution_notes: TicketField
    resolution_code: TicketField
    status: str = "New"


class TicketDraft(BaseModel):
    short_description: TicketField
    description: TicketField
    service: TicketField
    category: TicketField
    subcategory: TicketField
    impact: TicketField
    urgency: TicketField
    priority: TicketField
    assignment_group: TicketField
    resolution_notes: TicketField
    resolution_code: TicketField
    status: str = "New"


class QACheck(BaseModel):
    field: str
    current: str
    recommended: str
    status: Literal["PASS", "FAIL", "REVIEW"]
    confidence: float = Field(ge=0, le=1)
    reason: str
    evidence: str


class AnalysisPayload(BaseModel):
    issue_title: str
    status: str
    handler_label: str
    understanding: IssueUnderstanding
    routing: RoutingDecision
    next_question: str
    recommended_action: str
    ticket: TicketDraft


class QAAuditPayload(BaseModel):
    checks: list[QACheck]
    quality_score: int = Field(ge=0, le=100)


class CaseResult(BaseModel):
    case_id: str
    scenario: str
    status: str
    handler_label: str
    transcript: list[TranscriptLine]
    understanding: IssueUnderstanding
    routing: RoutingDecision
    next_question: str
    recommended_action: str
    knowledge: list[KnowledgeMatch]
    ticket: Ticket
    qa: list[QACheck]
    quality_score: int = Field(ge=0, le=100)
    source: str
    warnings: list[str] = Field(default_factory=list)


class AnalyzeRequest(BaseModel):
    transcript: str = Field(min_length=10, max_length=25000)
    scenario: str | None = None


class TicketUpdate(BaseModel):
    fields: dict[str, str]


class KnowledgeArticleInput(BaseModel):
    id: str = Field(min_length=2, max_length=50)
    title: str = Field(min_length=3, max_length=200)
    product: str = Field(min_length=2, max_length=100)
    symptoms: list[str] = Field(min_length=1)
    steps: list[str] = Field(min_length=1)
    resolution: str = Field(min_length=3, max_length=2000)
    tags: list[str] = Field(default_factory=list)


class Overview(BaseModel):
    active_cases: int
    ai_containment_rate: int
    average_resolution_minutes: int
    qa_pass_rate: int
    volume_by_theme: list[dict[str, Any]]
    recent_cases: list[dict[str, Any]]
