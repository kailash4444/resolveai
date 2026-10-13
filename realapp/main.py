from collections import Counter
import logging
from pathlib import Path
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, SecretStr

from realapp.config import get_settings
from realapp.engine import create_engine
from realapp.local_secrets import load_local_openai_key, save_local_openai_key
from realapp.local_secrets import load_local_gemini_key, save_local_gemini_key
from realapp.models import AnalysisRequest, CaseRecord, KnowledgeArticle, KnowledgeArticleInput, TicketUpdate, WorkNote, WorkNoteCreate
from realapp.store import create_store
from realapp.livekit_setup import restore_livekit_settings
from realapp.incident_context import knowledge_context
from realapp.models import KnowledgeFromIncidentsRequest, CustomerIncidentCreate, Ticket, TranscriptTurn, Understanding, RoutingDecision
from realapp.access import actor, can_read, require_case, visible_case
from realapp.resolved_knowledge import ResolvedKnowledgePublisher
from realapp.bulk_qa import BulkAudit


settings = get_settings()
if settings.calling_backend != "memory":
    restore_livekit_settings(settings)
if settings.environment == "local" and settings.llm_provider == "openai" and not settings.openai_api_key:
    settings.openai_api_key = load_local_openai_key()
if settings.environment == 'local' and settings.llm_provider == 'google_ai' and not settings.gemini_api_key:
    settings.gemini_api_key = load_local_gemini_key()
store = create_store(settings)
engine = create_engine(settings, store.list_knowledge)
static_dir = Path(__file__).parent / "static"
logger = logging.getLogger(__name__)

app = FastAPI(title="ResolveAI API", version="2.0.0")
app.state.bulk_audit = BulkAudit()
app.mount("/static", StaticFiles(directory=static_dir), name="static")


class OpenAIKeyRequest(BaseModel):
    api_key: SecretStr = Field(min_length=20)


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(static_dir / "index.html")


@app.get("/support", include_in_schema=False)
def support_page(http: Request):
    if not app.state.calling.authenticate(http.cookies.get('resolveai_session')):
        return RedirectResponse('/?next=support', status_code=303)
    return FileResponse(static_dir / "support.html")


@app.get("/api/health")
def health():
    return {"status": "ok", "service": settings.app_name, "environment": settings.environment}


@app.get("/api/config")
def config(http: Request):
    configured = getattr(engine, "configured", settings.provider_configured)
    return {
        "provider": settings.llm_provider,
        "model": settings.openai_model if settings.llm_provider == "openai" else settings.gemini_model,
        "transcription_model": settings.active_transcription_model,
        "speech_model": settings.active_tts_model,
        "embedding_model": settings.openai_embedding_model if settings.llm_provider == "openai" else settings.embedding_model,
        "data_backend": settings.data_backend,
        "configured": configured,
        "runtime_key_supported": actor(http)["role"] == "admin" and settings.llm_provider in {'openai', 'google_ai'} and settings.environment == "local",
    }


@app.post("/api/config/openai-key")
def configure_openai_key(request: OpenAIKeyRequest):
    if settings.environment != "local":
        raise HTTPException(status_code=403, detail="Website key entry is disabled outside local development. Configure OPENAI_API_KEY with your deployment secret manager.")
    if settings.llm_provider != "openai" or not hasattr(engine, "set_api_key"):
        raise HTTPException(status_code=409, detail="The active provider is not OpenAI.")
    try:
        value = request.api_key.get_secret_value()
        engine.set_api_key(value)
        save_local_openai_key(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"configured": True, "provider": "openai", "stored": "protected-local-profile", "model": settings.openai_model}


@app.post('/api/config/gemini-key')
def configure_gemini_key(request: OpenAIKeyRequest):
    if settings.environment != 'local' or settings.llm_provider != 'google_ai':
        raise HTTPException(403, 'Configure the Gemini key locally, or use the GCP service identity for Vertex AI.')
    value = request.api_key.get_secret_value().strip()
    if len(value) < 20:
        raise HTTPException(422, 'The Gemini API key appears incomplete.')
    try:
        save_local_gemini_key(value)
        engine.set_api_key(value)
    except OSError:
        raise HTTPException(503, 'Could not save the protected Gemini key.') from None
    return {'configured': True, 'provider': 'google_ai', 'stored': 'protected-local-profile', 'model': settings.gemini_model}


