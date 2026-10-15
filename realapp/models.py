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


class KnowledgeCoverage(BaseModel):
    article_id: str | None = None
    confidence: float = Field(ge=0, le=1)
    reason: str


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


class ImageFinding(BaseModel):
    """What one image shows, written so a technician doesn't need to open it."""
    file: str = ""
    shows: str = ""
    on_screen_text: list[str] = Field(default_factory=list)
    error_codes: list[str] = Field(default_factory=list)


class VisualAnalysisPayload(BaseModel):
    analysis_source: str = "AI"
    summary: str = ""
    visual_observations: str
    technical_diagnosis: str
    suggested_category: str = "Incident"
    suggested_subcategory: str = "Investigation"
    suggested_service: str = "General"
    suggested_priority: Literal["P1", "P2", "P3", "P4"] = "P3"
    recommended_action: str
    # Structured extraction (empty for rule-based estimates and results stored before these fields existed).
    application: str = ""
    environment: str = ""
    error_codes: list[str] = Field(default_factory=list)
    key_details: list[str] = Field(default_factory=list)
    images: list[ImageFinding] = Field(default_factory=list)
    unclear: str = ""
    # Problem-first fields, so a technician can act without opening the image (empty on older results).
    problem: str = ""
    error_message: str = ""
    evidence: list[str] = Field(default_factory=list)
    confidence: str = ""
    next_steps: list[str] = Field(default_factory=list)


class Ticket(TicketDraft):
    id: str
    assigned_to: str = ""
    assigned_user_id: str = ""
    call_id: str = ""
    resolution: str = ""
    work_notes: list[WorkNote] = Field(default_factory=list)
    attachments: list[Attachment] = Field(default_factory=list)
    visual_analysis: VisualAnalysisPayload | None = None


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
    attempted_steps: list[str] = Field(default_factory=list, max_length=6)


class CounterfactualStep(BaseModel):
    action: str = Field(min_length=3, max_length=300)
    possible_outcome: str = Field(min_length=3, max_length=500)
    evidence_ids: list[str] = Field(default_factory=list, max_length=8)


class CounterfactualDraft(BaseModel):
    summary: str = Field(min_length=10, max_length=800)
    steps: list[CounterfactualStep] = Field(min_length=1, max_length=8)
    assumptions: list[str] = Field(default_factory=list, max_length=8)
    supporting_evidence_ids: list[str] = Field(default_factory=list, max_length=12)
    contradicting_evidence_ids: list[str] = Field(default_factory=list, max_length=12)
    unknowns: list[str] = Field(default_factory=list, max_length=8)


class HandoffAction(BaseModel):
    action: str = Field(min_length=3, max_length=300)
    rationale: str = Field(min_length=3, max_length=700)
    evidence_ids: list[str] = Field(default_factory=list, max_length=8)
    verify: str = Field(min_length=3, max_length=400)


class HandoffGuidance(BaseModel):
    summary: str = Field(min_length=3, max_length=900)
    next_actions: list[HandoffAction] = Field(min_length=1, max_length=5)
    questions_for_customer: list[str] = Field(default_factory=list, max_length=4)
    avoid_repeating: list[str] = Field(default_factory=list, max_length=6)
    unknowns: list[str] = Field(default_factory=list, max_length=6)


class QAAuditPayload(BaseModel):
    checks: list[QACheck]
    quality_score: int = Field(ge=0, le=100)


class ScopedQACheck(QACheck):
    field: Literal['Short description', 'Description', 'Category / Subcategory', 'Service',
                   'Priority', 'Assignment group', 'Resolution', 'Work notes']


class ScopedQAAuditPayload(QAAuditPayload):
    checks: list[ScopedQACheck]


