"""Account-based ownership. Display names never grant access."""
from fastapi import HTTPException


def actor(request):
    value = getattr(request.state, 'user', None)
    if not value:
        raise HTTPException(401, 'Sign in to ResolveAI.')
    return value


def can_read(case, user):
    if user['role'] == 'admin':
        return True
    if user['role'] == 'customer':
        return case.customer_id == user['id']
    return case.ticket.assigned_user_id == user['id']


def require_case(case, user):
    if not case or not can_read(case, user):
        raise HTTPException(404, 'Incident not found.')
    return case


def visible_case(case, user):
    if user['role'] != 'customer':
        return case
    value = case.model_copy(deep=True)
    value.qa_checks = []
    value.quality_score = None
    return value