@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    if not hasattr(engine, "transcribe"):
        raise HTTPException(status_code=409, detail="The selected provider does not support audio transcription.")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=422, detail="The uploaded audio file is empty.")
    if len(content) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio files must be 25 MB or smaller.")
    try:
        text = engine.transcribe(file.filename or "recording.webm", content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Audio transcription failed. Check your AI configuration and model access.") from exc
    return {"text": text, "model": settings.active_transcription_model}


@app.post("/api/analyze", response_model=CaseRecord)
def analyze(request: AnalysisRequest, http: Request):
    try:
        case = engine.analyze(request)
        owner = actor(http)
        case.created_by = owner['id']
        if owner['role'] == 'technician':
            case.ticket.assigned_user_id, case.ticket.assigned_to = owner['id'], owner['name']
        initial_fields = [
            ("Short description", case.ticket.short_description), ("Description", case.ticket.description),
            ("Category", case.ticket.category), ("Subcategory", case.ticket.subcategory),
            ("Service", case.ticket.service), ("Priority", case.ticket.priority),
            ("Assignment group", case.ticket.assignment_group), ("State", case.ticket.state),
        ]
        initial_history = "\n".join(f"{label} : {value}" for label, value in initial_fields)
        case.ticket.work_notes.append(WorkNote(id=f"NOTE-{uuid4().hex[:8].upper()}", author="Ticket created", author_type="System", text=initial_history))
        return store.save_case(case)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM processing failed: {exc}") from exc


@app.post('/api/customer/incidents', response_model=CaseRecord, status_code=201)
def customer_incident(value: CustomerIncidentCreate, http: Request):
    user = actor(http)
    case = CaseRecord(id=f'CASE-{uuid4().hex[:8].upper()}', customer_id=user['id'], created_by=user['id'],
        caller=user['name'], channel='Self service', transcript=[TranscriptTurn(speaker='Customer', text=value.description)],
        issue_title=value.short_description, handler_label='Human handling',
        understanding=Understanding(summary=value.description, intent='Customer-reported incident', product=value.service, urgency='Medium', sentiment='Unknown'),
        routing=RoutingDecision(handler='Human',confidence=1,risk='Medium',rationale='Customer-reported incident awaiting technician assignment.'),
        knowledge_matches=[], next_question='', recommended_action='Review and assign this incident.',
        ticket=Ticket(id=f'INC-{uuid4().hex[:8].upper()}',short_description=value.short_description,description=value.description,
            service=value.service,category='Incident',subcategory='Unclassified',priority='P3',assignment_group='Service Desk'),qa_checks=[])
    case.ticket.work_notes.append(WorkNote(id=f'NOTE-{uuid4().hex[:8]}',author='Ticket created',author_type='System',
        text=f'Short description : {value.short_description}\nDescription : {value.description}\nState : New'))
    return visible_case(store.save_case(case), user)


@app.get("/api/cases", response_model=list[CaseRecord])
def list_cases(http: Request, ticket_number: str = '', assigned_to: str = ''):
    user = actor(http)
    return [visible_case(case, user) for case in store.list_cases() if can_read(case, user)
            and ticket_number.strip().casefold() in case.ticket.id.casefold()
            and (not assigned_to or (not case.ticket.assigned_to if assigned_to == '__unassigned__'
                 else assigned_to.strip().casefold() == case.ticket.assigned_to.casefold()))]


@app.get("/api/cases/{case_id}", response_model=CaseRecord)
def get_case(case_id: str, http: Request):
    user = actor(http)
    return visible_case(require_case(store.get_case(case_id), user), user)


def run_background_qa(case_id: str):
    case = store.get_case(case_id)
    if not case or case.ticket.state != "Resolved":
        return
    try:
        audit = engine.audit(case)
    except Exception:
        return
    store.save_audit(case, audit)


def run_background_knowledge(case_id: str):
    def lookup_call(call_id):
        try:
            return app.state.calling.get(call_id)
        except HTTPException as error:
            if error.status_code != 404:
                raise
            return None

    try:
        ResolvedKnowledgePublisher(store, store, engine, lookup_call).publish(case_id)
    except Exception:
        logger.exception("Automatic knowledge publishing failed for incident %s", case_id)


@app.patch("/api/cases/{case_id}/ticket", response_model=CaseRecord)
def update_ticket(case_id: str, update: TicketUpdate, background_tasks: BackgroundTasks, http: Request = None):
    case = store.get_case(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    user = actor(http) if http else None
    if user:
        require_case(case, user)
    if user and (update.assigned_user_id is not None or update.assigned_to is not None):
        if user['role'] != 'admin':
            if update.assigned_user_id not in {None, case.ticket.assigned_user_id} or update.assigned_to not in {None, case.ticket.assigned_to}:
                raise HTTPException(403, 'Only the administrator can reassign incidents.')
        else:
            users = app.state.calling.snapshot()['technicians']
            candidates = [u for u in users if u['role'] in {'admin','technician'} and
                (u['id'] == update.assigned_user_id if update.assigned_user_id is not None else u['name'] == update.assigned_to)]
            clearing = update.assigned_user_id == '' or update.assigned_user_id is None and update.assigned_to == ''
            if not clearing and len(candidates) != 1:
                raise HTTPException(422, 'Select a valid technician account.')
            if case.ticket.call_id:
                try:
                    linked = app.state.calling.get(case.ticket.call_id)
                except HTTPException:
                    linked = None
                if linked and linked['status'] in {'Ringing','Connected'} and (clearing or candidates[0]['id'] != linked['technician_id']):
                    raise HTTPException(409, 'Finish or transfer the active call before reassigning its incident.')
            update.assigned_user_id = '' if clearing else candidates[0]['id']
            update.assigned_to = '' if clearing else candidates[0]['name']
    changes = update.model_dump(exclude_none=True)
    tracked_fields = ["short_description", "description", "category", "subcategory", "service", "priority", "assignment_group", "assigned_to", "state", "resolution"]
    before = {field: getattr(case.ticket, field) for field in tracked_fields}
    proposed_state = changes.get("state", case.ticket.state)
    proposed_resolution = changes.get("resolution", case.ticket.resolution).strip()
    if proposed_state == "Resolved" and not proposed_resolution:
        raise HTTPException(status_code=422, detail="Resolution notes are required before resolving the ticket.")
    if proposed_state != "Resolved" and changes.get("resolution", "").strip():
        raise HTTPException(status_code=422, detail="Resolution notes can be entered only when the ticket is resolved.")
    for field, value in changes.items():
        setattr(case.ticket, field, value)
    case.status = "Resolved" if case.ticket.state == "Resolved" else "Open"
    if case.ticket.state != "Resolved":
        case.ticket.resolution = ""
        case.qa_checks = []
        case.quality_score = None
    after = {field: getattr(case.ticket, field) for field in tracked_fields}
    changed_fields = [field for field in tracked_fields if before[field] != after[field]]
    if changed_fields:
        labels = {
            "short_description": "Short description", "description": "Description", "category": "Category",
            "subcategory": "Subcategory", "service": "Service", "priority": "Priority",
            "assignment_group": "Assignment group", "state": "State", "resolution": "Resolution notes",
            "assigned_to": "Assigned to",
        }
        def display(value):
            text = str(value).strip()
            return text if text else "Empty"
        history = "\n".join(
            f"{labels[field]} : {display(after[field])} was {display(before[field])}"
            for field in changed_fields
        )
        case.ticket.work_notes.append(WorkNote(id=f"NOTE-{uuid4().hex[:8].upper()}", author="Ticket history", author_type="System", text=history))
    if case.ticket.state == "Resolved" and changed_fields:
        case.qa_checks = []
        case.quality_score = None
    saved = store.save_case(case)
    if case.ticket.state == "Resolved" and changed_fields:
        background_tasks.add_task(run_background_qa, case.id)
        background_tasks.add_task(run_background_knowledge, case.id)
    return visible_case(saved,user) if user else saved


@app.post("/api/cases/{case_id}/work-notes", response_model=CaseRecord)
def add_work_note(case_id: str, note: WorkNoteCreate, http: Request):
    case = store.get_case(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    require_case(case, actor(http))
    if case.ticket.state == "New":
        raise HTTPException(status_code=409, detail="Move the ticket to In Progress before adding work notes or comments.")
    user = actor(http)
    require_case(case, user)
    case.ticket.work_notes.append(WorkNote(id=f"NOTE-{uuid4().hex[:8].upper()}", author=user['name'],
        author_type='Customer' if user['role'] == 'customer' else 'Technician', text=note.text))
    return visible_case(store.save_case(case), user)


@app.get('/api/qa/rerun-all')
def bulk_qa_status(http: Request):
    if actor(http)['role'] not in {'admin', 'technician'}:
        raise HTTPException(403, 'Technician access is required.')
    return app.state.bulk_audit.status()


@app.post('/api/qa/rerun-all', status_code=202)
def rerun_all_qa(http: Request, background_tasks: BackgroundTasks):
    user = actor(http)
    if user['role'] not in {'admin', 'technician'}:
        raise HTTPException(403, 'Technician access is required.')
    job, ids = app.state.bulk_audit.start([case for case in store.list_cases() if can_read(case, user)])
    if ids:
        background_tasks.add_task(app.state.bulk_audit.run, ids, store, engine)
    return job


@app.post("/api/cases/{case_id}/qa", response_model=CaseRecord)
def rerun_qa(case_id: str, http: Request):
    case = store.get_case(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    require_case(case, actor(http))
    if case.ticket.state != "Resolved":
        raise HTTPException(status_code=409, detail="AI QA runs only after the ticket is resolved.")
    try:
        audit = engine.audit(case)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM QA failed: {exc}") from exc
    user = actor(http)
    return visible_case(require_case(store.save_audit(case, audit), user),user)


@app.get("/api/knowledge", response_model=list[KnowledgeArticle])
def list_knowledge(http: Request):
    user = actor(http)
    visible_ids = {case.ticket.id for case in store.list_cases() if can_read(case, user)}
    articles = [article.model_copy(deep=True) for article in store.list_knowledge()]
    for article in articles:
        if user['role'] != 'admin':
            article.source_ticket_ids = [number for number in article.source_ticket_ids if number in visible_ids]
    return articles


@app.post("/api/knowledge", response_model=KnowledgeArticle, status_code=201)
def add_knowledge(article: KnowledgeArticleInput, http: Request):
    if article.source_ticket_ids:
        article.source_ticket_ids = [case.ticket.id for case in find_incidents(article.source_ticket_ids, actor(http))]
    return store.add_knowledge(article)


def find_incidents(ticket_numbers, user):
    numbers = list(dict.fromkeys(number.strip().upper() for number in ticket_numbers))
    if not numbers or any(not number or len(number) > 80 for number in numbers):
        raise HTTPException(422, 'Enter valid incident numbers, such as INC0000001.')
    by_number = {case.ticket.id.upper(): case for case in store.list_cases() if can_read(case, user)}
    missing = [number for number in numbers if number not in by_number]
    if missing:
        raise HTTPException(404, 'Incidents not found: ' + ', '.join(missing))
    return [by_number[number] for number in numbers]


@app.post('/api/knowledge/from-incidents')
def draft_knowledge_from_incidents(request: KnowledgeFromIncidentsRequest, http: Request):
    cases = find_incidents(request.ticket_numbers, actor(http))
    def lookup_call(call_id):
        try:
            return app.state.calling.get(call_id)
        except HTTPException as error:
            if error.status_code != 404:
                raise
            return None
    context, warnings = knowledge_context(cases, lookup_call)
    if len(context) > 120_000:
        raise HTTPException(422, 'These incidents contain too much source material for one draft. Select fewer tickets.')
    try:
        content = engine.draft_knowledge(context)
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error
    except Exception:
        raise HTTPException(502, 'The knowledge draft could not be generated. Please try again.') from None
    article = KnowledgeArticleInput(**content.model_dump(), source_ticket_ids=[case.ticket.id for case in cases])
    return {'article': article, 'warnings': warnings,
            'sources': [{'ticket_id': case.ticket.id, 'case_id': case.id, 'state': case.ticket.state,
                         'channel': case.channel} for case in cases]}


@app.get("/api/overview")
def overview(http: Request):
    user = actor(http)
    cases = [case for case in store.list_cases() if can_read(case, user)]
    handler_counts = Counter(case.routing.handler for case in cases)
    themes = Counter(case.ticket.category for case in cases)
    scored = [case.quality_score for case in cases if case.quality_score is not None]
    return {
        "total_cases": len(cases),
        "open_cases": sum(case.ticket.state != "Resolved" for case in cases),
        "ai_handled": handler_counts.get("AI", 0),
        "human_handled": handler_counts.get("Human", 0),
        "average_quality": round(sum(scored) / len(scored)) if scored else 0,
        "themes": [{"name": name, "count": count} for name, count in themes.most_common(6)],
        "recent_cases": cases[:5],
    }


from realapp.calling_api import install_calling

calling = install_calling(app, settings, store, engine, update_ticket)

# Convert public numbers and all call-side references together on startup.
from realapp.numbering import rewrite
number_aliases = store.migrate_numbers()
if number_aliases:
    def migrate_call_references(db):
        db['calls'] = rewrite(db['calls'],number_aliases)
    calling.repository.mutate(migrate_call_references)
