from types import SimpleNamespace

import pytest

from realapp import incident_assist, main
from realapp.config import Settings
from realapp.incident_assist import assess, pick_technician
from realapp.models import KnowledgeMatch, VisualAnalysisPayload
from test_attachments import accounts  # noqa: F401  (fixture)

PNG = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4'
GUIDE = KnowledgeMatch(id='KB-PRINT', title='Printer shows offline', score=0.9, excerpt='Printer offline for one user.',
                       steps=['Turn the printer off and on.', 'Remove and re-add the printer in Settings.'])


def case_for(short, description):
    ticket = SimpleNamespace(short_description=short, description=description)
    return SimpleNamespace(ticket=ticket)


class Engine:
    def __init__(self, matches): self.matches = matches
    def retrieve(self, text, limit=3): return self.matches


MOCK = Settings(llm_provider='mock')


def report(client, json=None, data=None, files=None):
    """Create an incident; the response is immediate ('pending'), the AI result is on the saved ticket."""
    created = client.post('/api/customer/incidents', json=json, data=data, files=files)
    assert created.status_code == 201, created.text
    assert created.json()['assist']['status'] == 'pending'
    return client.get(f"/api/cases/{created.json()['id']}").json()


def ai_visual(priority='P3'):
    return VisualAnalysisPayload(analysis_source='Gemini Multimodal Vision', visual_observations='Printer status shows Offline.',
                                 technical_diagnosis='Spooler lost the device.', suggested_priority=priority, recommended_action='Re-add printer.')


def test_ai_offers_steps_only_from_approved_knowledge():
    result = assess(case_for('Printer offline', 'My printer shows offline.'), ai_visual(), True, Engine([GUIDE]), MOCK)
    assert result.status == 'offered' and result.steps == GUIDE.steps and result.knowledge_ids == ['KB-PRINT']


@pytest.mark.parametrize('case, visual, images, matches, reason', [
    (case_for('Printer offline', 'Shows offline.'), VisualAnalysisPayload(analysis_source='AI Multimodal Vision Engine (Local Extraction)', visual_observations='x', technical_diagnosis='y', recommended_action='z'), True, [GUIDE], 'image analysis'),
    (case_for('Laptop login issue', 'Unable to login to my office laptop.'), ai_visual(), True, [GUIDE], 'account access'),
    (case_for('Printer offline', 'Shows offline.'), ai_visual('P1'), True, [GUIDE], 'urgent'),
    (case_for('Printer offline', 'Shows offline.'), ai_visual(), True, [], 'no approved guide'),
])
def test_ai_hands_over_when_not_safe_or_not_supported(case, visual, images, matches, reason):
    result = assess(case, visual, images, Engine(matches), MOCK)
    assert result.status == 'escalated' and reason in result.reason.lower()


def _ticket(short, state='New', owner='', category='Incident', subcategory='Unclassified', service='General'):
    return SimpleNamespace(ticket=SimpleNamespace(short_description=short, description=short, state=state, assigned_user_id=owner,
                                                  category=category, subcategory=subcategory, service=service))


def test_pick_technician_prefers_available_then_similar_experience_then_skill_then_load():
    techs = [{'id': 'a', 'name': 'Ann', 'role': 'technician', 'skills': ['general'], 'status': 'Available'},
             {'id': 'b', 'name': 'Bob', 'role': 'technician', 'skills': ['general'], 'status': 'Available'},
             {'id': 'c', 'name': 'Cat', 'role': 'technician', 'skills': ['printing'], 'status': 'Away'},
             {'id': 'd', 'name': 'Dan', 'role': 'admin', 'skills': ['printing'], 'status': 'Available'}]
    new = _ticket('Printer queue stuck', service='Printing')
    history = [_ticket('Printer queue stuck again', 'Resolved', 'b', service='Printing'),
               _ticket('Print queue jammed', 'Resolved', 'b', service='Printing'),
               _ticket('Printer queue stuck', 'Resolved', 'c', service='Printing')]
    tech, why = pick_technician(techs, history, new)
    assert tech['id'] == 'b' and 'resolved 2 similar incidents' in why and 'available now' in why   # experience among available
    assert pick_technician([techs[2]], history, new)[0]['id'] == 'c'                                 # away still beats nobody
    tech, why = pick_technician(techs[:2], [_ticket('VPN', 'New', 'b')], _ticket('Email bounce'))
    assert tech['id'] == 'a' and '0 open tickets' in why                                              # no experience: lighter load
    assert pick_technician([techs[3]], [], new) == (None, '')                                         # admins aren't auto-assigned


