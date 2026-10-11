"""Publish one reusable knowledge article from a resolved incident."""
import hashlib
import re

from realapp.incident_context import knowledge_context
from realapp.models import KnowledgeArticleInput


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

        context, _ = knowledge_context([case], self.call_lookup)
        content = self.engine.draft_knowledge(context)
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
            return

        article_id = "KB-AUTO-" + hashlib.sha256("|".join(key).encode()).hexdigest()[:12].upper()
        self.knowledge_store.add_knowledge(KnowledgeArticleInput(
            id=article_id, **content.model_dump(), source_ticket_ids=[ticket_id]
        ))
