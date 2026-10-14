"""Account-based ownership. Display names never grant access."""
from fastapi import HTTPException


def actor(request):
    value = getattr(request.state, 'user', None)
    if not value:
        raise HTTPException(401, 'Log in to ResolveAI.')
    return value


def can_read(case, user):
    if user['role'] in {'admin', 'technician'}:
        return True
    if user['role'] == 'customer':
        return case.customer_id == user['id']
    return False


def require_case(case, user):
    if not case or not can_read(case, user):
        raise HTTPException(404, 'Incident not found.')
    return case


def can_report(case, user):
    return user['role'] == 'admin' or (user['role'] == 'technician' and case.ticket.assigned_user_id == user['id'])


def visible_case(case, user):
    value = case.model_copy(deep=True)
    if not can_report(case, user):
        value.qa_checks = []
        value.quality_score = None
    if user['role'] == 'technician' and value.ticket.assigned_user_id != user['id']:
        value.transcript = []
    return value
