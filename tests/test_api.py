from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health_and_home():
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    page = client.get("/")
    assert page.status_code == 200
    assert "ResolveAI" in page.text


def test_full_vpn_demo_and_human_correction():
    response = client.post("/api/demo/vpn")
    assert response.status_code == 200
    case = response.json()
    assert case["ticket"]["impact"]["value"] == "Enterprise"
    updated = client.patch(
        f"/api/cases/{case['case_id']}/ticket",
        json={"fields": {"impact": "Individual", "priority": "P2"}},
    )
    assert updated.status_code == 200
    body = updated.json()
    assert body["ticket"]["impact"]["value"] == "Individual"
    assert not [check for check in body["qa"] if check["status"] == "FAIL"]
    assert body["quality_score"] == 100
