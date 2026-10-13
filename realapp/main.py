from collections import Counter
from datetime import datetime, timezone
import logging
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, SecretStr

from realapp.config import get_settings
from realapp.engine import create_engine
from realapp.local_secrets import load_local_openai_key, save_local_openai_key
from realapp.local_secrets import load_local_gemini_key, save_local_gemini_key
from realapp.models import (AnalysisRequest, CaseRecord, EngineeringBrief, EngineeringFollowup,
    KnowledgeArticle, KnowledgeArticleInput, TicketStateTransition, TicketUpdate, WorkNote, WorkNoteCreate)
from realapp.store import create_store
from realapp.livekit_setup import restore_livekit_settings
from realapp.incident_context import knowledge_context
from realapp.models import KnowledgeFromIncidentsRequest, CustomerIncidentCreate, Ticket, TranscriptTurn, Understanding, RoutingDecision, Attachment, VisualAnalysisPayload
from realapp.access import actor, can_read, can_report, require_case, visible_case
from realapp.resolved_knowledge import ResolvedKnowledgePublisher
from realapp.bulk_qa import BulkAudit
from realapp.attachments import (save_attachment, get_attachment_data, find_case_for_attachment,
                                 validate_attachment, MAX_FILES_PER_REQUEST, MAX_TOTAL_SIZE)
from realapp.resolution_radar import ResolutionRadar, evidence_digest
from realapp.incident_time_machine import compare_history, reconstruct as reconstruct_incident


settings = get_settings()
if settings.calling_backend != "memory":
    restore_livekit_settings(settings)
if settings.environment == "local" and settings.llm_provider == "openai" and not settings.openai_api_key:
    settings.openai_api_key = load_local_openai_key()
if settings.environment == 'local' and settings.llm_provider == 'google_ai' and not settings.gemini_api_key:
    settings.gemini_api_key = load_local_gemini_key()
store = create_store(settings)
engine = create_engine(settings, store.list_knowledge)
resolution_radar = ResolutionRadar(store, engine)
static_dir = Path(__file__).parent / "static"
logger = logging.getLogger(__name__)

app = FastAPI(title="ResolveAI API", version="2.0.0")
app.state.bulk_audit = BulkAudit()
app.mount("/static", StaticFiles(directory=static_dir), name="static")


def radar_service() -> ResolutionRadar:
    # Keep service dependencies aligned when the app is reconfigured in-process.
    resolution_radar.store, resolution_radar.engine = store, engine
    return resolution_radar


class OpenAIKeyRequest(BaseModel):
    api_key: SecretStr = Field(min_length=20)


def enforce_upload_request_limit(http: Request) -> None:
    length = http.headers.get("content-length")
    if length:
        try:
            if int(length) > MAX_TOTAL_SIZE + 1024 * 1024:
                raise HTTPException(413, "The complete upload request must be 21 MB or smaller.")
        except ValueError as exc:
            raise HTTPException(400, "Invalid Content-Length header.") from exc

class RadarStatusUpdate(BaseModel):
    status: Literal['new', 'investigating', 'monitoring', 'resolved', 'dismissed']
    note: str = Field(default='', max_length=400)


class RadarLinkReview(BaseModel):
    decision: Literal['confirmed', 'dismissed', 'unreviewed']


class EngineeringFollowupUpdate(BaseModel):
    brief: EngineeringBrief
    status: Literal['open', 'closed'] = 'open'


