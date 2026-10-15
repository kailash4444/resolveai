from concurrent.futures import ThreadPoolExecutor
import base64
import math
import struct
from xml.etree import ElementTree

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from realapp.calling import CallingService, TechnicianCreate, Login
from realapp.calling_api import install_calling
from realapp.calling_store import MemoryCallingStore, SQLiteCallingStore
from realapp.config import Settings
from realapp.engine import OpenAIEngine
from realapp.store import MemoryStore, SQLiteStore


@pytest.fixture
def service():
    settings = Settings(llm_provider="mock", calling_backend="memory", data_backend="memory", environment="local")
    store = MemoryStore()
    clock = [1000.0]
    result = CallingService(settings, MemoryCallingStore(), store, OpenAIEngine(settings, store.list_knowledge), now=lambda: clock[0])
    result.clock = clock
    return result


def technician(service, name="Alex", skills=None):
    value = TechnicianCreate(name=name, username=name.lower(), password="test-password-12345", skills=skills or ["general"])
    result = service.create_technician(value)
    service.presence(result["id"], "Available")
    return result


def request(service, phone=False):
    call = service.create_call("Customer", origin="browser" if phone else "desk", provider_sid="CA" + "1" * 32 if phone else None)
    service.add_turn(call["id"], "Customer", "The payroll application crashes on opening and I cannot complete today's work.")
    call = service.triage(call["id"])
    if phone:
        service.mark_waiting(call["id"])
        service.clock[0] += 3
    return call


def test_initial_incident_and_activity_are_retained(service):
    call = request(service)
    ticket = service.case_store.get_case(call["case_id"]).ticket
    assert ticket.state == "New" and ticket.resolution == ""
    assert ticket.call_id == call["id"]
    assert "Resolution" not in ticket.work_notes[0].text
    assert service.case_store.get_case(call["case_id"]).quality_score is None


def test_specialist_then_longest_idle_without_double_booking(service):
    general = technician(service, "General")
    specialist = technician(service, "Specialist", ["enterprise it"])
    first, second, third = request(service), request(service), request(service)
    offers = service.dispatch()
    assert len(offers) == 2
    assert service.get(first["id"])["technician_id"] == specialist["id"]
    assert service.get(second["id"])["technician_id"] == general["id"]
    assert service.get(third["id"])["status"] == "Queued"
    assert len({c["technician_id"] for c in offers}) == 2


def test_stale_presence_language_and_voice_capacity(service):
    tech = technician(service)
    call = request(service, phone=True)
    assert service.dispatch() == []  # No registered browser phone.
    service.heartbeat(tech["id"], True)
    service.repository.mutate(lambda db: db["calls"][call["id"]].update(language="fr"))
    assert service.dispatch() == []
    service.repository.mutate(lambda db: db["calls"][call["id"]].update(language="en"))
    service.clock[0] += 46
    assert service.dispatch() == []
    assert service.snapshot()["technicians"][0]["status"] == "Available"
    assert service.snapshot()["technicians"][0]["voice_ready"] is False


def test_decline_timeout_stale_callback_and_fair_reassignment(service):
    a, b = technician(service, "Alex"), technician(service, "Blair")
    call = request(service)
    first = service.dispatch()[0]
    service.decline(call["id"], a["id"])
    second = service.dispatch()[0]
    assert second["technician_id"] == b["id"]
    service.decline(call["id"], dispatch_id=first["dispatch_id"])
    assert service.get(call["id"])["dispatch_id"] == second["dispatch_id"]
    service.clock[0] += service.settings.call_reservation_seconds + 1
    service.dispatch()
    assert service.get(call["id"])["status"] == "Queued"
    with pytest.raises(HTTPException):
        service.accept(call["id"], b["id"], second["dispatch_id"])


def test_accept_requires_owner_and_updates_incident_once(service):
    a, b = technician(service, "Alex"), technician(service, "Blair")
    call = request(service)
    offer = service.dispatch()[0]
    with pytest.raises(HTTPException) as denied:
        service.accept(call["id"], b["id"])
    assert denied.value.status_code == 403
    service.accept(call["id"], a["id"])
    service.accept(call["id"], a["id"], offer["dispatch_id"])
    case = service.case_store.get_case(call["case_id"])
    assert case.ticket.assigned_to == "Alex"
    assert case.ticket.state == "In Progress"
    assert case.ticket.resolution == ""
    assert "Assigned to : Alex was Empty" in case.ticket.work_notes[1].text
    assert len(case.ticket.work_notes) == 2
    service.finish(call["id"])
    assert service.snapshot()["technicians"][0]["status"] == "Available"
    assert service.case_store.get_case(call["case_id"]).ticket.state == "In Progress"
    service.presence(a["id"], "Available")
    assert service.snapshot()["technicians"][0]["status"] == "Available"


def test_queue_timeout_and_callback_do_not_resolve_incident(service):
    call = request(service)
    service.clock[0] += 301
    service.dispatch()
    assert service.get(call["id"])["status"] == "Callback requested"
    assert service.case_store.get_case(call["case_id"]).ticket.state == "New"
    service.finish(call["id"])
    assert service.get(call["id"])["status"] == "Callback requested"


