"""Ending a browser call must not wait for the AI incident analysis (it took 20-45 s in production)."""
from test_calling import service


class Deferred:
    """Stands in for the background executor: records work instead of running it."""
    def __init__(self):
        self.jobs = []

    def submit(self, function, *args):
        self.jobs.append((function, args))


def finished_browser_call(service):
    call = service.create_call('Customer', 'browser')
    service.add_turn(call['id'], 'Customer', 'The payroll app crashes when I open it.')
    return call


def test_end_call_returns_before_the_incident_is_written_then_writes_it(service):
    service.background = Deferred()
    call = finished_browser_call(service)
    ended = service.finish(call['id'])
    assert ended['status'] == 'Completed' and ended['case_id'] is None        # returned without the analysis
    assert service.needs_incident(service.get(call['id']))
    function, args = service.background.jobs[0]
    function(*args)                                                            # the background worker runs
    done = service.get(call['id'])
    assert done['case_id'] and service.case_store.get_case(done['case_id'])
    assert not service.needs_incident(done)


def test_without_a_background_worker_the_incident_is_written_inline(service):
    call = finished_browser_call(service)
    assert service.finish(call['id'])['case_id']


def test_calls_without_customer_speech_never_need_an_incident(service):
    service.background = Deferred()
    call = service.create_call('Customer', 'browser')
    service.finish(call['id'])
    assert not service.needs_incident(service.get(call['id']))