class CounterfactualRequest(BaseModel):
    decision_event_id: str = Field(min_length=1, max_length=160)
    alternative: Literal[
        'escalate_earlier', 'collect_diagnostic', 'avoid_repeat',
        'follow_documented', 'verify_before_resolve', 'wait_for_evidence',
    ]


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
async def customer_incident(http: Request):
    user = actor(http)
    content_type = http.headers.get('content-type', '').lower()
    attachments_with_content: list[tuple[Attachment, bytes]] = []

    if 'multipart/form-data' in content_type:
        enforce_upload_request_limit(http)
        form = await http.form(max_files=MAX_FILES_PER_REQUEST, max_fields=10, max_part_size=1024 * 1024)
        short_desc = str(form.get('short_description', '')).strip()
        description = str(form.get('description', '')).strip()
        service_name = str(form.get('service', 'General')).strip() or 'General'
        try:
            val = CustomerIncidentCreate(short_description=short_desc, description=description, service=service_name)
        except Exception as err:
            raise HTTPException(422, str(err)) from err

        uploads = form.getlist('attachments') or form.getlist('files')
        staged = []
        total_size = 0
        for upload in uploads:
            if not getattr(upload, 'filename', None):
                continue
            raw_bytes = await upload.read(MAX_TOTAL_SIZE + 1)
            total_size += len(raw_bytes)
            if total_size > MAX_TOTAL_SIZE:
                raise HTTPException(413, "Attachments exceed the 20 MB total upload limit.")
            validate_attachment(upload.filename, raw_bytes, upload.content_type)
            staged.append((upload, raw_bytes))
        for upload, raw_bytes in staged:
            att = save_attachment(upload.filename, raw_bytes, upload.content_type, settings)
            attachments_with_content.append((att, raw_bytes))
    else:
        try:
            body = await http.json()
            val = CustomerIncidentCreate.model_validate(body)
        except Exception as err:
            raise HTTPException(422, str(err)) from err

    case = CaseRecord(
        id=f'CASE-{uuid4().hex[:8].upper()}',
        customer_id=user['id'],
        created_by=user['id'],
        caller=user['name'],
        channel='Self service',
        transcript=[TranscriptTurn(speaker='Customer', text=val.description)],
        issue_title=val.short_description,
        handler_label='Human handling',
        understanding=Understanding(
            summary=val.description,
            intent='Customer-reported incident',
            product=val.service,
            urgency='Medium',
            sentiment='Unknown',
        ),
        routing=RoutingDecision(
            handler='Human',
            confidence=1,
            risk='Medium',
            rationale='Customer-reported incident awaiting technician assignment.',
        ),
        knowledge_matches=[],
        next_question='',
        recommended_action='Review and assign this incident.',
        ticket=Ticket(
            id=f'INC-{uuid4().hex[:8].upper()}',
            short_description=val.short_description,
            description=val.description,
            service=val.service,
            category='Incident',
            subcategory='Unclassified',
            priority='P3',
            assignment_group='Service Desk',
            attachments=[att for att, _ in attachments_with_content],
        ),
        qa_checks=[],
    )

    initial_notes = f'Short description : {val.short_description}\nDescription : {val.description}\nState : New'
    if attachments_with_content:
        initial_notes += f'\nAttachments : {len(attachments_with_content)} file(s) uploaded'

    case.ticket.work_notes.append(WorkNote(
        id=f'NOTE-{uuid4().hex[:8]}',
        author='Ticket created',
        author_type='System',
        text=initial_notes,
    ))

    if attachments_with_content:
        file_summary = ', '.join(att.filename for att, _ in attachments_with_content)
        try:
            visual = engine.analyze_visual(val.description, attachments_with_content)
            analysis_note = (
                f"Media analysis ({visual.analysis_source}) for {len(attachments_with_content)} file(s) [{file_summary}]:\n"
                f"• Observations: {visual.visual_observations}\n• Assessment: {visual.technical_diagnosis}\n"
                f"• Suggested classification: {visual.suggested_category} / {visual.suggested_subcategory} "
                f"(Priority: {visual.suggested_priority}; Service: {visual.suggested_service})\n"
                f"• Recommended action: {visual.recommended_action}"
            )
        except RuntimeError as exc:
            analysis_note = f"Media analysis unavailable for {len(attachments_with_content)} file(s) [{file_summary}]: {exc}"
        case.ticket.work_notes.append(WorkNote(id=f'NOTE-{uuid4().hex[:8].upper()}', author='Media analysis', author_type='System', text=analysis_note))

    return visible_case(store.save_case(case), user)


