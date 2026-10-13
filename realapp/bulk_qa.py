"""User-scoped background audit batches within the application worker."""
from copy import deepcopy
from threading import Lock
from uuid import uuid4


class BulkAudit:
    def __init__(self):
        self.lock = Lock()
        self.jobs = {}

    def status(self, owner='global'):
        with self.lock:
            return deepcopy(self.jobs.get(owner, {'id': None, 'status': 'idle', 'total': 0, 'completed': 0, 'failed': 0, 'skipped': 0}))

    def start(self, cases, owner='global'):
        with self.lock:
            if self.jobs.get(owner, {}).get('status') == 'running':
                return deepcopy(self.jobs[owner]), None
            ids = [case.id for case in cases if case.ticket.state == 'Resolved']
            self.jobs[owner] = {'id': uuid4().hex, 'status': 'running' if ids else 'complete',
                        'total': len(ids), 'completed': 0, 'failed': 0, 'skipped': 0}
            return deepcopy(self.jobs[owner]), ids

    def run(self, ids, store, engine, owner='global', allowed=lambda case: True):
        try:
            for case_id in ids:
                result = 'skipped'
                try:
                    case = store.get_case(case_id)
                    if case and case.ticket.state == 'Resolved' and allowed(case):
                        audit = engine.audit(case)
                        saved = store.save_audit(case, audit)
                        # save_audit uses compare-and-swap to preserve concurrent ticket edits.
                        fields = {'qa_checks', 'quality_score'}
                        if (saved and saved.model_dump(exclude=fields) == case.model_dump(exclude=fields)
                                and saved.qa_checks == audit.checks and saved.quality_score == audit.quality_score):
                            result = 'completed'
                except Exception:
                    result = 'failed'
                with self.lock:
                    self.jobs[owner][result] += 1
        finally:
            with self.lock:
                self.jobs[owner]['status'] = 'complete'
