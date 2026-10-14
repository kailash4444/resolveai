import os

os.environ["LLM_PROVIDER"] = "mock"
os.environ["GEMINI_PROVIDER"] = "mock"
os.environ["DATA_BACKEND"] = "memory"

from fastapi.testclient import TestClient

from realapp.main import app
from realapp.config import Settings
from realapp.engine import OpenAIEngine
from realapp.local_secrets import load_local_openai_key, save_local_openai_key
from realapp.store import MemoryStore


from conftest import signed_in_admin
client = signed_in_admin(TestClient(app))


def test_role_workspace_entry_routes_serve_the_shared_app_shell():
    for path in ("/portal", "/console", "/admin"):
        response = client.get(path)
        assert response.status_code == 200
        assert 'id="view-customer-home"' in response.text
        assert 'id="view-calls"' in response.text
        assert 'id="view-overview"' in response.text


def test_ticket_list_opens_dedicated_editor_without_qa_controls():
    page = client.get("/")
    assert page.status_code == 200
    assert 'id="view-ticket-detail"' in page.text
    assert 'id="ticketDetailPage"' in page.text
    assert "<th>QA</th>" not in page.text
    assert 'id="topStartCase"' not in page.text
    assert 'data-view="case">New case</a>' in page.text
    assert 'id="knowledgeSearch"' in page.text
    assert 'id="openKnowledgePanel"' in page.text
    assert '<dialog class="dlg dlg--wide" id="knowledgeModal"' in page.text
    assert "['analytics', 'Analytics']" in client.get('/static/shell.js').text
    assert 'id="view-analytics"' in page.text
    assert 'id="serviceAnalyticsRows"' in page.text
    script = client.get("/static/app.js")
    assert 'openTicketDetails(ticketLink.dataset.ticketLink)' in script.text
    assert 'id="fu-activity-tab"' in script.text
    assert 'id="fu-resolution" role="tabpanel" aria-labelledby="fu-resolution-tab" hidden' in script.text
    assert 'data-qa-case-id' in script.text
    assert "AI QA is running in the background" in script.text
    assert 'renderKnowledge(event.target.value)' in script.text
    assert "async function loadAnalytics()" in script.text
    assert 'item.ticket.service' in script.text
    assert "Saving changes reruns AI QA without leaving this ticket." not in script.text
    assert "Use the Resolution notes panel below when the work is complete." not in script.text
    assert '$("#caseResult").innerHTML = ""' in script.text


def test_real_workflow_and_qa_rerun():
    response = client.post("/api/analyze", json={
        "caller": "Test user",
        "channel": "Voice",
        "transcript": "Customer: My account is locked after too many attempts.\nAgent: I will verify your identity before unlocking it.",
    })
    assert response.status_code == 200
    case = response.json()
    assert case["routing"]["handler"] == "AI"
    assert case["knowledge_matches"]
    assert case["ticket"]["id"].startswith("INC") and len(case["ticket"]["id"]) == 10
    assert case["ticket"]["state"] == "New"
    assert case["ticket"]["resolution"] == ""
    assert case["ticket"]["short_description"]
    assert case["ticket"]["work_notes"][0]["author"] == "Ticket created"
    assert "Short description : Account access request" in case["ticket"]["work_notes"][0]["text"]
    assert "State : New" in case["ticket"]["work_notes"][0]["text"]
    assert "Resolution notes" not in case["ticket"]["work_notes"][0]["text"]
    assert case["qa_checks"] == []
    assert case["quality_score"] is None

    blocked_qa = client.post(f"/api/cases/{case['id']}/qa")
    assert blocked_qa.status_code == 409
    early_note = client.post(f"/api/cases/{case['id']}/work-notes", json={"author": "Alex", "author_type": "Technician", "text": "Started investigation."})
    assert early_note.status_code == 200 and early_note.json()["ticket"]["state"] == "New"   # notes are allowed in every state

    updated = client.patch(f"/api/cases/{case['id']}/ticket", json={
        "short_description": "Locked enterprise account",
        "description": "User is locked out after repeated authentication attempts and requires identity verification.",
        "category": "Access",
        "subcategory": "Account lockout",
        "service": "Identity and Access Management",
        "assignment_group": "Identity Service Desk",
        "priority": "P2",
        "state": "In Progress",
    })
    assert updated.status_code == 200
    assert updated.json()["ticket"]["short_description"] == "Locked enterprise account"
    assert updated.json()["ticket"]["state"] == "In Progress"
    history = updated.json()["ticket"]["work_notes"]
    assert history[-1]["author_type"] == "System"
    assert "Short description : Locked enterprise account was Account access request" in history[-1]["text"]
    assert "State : In Progress was New" in history[-1]["text"]

    technician_note = client.post(f"/api/cases/{case['id']}/work-notes", json={"author": "Alex", "author_type": "Technician", "text": "Identity verification started."})
    assert technician_note.status_code == 200
    customer_note = client.post(f"/api/cases/{case['id']}/work-notes", json={"author": "Test user", "author_type": "Customer", "text": "I completed the verification step."})
    assert customer_note.status_code == 200
    assert len(customer_note.json()["ticket"]["work_notes"]) == 5   # includes the note added while New

    missing_resolution = client.patch(f"/api/cases/{case['id']}/ticket", json={"state": "Resolved"})
    assert missing_resolution.status_code == 422
    early_resolution = client.patch(f"/api/cases/{case['id']}/ticket", json={"resolution": "Should not be allowed yet."})
    assert early_resolution.status_code == 422

    resolved = client.patch(f"/api/cases/{case['id']}/ticket", json={"state": "Resolved", "resolution": "Identity verified; account unlocked and sign-in confirmed."})
    assert resolved.status_code == 200
    background_result = client.get(f"/api/cases/{case['id']}")
    assert background_result.json()["quality_score"] == 100
    audited = client.post(f"/api/cases/{case['id']}/qa")
    assert audited.status_code == 200
    assert audited.json()["quality_score"] == 100