@app.get('/api/attachments/{attachment_id}')
def get_attachment(attachment_id: str, http: Request):
    user = actor(http)
    case = find_case_for_attachment(attachment_id, store)
    if not case or not can_read(case, user):
        raise HTTPException(404, 'Attachment not found.')
    att = next(att for att in case.ticket.attachments if att.id == attachment_id)
    data = get_attachment_data(attachment_id, att, settings)
    if not data:
        raise HTTPException(404, 'Attachment not found.')
    att, content = data
    return Response(
        content=content,
        media_type=att.content_type,
        headers={
            'Content-Disposition': f'inline; filename="{att.filename}"',
            'Content-Type': att.content_type,
            'Cache-Control': 'private, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
        },
    )


@app.post('/api/cases/{case_id}/attachments', response_model=CaseRecord)
async def add_case_attachment(case_id: str, http: Request):
    user = actor(http)
    case = require_case(store.get_case(case_id), user)
    enforce_upload_request_limit(http)
    form = await http.form(max_files=MAX_FILES_PER_REQUEST, max_fields=10, max_part_size=1024 * 1024)
    uploads = form.getlist('attachments') or form.getlist('files')
    if not uploads:
        raise HTTPException(400, 'No files provided.')

    new_attachments: list[tuple[Attachment, bytes]] = []
    staged = []
    total_size = 0
    for upload in uploads:
        if hasattr(upload, 'filename') and upload.filename:
            content = await upload.read(MAX_TOTAL_SIZE + 1)
            total_size += len(content)
            if total_size > MAX_TOTAL_SIZE:
                raise HTTPException(413, 'Attachments exceed the 20 MB total upload limit.')
            validate_attachment(upload.filename, content, upload.content_type)
            staged.append((upload, content))

    for upload, content in staged:
        att = save_attachment(upload.filename, content, upload.content_type, settings)
        new_attachments.append((att, content))

    if not new_attachments:
        raise HTTPException(400, 'No valid files provided.')

    for att, _ in new_attachments:
        case.ticket.attachments.append(att)

    file_summary = ', '.join(att.filename for att, _ in new_attachments)
    try:
        visual = engine.analyze_visual(case.ticket.description, new_attachments)
        analysis = (f"Media analysis ({visual.analysis_source}): {visual.visual_observations}\n"
                    f"Assessment: {visual.technical_diagnosis}\nRecommended action: {visual.recommended_action}")
    except RuntimeError as exc:
        analysis = f"Media analysis unavailable: {exc}"
    author_type = 'Customer' if user.get('role') == 'customer' else 'Technician'
    case.ticket.work_notes.append(WorkNote(
        id=f'NOTE-{uuid4().hex[:8].upper()}',
        author=user.get('name') or 'User',
        author_type=author_type,
        text=(
            f"Added {len(new_attachments)} media attachment(s) [{file_summary}].\n{analysis}"
        ),
    ))

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


def run_background_radar(case_id: str, force: bool = False):
    case = store.get_case(case_id)
    if not case or case.ticket.state != 'Resolved':
        return
    try:
        radar_service().assess(case, force=force)
    except Exception:
        logger.exception('Resolution durability assessment failed for incident %s', case_id)


def run_radar_assessments(case_ids: list[str]):
    for case_id in case_ids:
        run_background_radar(case_id)


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
    if before['state'] != case.ticket.state:
        case.state_history.append(TicketStateTransition(from_state=before['state'],
            to_state=case.ticket.state, changed_by=user['name'] if user else 'System'))
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
        background_tasks.add_task(run_background_radar, case.id)
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
    return app.state.bulk_audit.status(actor(http)['id'])


