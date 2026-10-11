from datetime import datetime, timezone
from uuid import uuid4

from app.models import (
    CaseResult,
    IssueUnderstanding,
    KnowledgeMatch,
    QACheck,
    RoutingDecision,
    Ticket,
    TicketField,
    TranscriptLine,
)
from app.services.knowledge import search_articles


SCENARIOS = {
    "vpn": """Customer: Hi, my VPN connects successfully but disconnects after about two minutes. I restarted my laptop twice and it did not help. I have a client presentation in twenty minutes and cannot access the internal dashboard.
Technician: Are any other applications affected?
Customer: Only the internal applications that need VPN. Everyone else on my team seems fine.""",
    "account": """Customer: My corporate account is locked after I entered the wrong password several times. I need access to email.
AI Agent: I can help after verifying your identity. Have you completed the verification prompt?
Customer: Yes, verification passed.""",
    "sap": """Customer: SAP production is unavailable for the finance team. More than fifty users cannot post invoices and month-end processing has stopped.
Technician: When did the outage start?
Customer: About ten minutes ago. We also see several monitoring alerts.""",
}


def demo_transcript(name: str) -> str:
    return SCENARIOS.get(name, SCENARIOS["vpn"])


def analyze_mock(transcript: str, scenario: str | None = None) -> CaseResult:
    lowered = transcript.lower()
    if scenario == "account" or any(term in lowered for term in ["account is locked", "locked out", "unlock"]):
        return _account_case(transcript)
    if scenario == "sap" or any(term in lowered for term in ["sap production", "production is unavailable", "fifty users", "outage"]):
        return _sap_case(transcript)
    return _vpn_case(transcript)


def _lines(transcript: str) -> list[TranscriptLine]:
    result = []
    for index, raw in enumerate(line.strip() for line in transcript.splitlines() if line.strip()):
        if ":" in raw:
            speaker, text = raw.split(":", 1)
        else:
            speaker, text = ("Customer" if index == 0 else "Technician"), raw
        result.append(TranscriptLine(speaker=speaker.strip(), text=text.strip(), timestamp=f"00:{index * 18:02d}"))
    return result or [TranscriptLine(speaker="Customer", text=transcript.strip())]


def _field(value: str, confidence: float) -> TicketField:
    return TicketField(value=value, confidence=confidence)


def _ids(prefix: str) -> tuple[str, str]:
    suffix = uuid4().hex[:6].upper()
    return f"CASE-{prefix}-{suffix}", f"INC-{datetime.now(timezone.utc).strftime('%y%m%d')}-{suffix}"


def _vpn_case(transcript: str) -> CaseResult:
    case_id, ticket_id = _ids("VPN")
    knowledge = [KnowledgeMatch(**item) for item in search_articles(transcript)]
    ticket = Ticket(
        id=ticket_id,
        short_description=_field("Corporate VPN disconnects after authentication", 0.96),
        description=_field("Employee connects successfully to the corporate VPN, but the session drops after approximately two minutes. Laptop restart was attempted twice without success. Internal applications are unavailable before an imminent client presentation.", 0.93),
        service=_field("Corporate VPN", 0.98),
        category=_field("Network", 0.97),
        subcategory=_field("VPN", 0.96),
        impact=_field("Enterprise", 0.61),
        urgency=_field("High", 0.91),
        priority=_field("P1", 0.63),
        assignment_group=_field("Network Support", 0.89),
        resolution_notes=_field("Pending technician action using KB-1042.", 0.55),
        resolution_code=_field("Workaround", 0.52),
    )
    qa = [
        QACheck(field="impact", current="Enterprise", recommended="Individual", status="FAIL", confidence=0.97, reason="The conversation identifies one affected employee.", evidence="Customer: Everyone else on my team seems fine."),
        QACheck(field="priority", current="P1", recommended="P2", status="FAIL", confidence=0.91, reason="High urgency does not increase the number of affected users.", evidence="The client presentation creates urgency, while impact remains Individual."),
        QACheck(field="assignment_group", current="Network Support", recommended="Network Support", status="PASS", confidence=0.94, reason="The symptoms and recommended article both concern VPN connectivity.", evidence="VPN connects and then disconnects after two minutes."),
        QACheck(field="description", current="Complete", recommended="Complete", status="PASS", confidence=0.95, reason="Symptoms, attempted actions, service, and business context are documented.", evidence="Restarted twice; internal dashboard unavailable; client presentation in twenty minutes."),
    ]
    return CaseResult(
        case_id=case_id,
        scenario="VPN instability",
        status="Human engaged",
        handler_label="Maya Chen - Network Support",
        transcript=_lines(transcript),
        understanding=IssueUnderstanding(service="Corporate VPN", problem="Connection drops shortly after successful authentication", symptoms=["VPN disconnects after about two minutes", "Internal applications unavailable"], actions_tried=["Restarted laptop twice"], users_affected="1 employee", business_impact="Client presentation in twenty minutes", urgency_signal="High - time-sensitive customer meeting"),
        routing=RoutingDecision(handler="HUMAN", complexity="medium", confidence=0.94, risk="medium", reason="The issue requires contextual troubleshooting and a certificate check, but no major-incident signals are present.", policy="Human technician with AI copilot"),
        next_question="Does the VPN disconnect immediately after authentication or only after remaining connected for a short time?",
        recommended_action="Check the device certificate expiry, refresh the certificate using KB-1042, reconnect, and observe for five minutes.",
        knowledge=knowledge,
        ticket=ticket,
        qa=qa,
        quality_score=78,
        source="mock",
    )


