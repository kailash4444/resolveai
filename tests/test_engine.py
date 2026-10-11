from app.services.mock_engine import analyze_mock, demo_transcript


def test_account_lock_routes_to_ai():
    result = analyze_mock(demo_transcript("account"), "account")
    assert result.routing.handler == "AI"
    assert result.routing.risk == "low"
    assert result.ticket.status == "Resolved"
    assert result.quality_score >= 95


def test_vpn_routes_to_human_and_finds_certificate_article():
    result = analyze_mock(demo_transcript("vpn"), "vpn")
    assert result.routing.handler == "HUMAN"
    assert result.routing.complexity == "medium"
    assert result.knowledge[0].id == "KB-1042"
    assert any(check.field == "impact" and check.status == "FAIL" for check in result.qa)


def test_sap_outage_is_high_risk():
    result = analyze_mock(demo_transcript("sap"), "sap")
    assert result.routing.handler == "HUMAN"
    assert result.routing.risk == "high"
    assert result.ticket.priority.value == "P1"
    assert result.ticket.assignment_group.value == "SAP Operations"
