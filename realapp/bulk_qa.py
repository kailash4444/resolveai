"""One background audit batch per application worker (the deployment uses one worker)."""
from copy import deepcopy
from threading import Lock
from uuid import uuid4


class BulkAudit:
    def __init__(self):
        self.lock = Lock()
        self.job = {'id': None, 'status': 'idle', 'total': 0, 'completed': 0, 'failed': 0, 'skipped': 0}

    def status(self):
        with self.lock:
            return deepcopy(self.job)

    def start(self, cases):
        with self.lock:
            if self.job['status'] == 'running':
                return deepcopy(self.job), None
            ids = [case.id for case in cases if case.ticket.state == 'Resolved']
            self.job = {'id': uuid4().hex, 'status': 'running' if ids else 'complete',
                        'total': len(ids), 'completed': 0, 'failed': 0, 'skipped': 0}
            return deepcopy(self.job), ids

    def run(self, ids, store, engine):
        try:
            for case_id in ids:
                result = 'skipped'
                try:
                    case = store.get_case(case_id)
                    if case and case.ticket.state == 'Resolved':
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
                    self.job[result] += 1
        finally:
            with self.lock:
                self.job['status'] = 'complete'