@app.get('/api/reporting/tickets', response_model=list[CaseRecord])
def reporting_tickets(http: Request):
    user = actor(http)
    if user['role'] not in {'admin', 'technician'}:
        raise HTTPException(403, 'Technician access is required.')
    return [visible_case(case, user) for case in store.list_cases() if can_report(case, user)]


@app.post('/api/qa/rerun-all', status_code=202)
def rerun_all_qa(http: Request, background_tasks: BackgroundTasks):
    user = actor(http)
    if user['role'] not in {'admin', 'technician'}:
        raise HTTPException(403, 'Technician access is required.')
    job, ids = app.state.bulk_audit.start([case for case in store.list_cases() if can_report(case, user)], user['id'])
    if ids:
        background_tasks.add_task(app.state.bulk_audit.run, ids, store, engine, user['id'], lambda case: can_report(case, user))
    return job


@app.post("/api/cases/{case_id}/qa", response_model=CaseRecord)
def rerun_qa(case_id: str, http: Request):
    case = store.get_case(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    if not can_report(case, actor(http)):
        raise HTTPException(404, 'Audit not found.')
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


def _require_radar_user(http: Request) -> dict:
    user = actor(http)
    if user['role'] not in {'admin', 'technician'}:
        raise HTTPException(403, 'Technician access is required.')
    return user


@app.get('/api/cases/{case_id}/time-machine')
def get_incident_time_machine(case_id: str, http: Request):
    user = _require_radar_user(http)
    case = require_case(store.get_case(case_id), user)
    # Use the same transcript and QA visibility rules as the incident detail API.
    safe_case = visible_case(case, user)
    assessment = store.get_resolution_assessment(case_id) if can_report(case, user) else None
    if assessment and assessment.evidence_digest != evidence_digest(case):
        assessment = None
    result = reconstruct_incident(safe_case, assessment)
    if user['role'] == 'technician' and not can_report(case, user):
        result['warnings'].append('Transcript and QA details are hidden for incidents assigned to another technician; this reconstruction is partial.')
    return result


@app.post('/api/cases/{case_id}/time-machine/counterfactual')
def explore_incident_alternative(case_id: str, request: CounterfactualRequest, http: Request):
    user = _require_radar_user(http)
    case = require_case(store.get_case(case_id), user)
    safe_case = visible_case(case, user)
    reconstruction = reconstruct_incident(safe_case)
    events = reconstruction['events']
    decision = next((item for item in events if item['id'] == request.decision_event_id), None)
    decision_types = {'technician_action', 'failed_attempt', 'status_change'}
    if not decision or decision['type'] not in decision_types or not decision['occurred_at']:
        raise HTTPException(422, 'Choose a dated technician action, failed attempt, or status decision.')

    alternatives = {
        'escalate_earlier': 'Escalate to a human technician at this point.',
        'collect_diagnostic': 'Collect a relevant diagnostic signal before trying another fix.',
        'avoid_repeat': 'Avoid repeating the same unsuccessful troubleshooting step without new evidence.',
        'follow_documented': 'Use a documented troubleshooting procedure that existed at this point.',
        'verify_before_resolve': 'Verify the fix with the customer before marking the incident resolved.',
        'wait_for_evidence': 'Wait for additional evidence before choosing a diagnosis or fix.',
    }
    before = [item for item in events if item['occurred_at'] and item['occurred_at'] < decision['occurred_at']]
    after = [item for item in events if item['occurred_at'] and item['occurred_at'] > decision['occurred_at']]
    event_view = lambda item: {
        'id': item['id'], 'timestamp': item['occurred_at'], 'type': item['type'],
        'actor': item['actor'], 'title': item['title'], 'evidence': item['detail'][:1200],
        'recorded_outcome': item['outcome'],
    }
    available_before = before[-20:]
    observed_after = after[:12]
    try:
        scenario = engine.explore_counterfactual(
            f"{decision['title']}: {decision['detail']}", alternatives[request.alternative],
            [event_view(item) for item in available_before],
            [event_view(item) for item in observed_after],
        )
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error
    except Exception:
        logger.exception('Incident counterfactual generation failed for %s', case_id)
        raise HTTPException(502, 'Could not create a structured alternative from this incident evidence.') from None

    allowed_evidence = {item['id'] for item in available_before}
    cited = set(scenario.supporting_evidence_ids + scenario.contradicting_evidence_ids)
    cited.update(evidence_id for step in scenario.steps for evidence_id in step.evidence_ids)
    if not cited.issubset(allowed_evidence):
        raise HTTPException(502, 'The generated scenario cited evidence unavailable at that decision point. Please retry.')
    return {
        'label': 'SIMULATED ALTERNATIVE — NOT AN OBSERVED OUTCOME',
        'decision_point': decision,
        'alternative': alternatives[request.alternative],
        'evidence_available_before_decision': [event_view(item) for item in available_before],
        'events_at_same_timestamp_order_unknown': [event_view(item) for item in events
                                                   if item['id'] != decision['id']
                                                   and item['occurred_at'] == decision['occurred_at']],
        'observed_later_events': [event_view(item) for item in observed_after],
        'scenario': scenario.model_dump(mode='json'),
        'historical_validation': {
            'status': 'not_established', 'comparable_count': 0,
            'message': 'This incident alone cannot validate what the alternative would have caused. No success rate or time savings is inferred.',
        },
    }


@app.post('/api/cases/{case_id}/time-machine/validate')
def validate_incident_alternative(case_id: str, request: CounterfactualRequest, http: Request):
    user = _require_radar_user(http)
    case = require_case(store.get_case(case_id), user)
    reconstruction = reconstruct_incident(visible_case(case, user))
    decision = next((item for item in reconstruction['events'] if item['id'] == request.decision_event_id), None)
    if not decision or decision['type'] not in {'technician_action', 'failed_attempt', 'status_change'} or not decision['occurred_at']:
        raise HTTPException(422, 'Choose a dated technician action, failed attempt, or status decision.')
    candidates = [item for item in store.list_cases() if can_read(item, user)]
    comparison = compare_history(case, candidates)
    return {
        'decision_point': decision,
        'alternative': request.alternative,
        'strategy_validation': {
            'status': 'not_established',
            'message': 'The incident store does not consistently record alternative strategies as structured actions, so this cohort cannot estimate their effect.',
        },
        'historical_context': comparison,
    }


@app.get('/api/resolution-radar')
def get_resolution_radar(http: Request, window: str = '30d', service: str = '',
                         priority: str = '', status: str = '', search: str = '', sort: str = 'debt'):
    _require_radar_user(http)
    if window not in {'7d', '30d', '90d', 'all'}:
        raise HTTPException(422, 'Select a supported time window.')
    if sort not in {'debt', 'recurrence', 'severity', 'recent'}:
        raise HTTPException(422, 'Select a supported sort order.')
    return radar_service().snapshot(window=window, service=service, priority=priority,
                                    status=status, search=search, sort=sort)


@app.post('/api/resolution-radar/analyze-missing', status_code=202)
def analyze_missing_resolutions(http: Request, background_tasks: BackgroundTasks):
    _require_radar_user(http)
    assessments = {item.case_id: item for item in store.list_resolution_assessments()}
    stale = [case for case in store.list_cases() if case.ticket.state == 'Resolved'
             and (case.id not in assessments or assessments[case.id].evidence_digest != evidence_digest(case))]
    selected = stale[:25]
    if selected:
        background_tasks.add_task(run_radar_assessments, [case.id for case in selected])
    return {'scheduled': len(selected), 'remaining': max(0, len(stale) - len(selected)),
            'message': 'Resolution assessments are running in the background.' if selected else 'All resolved incidents are up to date.'}


@app.get('/api/resolution-radar/clusters/{cluster_id}')
def get_resolution_cluster(cluster_id: str, http: Request):
    _require_radar_user(http)
    return radar_service().detail(cluster_id)


@app.patch('/api/resolution-radar/clusters/{cluster_id}')
def update_resolution_cluster(cluster_id: str, update: RadarStatusUpdate, http: Request):
    user = _require_radar_user(http)
    cluster = radar_service().change_status(cluster_id, update.status, user['name'], update.note)
    return cluster.model_dump(mode='json')


@app.patch('/api/resolution-radar/clusters/{cluster_id}/links/{case_id}')
def review_resolution_link(cluster_id: str, case_id: str, update: RadarLinkReview, http: Request):
    _require_radar_user(http)
    return radar_service().review_link(cluster_id, case_id, update.decision).model_dump(mode='json')


@app.post('/api/resolution-radar/clusters/{cluster_id}/engineering-followups', status_code=201)
def create_engineering_followup(cluster_id: str, http: Request):
    user = _require_radar_user(http)
    try:
        result = radar_service().generate_followup(cluster_id, user['name'])
    except HTTPException:
        raise
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error
    except Exception:
        logger.exception('Engineering brief generation failed for cluster %s', cluster_id)
        raise HTTPException(502, 'Could not generate the engineering brief from linked incident evidence.') from None
    return result.model_dump(mode='json')


@app.patch('/api/resolution-radar/engineering-followups/{followup_id}')
def update_engineering_followup(followup_id: str, update: EngineeringFollowupUpdate, http: Request):
    _require_radar_user(http)
    if update.status not in {'open', 'closed'}:
        raise HTTPException(422, 'Select open or closed.')
    current = store.get_engineering_followup(followup_id)
    if not current:
        raise HTTPException(404, 'Engineering follow-up not found.')
    current.brief = update.brief
    current.status = update.status
    current.updated_at = datetime.now(timezone.utc)
    return store.save_engineering_followup(current).model_dump(mode='json')


@app.get('/api/cases/{case_id}/resolution-radar')
def get_case_resolution_radar(case_id: str, http: Request, background_tasks: BackgroundTasks):
    user = _require_radar_user(http)
    case = require_case(store.get_case(case_id), user)
    assessment = store.get_resolution_assessment(case_id)
    if assessment and assessment.evidence_digest != evidence_digest(case):
        assessment = None
    if case.ticket.state == 'Resolved' and (not assessment or assessment.evidence_digest != evidence_digest(case)):
        background_tasks.add_task(run_background_radar, case_id)
    clusters = radar_service()._materialize(store.list_cases())
    cluster = next((item for item in clusters if any(link.case_id == case_id for link in item.links)), None)
    link = next((item for item in cluster.links if item.case_id == case_id), None) if cluster else None
    return {'assessment': assessment.model_dump(mode='json') if assessment else None,
            'cluster_id': cluster.id if cluster else None,
            'relation_type': link.link_type if link else None,
            'related_ticket_ids': [item.ticket_id for item in cluster.links if item.case_id != case_id] if cluster else [],
            'recurrence_ticket_ids': [item.ticket_id for item in cluster.links if item.link_type == 'recurrence'] if cluster else []}


@app.post('/api/cases/{case_id}/resolution-radar', status_code=202)
def rerun_case_resolution_radar(case_id: str, http: Request, background_tasks: BackgroundTasks):
    user = _require_radar_user(http)
    case = require_case(store.get_case(case_id), user)
    if case.ticket.state != 'Resolved':
        raise HTTPException(409, 'Resolve the incident before reassessing its durability.')
    background_tasks.add_task(run_background_radar, case_id, True)
    return {'scheduled': True, 'message': 'Resolution durability reassessment queued.'}


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
    user = actor(http)
    if user['role'] not in {'admin', 'technician'}:
        raise HTTPException(403, 'Staff access is required to add knowledge.')
    if article.source_ticket_ids:
        article.source_ticket_ids = [case.ticket.id for case in find_incidents(article.source_ticket_ids, user)]
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
    cases = [case for case in store.list_cases() if can_report(case, user)]
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