def test_identity_actions_and_explicit_human_request_always_escalate(service):
    call = service.create_call("Customer")
    service.add_turn(call["id"], "Customer", "My password is locked. Please unlock the administrator account.")
    result = service.triage(call["id"])
    assert result["status"] == "Queued"
    assert "verification" in result["reason"]


def test_model_failure_keeps_request_and_routes_to_human(service, monkeypatch):
    def failure(*args):
        raise RuntimeError("API unavailable")
    monkeypatch.setattr(service.engine, "analyze", failure)
    call = request(service)
    assert call["case_id"] and call["status"] == "Queued"
    assert "unavailable" in call["reason"]


def test_sqlite_persists_and_atomically_reserves_across_instances(service, tmp_path):
    path = str(tmp_path / "calls.db")
    service.repository = SQLiteCallingStore(path)
    tech = technician(service)
    for _ in range(4):
        request(service)
    other = CallingService(service.settings, SQLiteCallingStore(path), service.case_store, service.engine, now=service.now)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda instance: instance.dispatch(), [service, other]))
    assert sum(map(len, results)) == 1
    restored = CallingService(service.settings, SQLiteCallingStore(path), service.case_store, service.engine, now=service.now)
    assert len(restored.snapshot()["calls"]) == 4
    assert restored.snapshot()["technicians"][0]["current_call_id"]


def test_ticket_storage_survives_reinitialization(service, tmp_path):
    call = request(service)
    path = str(tmp_path / "tickets.db")
    db = SQLiteStore(path)
    db.save_case(service.case_store.get_case(call["case_id"]))
    assert SQLiteStore(path).get_case(call["case_id"]).ticket.call_id == call["id"]


def test_passwords_sessions_and_rate_limiting(service):
    tech = technician(service)
    token, _ = service.login(Login(username="alex", password="test-password-12345", expected_role="technician"), "local")
    assert service.authenticate(token)["id"] == tech["id"]
    assert "password_hash" not in tech
    assert token not in str(service.repository.data)
    service.logout(token, tech["id"])
    assert service.authenticate(token) is None
    for _ in range(10):
        with pytest.raises(HTTPException):
            service.login(Login(username="alex", password="wrong", expected_role="technician"), "remote")
    with pytest.raises(HTTPException) as blocked:
        service.login(Login(username="alex", password="wrong", expected_role="technician"), "remote")
    assert blocked.value.status_code == 429


@pytest.fixture
def webapp():
    app = FastAPI()
    settings = Settings(llm_provider="mock", calling_backend="memory", data_backend="memory", environment="local", public_base_url="https://calls.example.test",
        livekit_url="ws://127.0.0.1:7880", livekit_api_key="test-livekit-key", livekit_api_secret="test-livekit-secret-at-least-32-characters")
    store = MemoryStore()
    service = install_calling(app, settings, store, OpenAIEngine(settings, store.list_knowledge), lambda *args: None)
    return app, service




def test_authentication_admin_only_and_remote_bootstrap(webapp):
    app, _ = webapp
    admin = TestClient(app)
    value = {"name": "Admin", "username": "admin", "password": "test-admin-password"}
    remote = TestClient(app, base_url="https://calls.example.test")
    assert remote.post('/api/auth/setup', json=value).status_code == 403
    assert admin.get('/api/calling').status_code == 401
    assert admin.post('/api/auth/setup', json=value).status_code == 201
    assert admin.get('/api/calling').status_code == 200
    assert admin.post('/api/auth/setup', json=value).status_code == 409
    value.update(name="Technician", username="tech")
    assert admin.post('/api/technicians', json=value).status_code == 201
    worker = TestClient(app)
    assert worker.post('/api/auth/login', json={**value, 'expected_role': 'technician'}).status_code == 200
    assert worker.post('/api/technicians', json={**value, "username": "someone"}).status_code == 403
    assert worker.post('/api/technicians/me/heartbeat', json={}, headers={"Origin": "https://attacker.test"}).status_code == 403










def test_safe_guidance_routes_to_ai_and_later_human_request_escalates(service, monkeypatch):
    from realapp.models import AnalysisRequest
    case = service.engine.analyze(AnalysisRequest(transcript="Customer: How to restart the printer that is not responding?"))
    case.routing.handler, case.routing.risk, case.routing.confidence = "AI", "Low", .96
    monkeypatch.setattr(service.engine, 'analyze', lambda request: case)
    call = service.create_call('Customer')
    service.add_turn(call['id'], 'Customer', 'How to restart the printer that is not responding?')
    result = service.triage(call['id'])
    assert result['status'] == 'AI'
    service.add_turn(call['id'], 'Customer', 'I want to talk to a human now.')
    reply = service.reply(call['id'])
    assert reply.escalate and not reply.customer_confirmed_resolved
    assert service.case_store.get_case(result['case_id']).ticket.resolution == ''






