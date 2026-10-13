"""Evidence-backed incident reconstruction for the Incident Time Machine."""
from datetime import datetime, timezone
import re


_ISSUE_WORD = re.compile(r"[a-z0-9][a-z0-9_.-]{2,}")
_ISSUE_STOP_WORDS = set("a about after again all an and any are as at be been before but by can did do does for from get has have how in into is it its may my not of on or our out problem request same service system the their then this to was were what when where which with work working would you your issue error customer support application".split())
_FAILURE = re.compile(r"\b(failed|did not work|didn't work|unsuccessful|still (?:fails|broken|not working))\b", re.I)
_CUSTOMER_CONFIRMATION = re.compile(
    r"\b(?:confirmed|verified)\b.{0,100}\b(?:works?|working|restored|fixed|resolved)\b|"
    r"\b(?:works?|working|restored|fixed|resolved)\b.{0,100}\b(?:confirmed|verified)\b", re.I,
)


def _timestamp(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    # Transcript offsets such as 00:00:12 are not wall-clock timestamps.
    if re.fullmatch(r"\d{1,2}:\d{2}:\d{2}(?:\.\d+)?", raw):
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def _event(event_id, kind, actor, title, detail, source_type, source_id, at=None, outcome="Unknown"):
    timestamp = _timestamp(at)
    return {
        "id": event_id,
        "type": kind,
        "actor": actor or "Unknown",
        "title": title,
        "detail": detail or "No additional detail was recorded.",
        "occurred_at": timestamp.isoformat() if timestamp else None,
        "time_quality": "recorded" if timestamp else "undated",
        "outcome": outcome,
        "source_type": source_type,
        "source_id": source_id,
    }


def reconstruct(case, assessment=None):
    """Return recorded events, keeping undated evidence outside the time axis."""
    events = []
    created = _timestamp(case.created_at)
    events.append(_event(
        "case-created", "ticket_created", "System", "Incident recorded",
        f"{case.ticket.id} was created in {case.ticket.service} with priority {case.ticket.priority}.",
        "case", case.id, created, "Incident entered the service desk.",
    ))

    if case.understanding.summary or case.understanding.intent:
        events.append(_event(
            "ai-diagnosis", "ai_diagnosis", "ResolveAI", "Recorded AI triage",
            "\n".join(value for value in (case.understanding.summary, case.understanding.intent) if value),
            "case_record", case.id,
        ))
    if case.recommended_action:
        events.append(_event(
            "ai-recommendation", "ai_recommendation", "ResolveAI", "Recorded AI action recommendation",
            case.recommended_action, "case_record", case.id,
            outcome="Saved recommendation; the record does not show whether it was followed.",
        ))
    if case.next_question:
        events.append(_event(
            "ai-next-question", "ai_recommendation", "ResolveAI", "Recorded AI follow-up question",
            case.next_question, "case_record", case.id,
            outcome="Saved suggested question; the record does not show whether it was asked.",
        ))

    for index, turn in enumerate(case.transcript):
        who = turn.speaker
        events.append(_event(
            f"transcript-{index}", "customer_observation" if turn.speaker.casefold() == "customer" else "conversation",
            who, f"{turn.speaker} statement", turn.text, "transcript_turn", str(index), turn.timestamp,
        ))

    if case.attempted_steps:
        events.append(_event(
            "reported-steps", "troubleshooting", "Customer", "Reported troubleshooting steps",
            "\n".join(f"• {step}" for step in case.attempted_steps), "case", case.id,
        ))

    for index, transition in enumerate(case.state_history):
        detail = f"State changed from {transition.from_state} to {transition.to_state}."
        if transition.to_state == "Resolved" and case.ticket.resolution:
            detail += f" Resolution notes: {case.ticket.resolution}"
        events.append(_event(
            f"state-{index}", "status_change", transition.changed_by,
            f"{transition.from_state} → {transition.to_state}", detail,
            "state_transition", str(index), transition.changed_at,
            case.ticket.resolution if transition.to_state == "Resolved" and case.ticket.resolution else "State transition recorded.",
        ))

    for note in case.ticket.work_notes:
        # The case-created snapshot duplicates the canonical incident-recorded event.
        if note.author_type == "System" and note.author == "Ticket created":
            continue
        lower = note.text.casefold()
        failed = note.author_type in {"Technician", "Customer"} and bool(
            re.search(r"\b(failed|did not work|didn't work|unsuccessful|still (?:fails|broken|not working))\b", lower)
        )
        kind = "failed_attempt" if failed else (
            "customer_comment" if note.author_type == "Customer" else
            "technician_action" if note.author_type == "Technician" else "system_record"
        )
        events.append(_event(
            f"note-{note.id}", kind, note.author,
            "Troubleshooting attempt" if failed else f"Work note by {note.author}",
            note.text, "work_note", note.id,
            note.created_at,
            "Explicit failure recorded in note." if failed else "Outcome not explicitly recorded.",
        ))

    for attachment in case.ticket.attachments:
        events.append(_event(
            f"attachment-{attachment.id}", "evidence_added", case.caller,
            f"Attachment added: {attachment.filename}",
            f"{attachment.content_type}, {attachment.size_bytes} bytes.",
            "attachment", attachment.id, attachment.created_at,
        ))

    for index, check in enumerate(case.qa_checks):
        events.append(_event(
            f"qa-{index}", "qa_result", "AI quality audit",
            f"{check.field}: {check.result}", check.evidence or check.observed,
            "qa_check", str(index),
        ))

    if assessment:
        events.append(_event(
            f"durability-{assessment.id}", "durability_assessment", "AI durability assessment",
            f"Resolution classified as {assessment.classification.replace('_', ' ')}",
            assessment.rationale, "resolution_assessment", assessment.id,
            assessment.analyzed_at,
            "Assessment, not proof of a durable outcome.",
        ))

    events.sort(key=lambda item: (item["occurred_at"] is None, item["occurred_at"] or "", item["id"]))
    for index, item in enumerate(events):
        item["sequence"] = index

    dated = [item for item in events if item["occurred_at"]]
    undated = [item for item in events if not item["occurred_at"]]
    # These edges encode timestamp order only, never causation.
    relationships = []
    for left, right in zip(dated, dated[1:]):
        if left["occurred_at"] < right["occurred_at"]:
            relationships.append({
                "from": left["id"], "to": right["id"], "type": "observed_before",
                "label": "Recorded earlier than", "evidence_ids": [left["id"], right["id"]],
            })

    possible_times = len(dated)
    initial_state = case.state_history[0].from_state if case.state_history else case.ticket.state
    return {
        "incident": {
            "id": case.id, "ticket_id": case.ticket.id,
            "title": case.ticket.short_description,
            "service": case.ticket.service, "priority": case.ticket.priority,
            "state": case.ticket.state, "resolution": case.ticket.resolution,
            "initial_state": initial_state,
            "created_at": created.isoformat() if created else None,
        },
        "knowledge_matches": [match.model_dump(mode="json") for match in case.knowledge_matches],
        "events": events,
        "dated_count": possible_times,
        "undated_count": len(undated),
        "chronology_coverage": round(possible_times / max(1, len(events)) * 100),
        "relationships": relationships,
        "causal_status": "Root cause not established — additional investigation required.",
        "warnings": (["Some source evidence has no reliable timestamp and is kept outside the historical time axis."] if undated else [])
                    + (["Edges show timestamp order only; they do not establish causation."] if relationships else []),
    }


def compare_history(source_case, candidates, minimum_shared_terms=2):
    """Return observable outcomes for same-service, symptom-overlap incidents."""
    source_text = f"{source_case.issue_title} {source_case.ticket.short_description}"
    source_terms = {word for word in _ISSUE_WORD.findall(source_text.casefold()) if word not in _ISSUE_STOP_WORDS}
    outcomes = {"customer_confirmed_resolution": 0, "resolved_unverified": 0,
                "open_after_recorded_failure": 0, "other_or_unknown": 0}
    matches = []
    if len(source_terms) < minimum_shared_terms:
        return {"status": "insufficient_evidence", "comparable_count": 0, "outcomes": outcomes,
                "matches": [], "matched_terms": [], "criteria": "At least two issue-specific terms and the same service are required.",
                "limitations": ["This incident does not contain enough specific symptom terms to select a comparable cohort."]}

    source_service = " ".join(_ISSUE_WORD.findall(source_case.ticket.service.casefold()))
    for candidate in candidates:
        if candidate.id == source_case.id:
            continue
        candidate_service = " ".join(_ISSUE_WORD.findall(candidate.ticket.service.casefold()))
        if not source_service or candidate_service != source_service:
            continue
        text = f"{candidate.issue_title} {candidate.ticket.short_description}"
        terms = {word for word in _ISSUE_WORD.findall(text.casefold()) if word not in _ISSUE_STOP_WORDS}
        shared = source_terms & terms
        if len(shared) < minimum_shared_terms:
            continue
        state_changes = candidate.state_history
        reopened = any(item.from_state == "Resolved" and item.to_state != "Resolved" for item in state_changes)
        notes = candidate.ticket.work_notes
        transcript = candidate.transcript
        confirmed = any(note.author_type == "Customer" and _CUSTOMER_CONFIRMATION.search(note.text) for note in notes)
        confirmed = confirmed or any(turn.speaker.casefold() == "customer" and _CUSTOMER_CONFIRMATION.search(turn.text) for turn in transcript)
        failed = any(_FAILURE.search(note.text) for note in notes)
        if reopened:
            outcome = "other_or_unknown"
        elif candidate.ticket.state == "Resolved" and confirmed:
            outcome = "customer_confirmed_resolution"
        elif candidate.ticket.state == "Resolved":
            outcome = "resolved_unverified"
        elif failed:
            outcome = "open_after_recorded_failure"
        else:
            outcome = "other_or_unknown"
        outcomes[outcome] += 1
        matches.append({
            "case_id": candidate.id,
            "ticket_id": candidate.ticket.id,
            "service": candidate.ticket.service,
            "priority": candidate.ticket.priority,
            "state": candidate.ticket.state,
            "created_at": candidate.created_at.isoformat(),
            "similarity_terms": sorted(shared),
            "outcome": outcome,
            "demo_dataset": candidate.demo_dataset or None,
        })

    matches.sort(key=lambda item: (-len(item["similarity_terms"]), item["created_at"], item["ticket_id"]))
    limitations = [
        "This is observational incident context, not a causal estimate of the selected alternative.",
        "Outcome labels use recorded ticket state and explicit customer confirmation or failure text; missing follow-up stays unknown.",
        "No standardized follow-up window or strategy-level action outcomes are recorded in this cohort.",
    ]
    if not matches:
        limitations.insert(0, "No other case met the same-service and symptom-overlap criteria.")
    if any(item["demo_dataset"] for item in matches):
        limitations.append("The comparison includes records labeled as demo data; inspect each source before drawing conclusions.")
    return {
        "status": "insufficient_evidence" if not matches else "observational_context",
        "comparable_count": len(matches), "outcomes": outcomes, "matches": matches[:25],
        "matched_terms": sorted(set().union(*(set(item["similarity_terms"]) for item in matches))) if matches else [],
        "criteria": f"Same service and at least {minimum_shared_terms} shared issue-specific terms in the issue title or short description.",
        "limitations": limitations,
    }
