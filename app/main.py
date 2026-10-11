from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.models import AnalyzeRequest, CaseResult, Overview, TicketUpdate
from app.services.gemini_engine import GeminiEngine
from app.services.mock_engine import demo_transcript
from app.services.store import create_store


BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
engine = GeminiEngine(settings)
store = create_store(settings.store_mode, settings.google_cloud_project, settings.firestore_collection)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = engine
    app.state.store = store
    yield


app = FastAPI(title="ResolveAI", version="0.1.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": settings.app_name,
        "environment": settings.environment,
        "gemini_provider": settings.gemini_provider,
        "gemini_model": settings.gemini_model,
        "store_mode": settings.store_mode,
    }


@app.get("/api/config")
async def public_config() -> dict[str, Any]:
    return {
        "provider": settings.gemini_provider,
        "model": settings.gemini_model,
        "store": settings.store_mode,
        "demo_enabled": settings.enable_demo_data,
    }


@app.post("/api/analyze", response_model=CaseResult)
async def analyze(request: AnalyzeRequest):
    result = await engine.analyze(request.transcript, request.scenario)
    store.save_case(result.model_dump())
    return result


@app.post("/api/demo/{scenario}", response_model=CaseResult)
async def run_demo(scenario: str):
    if not settings.enable_demo_data:
        raise HTTPException(status_code=404, detail="Demo data is disabled")
    if scenario not in {"vpn", "account", "sap"}:
        raise HTTPException(status_code=404, detail="Unknown demo scenario")
    result = await engine.analyze(demo_transcript(scenario), scenario)
    store.save_case(result.model_dump())
    return result


@app.get("/api/cases")
async def list_cases():
    return store.list_cases()


@app.get("/api/cases/{case_id}")
async def get_case(case_id: str):
    result = store.get_case(case_id)
    if not result:
        raise HTTPException(status_code=404, detail="Case not found")
    return result


@app.patch("/api/cases/{case_id}/ticket")
async def update_ticket(case_id: str, update: TicketUpdate):
    case = store.get_case(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    for name, value in update.fields.items():
        if name in case["ticket"] and isinstance(case["ticket"][name], dict):
            case["ticket"][name]["value"] = value
            case["ticket"][name]["confidence"] = 1.0
    for check in case["qa"]:
        field = check["field"]
        if field in update.fields and update.fields[field] == check["recommended"]:
            check["current"] = check["recommended"]
            check["status"] = "PASS"
            check["reason"] = "Human accepted the evidence-based recommendation."
    failed = sum(1 for check in case["qa"] if check["status"] == "FAIL")
    case["quality_score"] = max(0, min(100, 100 - failed * 11))
    store.save_case(case)
    return case


@app.get("/api/overview", response_model=Overview)
async def overview():
    recent = store.list_cases()
    return Overview(
        active_cases=12,
        ai_containment_rate=42,
        average_resolution_minutes=11,
        qa_pass_rate=88,
        volume_by_theme=[
            {"theme": "VPN connectivity", "count": 38, "change": "+46%"},
            {"theme": "Password and access", "count": 31, "change": "+8%"},
            {"theme": "Teams audio", "count": 22, "change": "-4%"},
            {"theme": "Business applications", "count": 17, "change": "+12%"},
        ],
        recent_cases=recent[:5],
    )
