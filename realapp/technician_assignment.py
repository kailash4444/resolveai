"""Build live technician profiles and rank handoffs from relevant case history."""
from datetime import datetime, timezone
import math
import re

from realapp.services import normalize_service


_WORD = re.compile(r"[a-z0-9]{3,}")
_STOP = set("a about after again all also an and any are as at be been before but by can could did do does for from get got had has have how i if in into is it its just me my no not of on or our out same so than that the their them then there these this those to too was we were what when where which who with would you your issue problem service system user unable".split())
_GENERIC = {"", "incident", "unclassified", "investigation", "triage", "general"}
_RESOLVED = {"resolved", "closed"}


def _text_tokens(case):
    ticket = case.ticket
    text = " ".join((getattr(case, "issue_title", ""), ticket.short_description,
                     ticket.description[:700]))
    return {word for word in _WORD.findall(text.casefold()) if word not in _STOP}


def _date(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
        except ValueError:
            pass
    return None


def _resolved_at(case):
    transitions = [_date(event.changed_at) for event in getattr(case, "state_history", [])
                   if str(getattr(event, "to_state", "")).casefold() in _RESOLVED]
    return max((value for value in transitions if value), default=None)


def _issue_relevance(current, past, query_tokens):
    ticket = past.ticket
    old_tokens = _text_tokens(past)
    overlap = query_tokens & old_tokens
    coverage = len(overlap) / max(1, len(query_tokens))
    same_service = (normalize_service(current.ticket.service) != "General" and
                    normalize_service(current.ticket.service) == normalize_service(ticket.service))
    category = (ticket.category or "").strip().casefold()
    current_category = (current.ticket.category or "").strip().casefold()
    same_category = category not in _GENERIC and category == current_category
    subcategory = (ticket.subcategory or "").strip().casefold()
    current_subcategory = (current.ticket.subcategory or "").strip().casefold()
    same_subcategory = subcategory not in _GENERIC and subcategory == current_subcategory
    if coverage < 0.18 and not same_subcategory:
        return 0.0, []

    text_score = min(1.0, coverage * 2.5)
    relevance = 0.65 * text_score + 0.20 * same_service + 0.10 * same_category + 0.05 * same_subcategory
    occurred = _resolved_at(past)
    recency = 0.85
    if occurred:
        age_days = max(0, (datetime.now(timezone.utc) - occurred).days)
        recency = 0.7 + 0.3 * math.exp(-age_days / 730)
    return relevance * recency, sorted(overlap)[:8]


def build_technician_profiles(technicians, current_case, cases):
    """Project profile, live workload, QA and top matching solved tickets in one history pass."""
    staff = {tech["id"]: tech for tech in technicians if tech.get("role") == "technician" and tech.get("id")}
    if not staff:
        return {}
    profiles = {}
    for tech_id, tech in staff.items():
        skills = sorted({str(value).strip() for value in (tech.get("skills") or []) if str(value).strip()})
        profiles[tech_id] = {
            "technician_id": tech_id,
            "name": tech.get("name", "Technician"),
            "skills": skills,
            "languages": sorted(set(tech.get("languages") or [])),
            "availability": tech.get("status", "Offline"),
            "open_ticket_count": 0,
            "resolved_ticket_count": 0,
            "audit_score": None,
            "audit_sample_size": 0,
            "similar_resolved_count": 0,
            "similar_resolved": [],
        }

    query_tokens = _text_tokens(current_case)
    audit_scores = {tech_id: [] for tech_id in staff}
    for past in cases:
        ticket = past.ticket
        tech_id = ticket.assigned_user_id
        past_case_id = getattr(past, "id", None)
        current_case_id = getattr(current_case, "id", None)
        if (past_case_id is not None and past_case_id == current_case_id) or tech_id not in profiles:
            continue
        state = (ticket.state or "").casefold()
        if state not in _RESOLVED:
            profiles[tech_id]["open_ticket_count"] += 1
            continue
        profile = profiles[tech_id]
        profile["resolved_ticket_count"] += 1
        score = getattr(past, "quality_score", None)
        if score is not None:
            audit_scores[tech_id].append(score)
        relevance, terms = _issue_relevance(current_case, past, query_tokens)
        if relevance < 0.25:
            continue
        profile["similar_resolved"].append({
            "case_id": past_case_id or ticket.id,
            "ticket_id": ticket.id,
            "title": ticket.short_description,
            "service": ticket.service,
            "priority": ticket.priority,
            "state": ticket.state,
            "resolution": getattr(ticket, "resolution", "")[:500],
            "created_at": _date(getattr(past, "created_at", None)),
            "resolved_at": _resolved_at(past),
            "relevance": round(relevance, 3),
            "matched_terms": terms,
            "quality_score": score,
        })

    for tech_id, profile in profiles.items():
        audits = audit_scores[tech_id]
        if audits:
            profile["audit_score"] = round(sum(audits) / len(audits))
            profile["audit_sample_size"] = len(audits)
        profile["similar_resolved"].sort(key=lambda item: (-item["relevance"], item["ticket_id"]))
        profile["similar_resolved_count"] = len(profile["similar_resolved"])
        profile["similar_resolved"] = profile["similar_resolved"][:3]
        skills = ", ".join(profile["skills"]) or "general"
        languages = ", ".join(profile["languages"])
        audits_text = (f"ticket QA {profile['audit_score']}/100 across {profile['audit_sample_size']} audited tickets"
                       if profile["audit_score"] is not None else "ticket QA not yet available")
        profile["profile"] = (f"{skills} specialist · {profile['resolved_ticket_count']} resolved tickets · "
                              f"{profile['similar_resolved_count']} similar resolved · {audits_text} · "
                              f"{profile['open_ticket_count']} other open tickets · {profile['availability']}"
                              + (f" · languages {languages}" if languages else ""))
    return profiles


def choose_technician(technicians, cases, current_case):
    """Rank available technicians; priority changes expertise-versus-load weighting."""
    profiles = build_technician_profiles(technicians, current_case, cases)
    priority = getattr(current_case.ticket, "priority", "P3")
    urgent = priority in {"P1", "P2"}
    weights = {"expertise": 0.42, "skill": 0.30, "audit": 0.06, "load": 0.22} if urgent else {
        "expertise": 0.27, "skill": 0.20, "audit": 0.05, "load": 0.48}
    ranked = []
    for tech in technicians:
        profile = profiles.get(tech.get("id"))
        if not profile or tech.get("current_call_id") or tech.get("status") not in {"Available", "Away"}:
            continue
        service = normalize_service(current_case.ticket.service)
        normalized_skills = {normalize_service(skill) for skill in profile["skills"]}
        skill_score = 1.0 if service != "General" and service in normalized_skills else 0.35 if "General" in normalized_skills else 0.0
        matches = profile["similar_resolved"]
        expertise = (sum(item["relevance"] for item in matches) / len(matches)) if matches else 0.0
        # QA measures ticket quality, not technical competence; shrink sparse results and keep its weight small.
        audit = ((profile["audit_score"] * profile["audit_sample_size"] + 75 * 3) /
                 (profile["audit_sample_size"] + 3) / 100) if profile["audit_score"] is not None else 0.75
        load = 1 / (1 + profile["open_ticket_count"])
        score = weights["expertise"] * expertise + weights["skill"] * skill_score + weights["audit"] * audit + weights["load"] * load
        availability_rank = 0 if tech["status"] == "Available" else 1
        ranked.append((availability_rank, -score, profile["open_ticket_count"], tech.get("last_assigned", 0),
                       tech.get("name", ""), tech, profile, skill_score, score))
    if not ranked:
        return None, "", None
    _, _, _, _, _, tech, profile, skill_score, score = min(ranked, key=lambda row: row[:5])
    why = ["available now" if tech["status"] == "Available" else "no Available technician; selected Away as fallback"]
    if skill_score == 1:
        why.append(f"{normalize_service(current_case.ticket.service)} skill")
    elif skill_score == 0.35:
        why.append("general skill coverage")
    if profile["similar_resolved_count"]:
        why.append(f"resolved {profile['similar_resolved_count']} similar incidents")
        ids = ", ".join(item["ticket_id"] for item in profile["similar_resolved"])
        why.append(f"evidence {ids}")
    if profile["audit_score"] is not None:
        why.append(f"ticket QA average {profile['audit_score']}/100 ({profile['audit_sample_size']} audits)")
    why.append(f"{profile['open_ticket_count']} open tickets")
    why.append(f"{priority} priority score {score:.2f}")
    return tech, " · ".join(why), profile