class AIAssist(BaseModel):
    """AI self-help offered to the customer, and what happened next (human-in-the-loop record)."""
    status: Literal["pending", "offered", "resolved", "escalated"]
    summary: str = ""
    steps: list[str] = Field(default_factory=list)
    reason: str = ""
    confidence: float = Field(default=0, ge=0, le=1)
    knowledge_ids: list[str] = Field(default_factory=list)
    source: str = ""
    customer_response: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    decided_at: datetime | None = None


class AssistFeedback(BaseModel):
    resolved: bool
    note: str = Field(default="", max_length=2000)


class TicketStateTransition(BaseModel):
    from_state: str
    to_state: str
    changed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    changed_by: str = 'System'


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
    assist: AIAssist | None = None
    attempted_steps: list[str] = Field(default_factory=list, max_length=6)
    state_history: list[TicketStateTransition] = Field(default_factory=list)


class ResolutionApproach(BaseModel):
    approach: str = Field(max_length=240)
    outcome: str = Field(max_length=500)
    evidence_id: str = ''


class ResolutionAssessmentPayload(BaseModel):
    classification: Literal['durable_fix', 'temporary_workaround', 'unresolved', 'unknown']
    confidence: float = Field(ge=0, le=1)
    rationale: str = Field(max_length=1200)
    evidence_ids: list[str] = Field(default_factory=list, max_length=12)
    approaches: list[ResolutionApproach] = Field(default_factory=list, max_length=8)
    verification_evidence: str = Field(default='', max_length=800)
    missing_information: list[str] = Field(default_factory=list, max_length=8)


class ResolutionAssessment(ResolutionAssessmentPayload):
    id: str
    case_id: str
    evidence_digest: str
    provider: str
    model: str
    analyzed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ClusterIncidentLink(BaseModel):
    case_id: str
    ticket_id: str
    confidence: float = Field(ge=0, le=1)
    rationale: str
    link_type: Literal['anchor', 'related', 'recurrence', 'reopening'] = 'related'
    review_state: Literal['unreviewed', 'confirmed', 'dismissed'] = 'unreviewed'


class ClusterStatusEvent(BaseModel):
    status: Literal['new', 'investigating', 'monitoring', 'resolved', 'dismissed']
    changed_by: str
    changed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    note: str = ''


class IssueCluster(BaseModel):
    id: str
    signature: dict[str, str] = Field(default_factory=dict)
    summary: str
    service: str
    priority: str
    status: Literal['new', 'investigating', 'monitoring', 'resolved', 'dismissed'] = 'new'
    incident_count: int = 0
    customer_count: int | None = None
    recurrence_count: int = 0
    recurrence_rate: float | None = None
    workaround_count: int = 0
    workaround_rate: float | None = None
    first_occurrence: datetime
    latest_occurrence: datetime
    last_analysis_at: datetime | None = None
    debt_score: int | None = None
    score_band: str = 'insufficient'
    score_components: dict[str, float | None] = Field(default_factory=dict)
    evidence_coverage: float = 0
    missing_signals: list[str] = Field(default_factory=list)
    links: list[ClusterIncidentLink] = Field(default_factory=list)
    status_history: list[ClusterStatusEvent] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class EngineeringBriefPayload(BaseModel):
    executive_summary: str = Field(max_length=1800)
    repeated_failure_pattern: str = Field(max_length=1200)
    root_cause_hypothesis: str = Field(max_length=1200)
    recommended_investigation: list[str] = Field(min_length=1, max_length=8)
    verification_plan: list[str] = Field(min_length=1, max_length=8)
    unknowns_and_limitations: list[str] = Field(default_factory=list, max_length=10)


class EngineeringBrief(EngineeringBriefPayload):
    title: str
    customer_impact: str
    evidence: list[str] = Field(default_factory=list)
    what_has_been_tried: list[str] = Field(default_factory=list)
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    source_ticket_ids: list[str] = Field(default_factory=list)


class EngineeringFollowup(BaseModel):
    id: str
    cluster_id: str
    brief: EngineeringBrief
    status: Literal['open', 'closed'] = 'open'
    created_by: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


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