def _account_case(transcript: str) -> CaseResult:
    case_id, ticket_id = _ids("IAM")
    knowledge = [KnowledgeMatch(**item) for item in search_articles(transcript)]
    ticket = Ticket(id=ticket_id, short_description=_field("Corporate account locked after failed sign-in attempts", 0.98), description=_field("Employee account locked after repeated incorrect password attempts. Identity verification completed successfully and the account was unlocked through the approved workflow.", 0.96), service=_field("Identity and Access", 0.98), category=_field("Access", 0.97), subcategory=_field("Account lock", 0.99), impact=_field("Individual", 0.98), urgency=_field("Medium", 0.86), priority=_field("P3", 0.91), assignment_group=_field("Service Desk", 0.94), resolution_notes=_field("Identity verified and the corporate account was unlocked. Employee confirmed access to email.", 0.96), resolution_code=_field("Resolved by automation", 0.97), status="Resolved")
    qa = [QACheck(field="ticket", current="Complete", recommended="Complete", status="PASS", confidence=0.98, reason="The resolution follows an approved low-risk workflow and all required fields are present.", evidence="Identity verification passed before the unlock action.")]
    return CaseResult(case_id=case_id, scenario="Account locked", status="Resolved by AI", handler_label="ResolveAI virtual agent", transcript=_lines(transcript), understanding=IssueUnderstanding(service="Identity and Access", problem="Corporate account locked after failed password attempts", symptoms=["Unable to sign in", "Email access unavailable"], actions_tried=["Identity verification completed"], users_affected="1 employee", business_impact="Employee cannot access email", urgency_signal="Medium"), routing=RoutingDecision(handler="AI", complexity="simple", confidence=0.98, risk="low", reason="Account unlock is an approved workflow and identity verification has passed.", policy="AI execution allowed after verification"), next_question="Can you confirm that the approved identity verification prompt has completed?", recommended_action="Unlock the account, ask the employee to sign in, and confirm email access.", knowledge=knowledge, ticket=ticket, qa=qa, quality_score=98, source="mock")


def _sap_case(transcript: str) -> CaseResult:
    case_id, ticket_id = _ids("SAP")
    knowledge = [KnowledgeMatch(**item) for item in search_articles(transcript)]
    ticket = Ticket(id=ticket_id, short_description=_field("SAP production unavailable for Finance", 0.98), description=_field("SAP production is unavailable for more than fifty Finance users. Invoice posting and month-end processing have stopped. Monitoring alerts are active and the outage began approximately ten minutes ago.", 0.96), service=_field("SAP Production", 0.99), category=_field("Application", 0.95), subcategory=_field("Service outage", 0.97), impact=_field("Enterprise", 0.94), urgency=_field("Critical", 0.96), priority=_field("P1", 0.98), assignment_group=_field("SAP Operations", 0.97), resolution_notes=_field("Major incident investigation in progress.", 0.76), resolution_code=_field("Unresolved", 0.92), status="Work in Progress")
    qa = [QACheck(field="priority", current="P1", recommended="P1", status="PASS", confidence=0.99, reason="Many users and a critical finance process are affected.", evidence="More than fifty users cannot post invoices during month-end processing."), QACheck(field="assignment_group", current="SAP Operations", recommended="SAP Operations", status="PASS", confidence=0.98, reason="The incident is isolated to SAP production and has active monitoring alerts.", evidence="SAP production is unavailable for the Finance team.")]
    return CaseResult(case_id=case_id, scenario="SAP production outage", status="Major incident escalation", handler_label="SAP Operations + Incident Command", transcript=_lines(transcript), understanding=IssueUnderstanding(service="SAP Production", problem="Production service outage", symptoms=["SAP unavailable", "Invoice posting stopped", "Monitoring alerts active"], actions_tried=["Initial service health check requested"], users_affected="50+ employees", business_impact="Month-end finance processing stopped", urgency_signal="Critical"), routing=RoutingDecision(handler="HUMAN", complexity="complex", confidence=0.99, risk="high", reason="A production outage affects many users and a critical business process.", policy="Human only - major incident"), next_question="Which SAP environment and business processes are affected, and is a major incident already open?", recommended_action="Engage SAP Operations, start the major incident process, and publish stakeholder communications.", knowledge=knowledge, ticket=ticket, qa=qa, quality_score=94, source="mock")
