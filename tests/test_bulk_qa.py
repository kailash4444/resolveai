from types import SimpleNamespace
from unittest.mock import Mock

from realapp import main
from realapp.bulk_qa import BulkAudit
from realapp.models import QAAuditPayload
from test_roles import accounts, create_incident


def resolved(accounts, count):
    cases = []
    for _ in range(count):
        item = create_incident(accounts.customer_a)
        case = accounts.store.get_case(item['id'])
        case.ticket.state, case.ticket.resolution = 'Resolved', 'Fixed and verified with customer.'
        accounts.store.save_case(case)
        cases.append(case)
    return cases


def test_bulk_audit_continues_after_failure_and_preserves_concurrent_edits(accounts):
    cases = resolved(accounts, 4)
    create_incident(accounts.customer_a)  # unresolved must never be audited
    job = BulkAudit()
    start, ids = job.start(accounts.store.list_cases())
    assert start['total'] == 4
    duplicate, pending = job.start(accounts.store.list_cases())
    assert pending is None and duplicate['id'] == start['id']
    reopened = accounts.store.get_case(cases[3].id)
    reopened.ticket.state = 'In Progress'
    accounts.store.save_case(reopened)
    def audit(case):
        if case.id == cases[1].id:
            raise RuntimeError('private provider error')
        if case.id == cases[2].id:
            changed = accounts.store.get_case(case.id)
            changed.ticket.description = 'Updated while audit was running'
            accounts.store.save_case(changed)
        return QAAuditPayload(checks=[], quality_score=99)
    engine = SimpleNamespace(audit=Mock(side_effect=audit))
    job.run(ids, accounts.store, engine)
    assert engine.audit.call_count == 3
    assert job.status() == {**start, 'status':'complete', 'completed':1, 'failed':1, 'skipped':2}
    assert accounts.store.get_case(cases[2].id).ticket.description == 'Updated while audit was running'
    assert accounts.store.get_case(cases[0].id).quality_score == 99
    assert 'private' not in str(job.status())


def test_bulk_audit_api_staff_access_and_resolved_only(accounts, monkeypatch):
    monkeypatch.setattr(main.app.state, 'bulk_audit', BulkAudit())
    f = accounts
    resolved(f, 2)
    create_incident(f.customer_b)
    for client in [f.customer_a, f.customer_b]:
        assert client.post('/api/qa/rerun-all').status_code == 403
        assert client.get('/api/qa/rerun-all').status_code == 403
    for client in [f.tech_a, f.admin]:
        response = client.post('/api/qa/rerun-all')
        assert response.status_code == 202 and response.json()['total'] == 2
        status = client.get('/api/qa/rerun-all').json()
        assert status['status'] == 'complete' and status['completed'] == 2 and status['failed'] == 0
    assert all(case.quality_score is None for case in f.store.list_cases() if case.ticket.state != 'Resolved')


def test_empty_batch_is_complete(accounts):
    job = BulkAudit()
    current, ids = job.start(accounts.store.list_cases())
    assert current['status'] == 'complete' and current['total'] == 0 and ids == []
