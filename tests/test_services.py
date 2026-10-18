"""Services come from one fixed list so analytics and filters never split one service into several rows."""
import re
from pathlib import Path

from realapp.models import CustomerIncidentCreate, TicketDraft, TicketUpdate
from realapp.services import (SERVICES, classify_routing_category, normalize_service,
                              routing_category, skill_matches)

STATIC = Path(__file__).resolve().parents[1] / 'realapp' / 'static'


def test_free_text_names_map_onto_the_list():
    assert normalize_service('Print Services') == normalize_service('Printing Services') == 'Printing'
    assert normalize_service('Microsoft Outlook') == normalize_service('Outlook') == 'Email & Outlook'
    assert normalize_service('GlobalProtect VPN') == normalize_service('VPN') == 'Network & VPN'
    assert normalize_service('End User Computing') == 'Windows & devices'
    assert normalize_service('IT Helpdesk') == normalize_service('') == normalize_service(None) == 'General'
    assert normalize_service('Enterprise IT') == 'General'   # "erp" inside a word is not ERP
    assert all(normalize_service(name) == name for name in SERVICES)


def test_tickets_old_and_new_are_normalised():
    ticket = TicketDraft(short_description='x', description='y', category='c', subcategory='s', service='Printing Services', priority='P3', assignment_group='g')
    assert ticket.service == 'Printing'
    assert TicketUpdate(service='outlook').service == 'Email & Outlook' and TicketUpdate().service is None
    assert CustomerIncidentCreate(short_description='abc', description='0123456789', service='VPN').service == 'Network & VPN'


def test_skills_match_the_service_family():
    assert skill_matches('Network & VPN', ['vpn'])
    assert not skill_matches('Printing', ['vpn', 'general'])
    assert skill_matches('software', ['software'])
    assert skill_matches('Business applications', ['software'])
    assert skill_matches('Windows & devices', ['hardware'])
    assert not skill_matches('Software & apps', ['hardware'])
    assert routing_category('General') == 'general'


def test_explicit_support_category_uses_customer_evidence_and_keeps_ambiguous_general():
    category, evidence = classify_routing_category(
        'I have a software question: the payroll app will not open on my laptop.', 'Windows & devices')
    assert category == 'software' and evidence
    assert classify_routing_category('My laptop will not power on.', 'General')[0] == 'hardware'
    assert classify_routing_category('I need help but cannot describe the issue yet.', 'General') == ('general', [])


def test_the_browser_lists_match_the_server_list():
    js = re.search(r"const SERVICES = \[(.*?)\];", (STATIC / 'app.js').read_text()).group(1)
    assert re.findall(r"'([^']+)'", js) == list(SERVICES)
    html = (STATIC / 'index.html').read_text()
    select = re.search(r'<select class="input" id="customerService".*?</select>', html, re.S).group(0)
    assert [o.replace('&amp;', '&') for o in re.findall(r'<option[^>]*>([^<]+)</option>', select)] == list(SERVICES)