def test_knowledge_can_be_added_and_retrieved():
    created = client.post("/api/knowledge", json={
        "title": "Repair managed print queue",
        "product": "Managed Printing",
        "symptoms": "Documents remain in the queue and never print.",
        "steps": ["Confirm printer status.", "Clear and restart the managed queue."],
        "resolution": "Test page prints successfully.",
        "tags": ["printer", "queue"],
    })
    assert created.status_code == 201
    articles = client.get("/api/knowledge")
    assert created.json()["id"] in {item["id"] for item in articles.json()}


def test_overview_uses_real_case_data():
    overview = client.get("/api/overview")
    assert overview.status_code == 200
    assert overview.json()["total_cases"] >= 1


def test_openai_runtime_key_is_memory_only():
    settings = Settings(llm_provider="openai", openai_api_key=None)
    local_store = MemoryStore()
    openai_engine = OpenAIEngine(settings, local_store.list_knowledge)
    assert openai_engine.configured is False
    openai_engine.set_api_key("sk-test-value-used-only-in-unit-tests")
    assert openai_engine.configured is True
    assert settings.openai_api_key is None


def test_openai_key_can_be_protected_and_reloaded(monkeypatch, tmp_path):
    key_file = tmp_path / "openai-key.dpapi"
    monkeypatch.setenv("RESOLVEAI_LOCAL_KEY_FILE", str(key_file))
    save_local_openai_key("sk-test-persistent-local-key-value")
    assert key_file.exists()
    assert b"sk-test-persistent-local-key-value" not in key_file.read_bytes()
    assert load_local_openai_key() == "sk-test-persistent-local-key-value"


def test_transcription_uses_configured_model_without_network():
    captured = {}

    class Transcriptions:
        def create(self, **kwargs):
            captured.update(kwargs)
            return type("Transcript", (), {"text": "Customer cannot access the account."})()

    class FakeClient:
        audio = type("Audio", (), {"transcriptions": Transcriptions()})()

    settings = Settings(llm_provider="openai", openai_api_key=None, transcription_model="gpt-4o-mini-transcribe")
    openai_engine = OpenAIEngine(settings, MemoryStore().list_knowledge)
    openai_engine.set_api_key("sk-test-value-used-only-in-unit-tests")
    openai_engine._client = FakeClient()
    text = openai_engine.transcribe("call.webm", b"test-audio")
    assert text == "Customer cannot access the account."
    assert captured["model"] == "gpt-4o-mini-transcribe"
    assert captured["file"].name == "call.webm"