def test_resolved_incident_becomes_knowledge_and_ai_solves_the_next_one(accounts):
    details = {'short_description': 'Print queue stuck', 'description': 'Documents stay stuck in the print queue and never come out.', 'service': 'Printing'}
    first = report(accounts.cust_1, json=details)
    assert first['assist']['status'] == 'escalated' and first['ticket']['assigned_user_id'] == accounts.tech_1_id

    fix = 'Cancel all documents in the print queue.\nTurn the printer off and on.\nPrint a test page.'
    assert accounts.tech_1.patch(f"/api/cases/{first['id']}/ticket", json={'state': 'In Progress'}).status_code == 200
    assert accounts.tech_1.patch(f"/api/cases/{first['id']}/ticket", json={'state': 'Resolved', 'resolution': fix}).status_code == 200
    learned = [k for k in accounts.store.list_knowledge() if first['ticket']['id'] in k.source_ticket_ids]
    assert len(learned) == 1 and learned[0].steps
    notes = accounts.store.get_case(first['id']).ticket.work_notes
    assert any(n.author == 'Knowledge' and learned[0].id in n.text for n in notes)

    second = report(accounts.cust_2, json=details)
    assert second['assist']['status'] == 'offered' and learned[0].id in second['assist']['knowledge_ids']
    assert not second['ticket']['assigned_user_id']


def test_ai_solved_tickets_do_not_create_duplicate_knowledge(accounts, monkeypatch):
    monkeypatch.setattr(main.engine, 'retrieve', lambda text, limit=3: [GUIDE])
    case = report(accounts.cust_1, json={'short_description': 'Printer offline', 'description': 'The printer on my desk shows offline.', 'service': 'Printing'})
    before = len(accounts.store.list_knowledge())
    accounts.cust_1.post(f"/api/cases/{case['id']}/assist", json={'resolved': True})
    assert len(accounts.store.list_knowledge()) == before


def test_customer_confirms_fix_and_ticket_resolves(accounts, monkeypatch):
    monkeypatch.setattr(main.engine, 'retrieve', lambda text, limit=3: [GUIDE])
    case = report(accounts.cust_1, json={'short_description': 'Printer offline', 'description': 'The printer on my desk shows offline.', 'service': 'Printing'})
    assert case['assist']['status'] == 'offered' and case['routing']['handler'] == 'AI' and not case['ticket']['assigned_to']

    assert accounts.cust_2.post(f"/api/cases/{case['id']}/assist", json={'resolved': True}).status_code == 404
    done = accounts.cust_1.post(f"/api/cases/{case['id']}/assist", json={'resolved': True}).json()
    assert done['assist']['status'] == 'resolved' and done['ticket']['state'] == 'Resolved'
    assert 'Customer confirmed the AI-suggested' in done['ticket']['resolution']
    assert accounts.cust_1.post(f"/api/cases/{case['id']}/assist", json={'resolved': True}).status_code == 409


def test_steps_did_not_help_hands_over_to_a_technician(accounts, monkeypatch):
    monkeypatch.setattr(main.engine, 'retrieve', lambda text, limit=3: [GUIDE])
    case = report(accounts.cust_1, json={'short_description': 'Printer offline', 'description': 'The printer on my desk shows offline.', 'service': 'Printing'})
    result = accounts.cust_1.post(f"/api/cases/{case['id']}/assist", json={'resolved': False, 'note': 'Still offline after both steps.'}).json()
    assert result['assist']['status'] == 'escalated' and result['routing']['handler'] == 'Human'
    assert result['ticket']['assigned_user_id'] == accounts.tech_1_id
    notes = [n['author'] for n in result['ticket']['work_notes']]
    assert 'AI handover' in notes and 'cust_1' in notes


def test_image_incident_without_real_ai_goes_straight_to_a_technician(accounts):
    files = [('attachments', ('printer.png', PNG, 'image/png'))]
    case = report(accounts.cust_1, data={'short_description': 'Printer offline', 'description': 'The printer on my desk shows offline.', 'service': 'Printing'}, files=files)
    assert case['assist']['status'] == 'escalated' and 'image analysis' in case['assist']['reason']
    assert case['ticket']['assigned_user_id'] == accounts.tech_1_id
    assert accounts.cust_1.post(f"/api/cases/{case['id']}/assist", json={'resolved': True}).status_code == 409


def test_ai_speculation_in_diagnosis_does_not_count_as_a_sensitive_request():
    visual = VisualAnalysisPayload(analysis_source='Gemini Multimodal Vision (gemini-3.5-flash-lite)',
                                   visual_observations="Outlook has stopped working when opening the shared calendar 'Team Calendar'.",
                                   technical_diagnosis='Possibly a corrupt data file or shared calendar permissions conflict.',
                                   recommended_action='Re-add the shared calendar.')
    result = assess(case_for('Outlook keeps closing', 'Outlook closes by itself.'), visual, True, Engine([GUIDE]), MOCK)
    assert result.status == 'offered'
    locked = visual.model_copy(update={'visual_observations': 'Windows Security: the referenced account is currently locked out.'})
    assert assess(case_for('Laptop', 'Cannot get past the screen.'), locked, True, Engine([GUIDE]), MOCK).status == 'escalated'
