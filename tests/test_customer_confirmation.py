"""Pending Customer Confirmation: the technician proposes a fix, the customer confirms it or says it still fails."""
from test_attachments import accounts  # noqa: F401  (fixture)


def _incident(accounts):
    created = accounts.cust_1.post('/api/customer/incidents', json={'short_description': 'VPN keeps dropping',
                                   'description': 'The VPN disconnects every few minutes since yesterday.', 'service': 'Remote Access'})
    assert created.status_code == 201, created.text
    case_id = created.json()['id']
    # The technician (named tech_1) takes the incident and starts work.
    assert accounts.tech_1.patch(f'/api/cases/{case_id}/ticket', json={'assigned_user_id': accounts.tech_1_id, 'state': 'In Progress'}).status_code == 200
    return case_id


def test_technician_requests_confirmation_and_is_credited_when_the_customer_confirms(accounts):
    case_id = _incident(accounts)
    # A fix must be written before confirmation can be requested.
    assert accounts.tech_1.patch(f'/api/cases/{case_id}/ticket', json={'state': 'Pending Customer Confirmation'}).status_code == 422
    asked = accounts.tech_1.patch(f'/api/cases/{case_id}/ticket', json={'state': 'Pending Customer Confirmation',
                                  'resolution': '1. Update the VPN client.\n2. Restart the laptop.'})
    assert asked.status_code == 200 and asked.json()['ticket']['state'] == 'Pending Customer Confirmation'

    # Only the incident's own customer can answer; "No" needs a comment.
    assert accounts.cust_2.post(f'/api/cases/{case_id}/resolution-confirmation', json={'resolved': True}).status_code == 404
    assert accounts.cust_1.post(f'/api/cases/{case_id}/resolution-confirmation', json={'resolved': False, 'note': ''}).status_code == 422

    done = accounts.cust_1.post(f'/api/cases/{case_id}/resolution-confirmation', json={'resolved': True})
    assert done.status_code == 200, done.text
    case = accounts.store.get_case(case_id)
    assert case.ticket.state == 'Resolved'
    # The technician resolved it; the customer only confirmed.
    assert case.state_history[-1].to_state == 'Resolved' and case.state_history[-1].changed_by == 'tech_1'
    assert any(n.author == 'cust_1' and n.author_type == 'Customer' and 'tech_1' in n.text for n in case.ticket.work_notes)
    # Answering twice isn't possible.
    assert accounts.cust_1.post(f'/api/cases/{case_id}/resolution-confirmation', json={'resolved': True}).status_code == 409


def test_customer_saying_it_still_fails_reopens_the_incident_for_the_technician(accounts):
    case_id = _incident(accounts)
    accounts.tech_1.patch(f'/api/cases/{case_id}/ticket', json={'state': 'Pending Customer Confirmation', 'resolution': 'Reset the VPN profile.'})
    reply = accounts.cust_1.post(f'/api/cases/{case_id}/resolution-confirmation', json={'resolved': False, 'note': 'Still drops on Wi-Fi.'})
    assert reply.status_code == 200, reply.text
    case = accounts.store.get_case(case_id)
    assert case.ticket.state == 'In Progress'
    assert case.state_history[-1].changed_by == 'cust_1'                       # the customer reopened it
    assert any(n.text == 'Still drops on Wi-Fi.' and n.author_type == 'Customer' for n in case.ticket.work_notes)
