"""Publish one reusable knowledge article from a resolved incident."""
import hashlib
import logging
import re
from uuid import uuid4

from realapp.incident_context import knowledge_context
from realapp.models import KnowledgeArticleInput, KnowledgeContent, WorkNote

logger = logging.getLogger(__name__)


def _normalize(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", value.casefold()))


def _article_key(title: str, product: str, symptoms: str) -> tuple[str, str, str]:
    return _normalize(title), _normalize(product), _normalize(symptoms)


def _merge_text(existing: list[str], incoming: list[str]) -> list[str]:
    values = list(existing)
    seen = {_normalize(value) for value in values}
    for value in incoming:
        if _normalize(value) not in seen:
            values.append(value)
            seen.add(_normalize(value))
    return values


def _from_ticket(case) -> KnowledgeContent:
    """Plain article from the technician's own resolution notes, used when AI can't draft one."""
    t = case.ticket
    steps = [line.strip(" -*•\t") for line in t.resolution.splitlines() if line.strip(" -*•\t")] or [t.resolution.strip()]
    tags = [value for value in dict.fromkeys([t.category, t.subcategory, t.service]) if value and value not in {"Incident", "Unclassified", "General"}]
    return KnowledgeContent(title=t.short_description.strip()[:200], product=(t.service or "General")[:200],
                            symptoms=(t.description or t.short_description).strip()[:1000], steps=steps[:10],
                            resolution=t.resolution.strip()[:2000], tags=tags)


class ResolvedKnowledgePublisher:
    def __init__(self, case_store, knowledge_store, engine, call_lookup):
        self.case_store = case_store
        self.knowledge_store = knowledge_store
        self.engine = engine
        self.call_lookup = call_lookup

    def publish(self, case_id: str) -> None:
        case = self.case_store.get_case(case_id)
        if not case or case.ticket.state != "Resolved" or not case.ticket.resolution.strip():
            return

        ticket_id = case.ticket.id
        articles = self.knowledge_store.list_knowledge()
        if any(ticket_id in article.source_ticket_ids for article in articles):
            return

        # Fixed by the AI's own self-help from an existing article: nothing new to learn.
        if case.assist is not None and case.assist.status == "resolved":
            return

        context, _ = knowledge_context([case], self.call_lookup)
        try:
            content, drafted_by = self.engine.draft_knowledge(context), "AI draft"
        except Exception:
            logger.warning("AI knowledge drafting unavailable for %s; saving the technician's resolution as written", ticket_id)
            content, drafted_by = _from_ticket(case), "technician's resolution notes"
        key = _article_key(content.title, content.product, content.symptoms)
        duplicate = next((article for article in articles
                          if _article_key(article.title, article.product, article.symptoms) == key), None)
        if duplicate:
            updated = duplicate.model_copy(update={
                "steps": _merge_text(duplicate.steps, content.steps),
                "tags": _merge_text(duplicate.tags, content.tags),
                "resolution": "\n".join(_merge_text([duplicate.resolution], [content.resolution])),
                "source_ticket_ids": list(dict.fromkeys([*duplicate.source_ticket_ids, ticket_id]))[:20],
            })
            self.knowledge_store.add_knowledge(updated)
            self._note(case_id, f"Knowledge : merged into {duplicate.id} ({drafted_by}) so the AI can reuse this fix")
            return

        article_id = "KB-AUTO-" + hashlib.sha256("|".join(key).encode()).hexdigest()[:12].upper()
        article = self.knowledge_store.add_knowledge(KnowledgeArticleInput(
            id=article_id, **content.model_dump(), source_ticket_ids=[ticket_id]
        ))
        self._note(case_id, f"Knowledge : saved as {getattr(article, 'id', article_id)} ({drafted_by}) so the AI can reuse this fix")

    def _note(self, case_id: str, text: str) -> None:
        # Re-read so a concurrent edit (QA, comments) isn't overwritten.
        case = self.case_store.get_case(case_id)
        if case:
            case.ticket.work_notes.append(WorkNote(id=f"NOTE-{uuid4().hex[:8].upper()}", author="Knowledge", author_type="System", text=text))
            self.case_store.save_case(case)
