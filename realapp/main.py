from collections import Counter
import logging
from pathlib import Path
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile, Request, Response
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
from realapp.models import KnowledgeFromIncidentsRequest, CustomerIncidentCreate, Ticket, TranscriptTurn, Understanding, RoutingDecision, Attachment, VisualAnalysisPayload, AssistFeedback, AIAssist
from datetime import datetime, timezone
from realapp.incident_assist import ai_analysed, assess, escalate
from realapp.access import actor, can_read, can_report, require_case, visible_case
from realapp.resolved_knowledge import ResolvedKnowledgePublisher
from realapp.bulk_qa import BulkAudit
from realapp.attachments import (save_attachment, get_attachment_data, find_case_for_attachment,
                                 validate_attachment, is_image, MAX_FILES_PER_REQUEST, MAX_TOTAL_SIZE)


settings = get_settings()
if settings.calling_backend != "memory":
    restore_livekit_settings(settings)
if settings.environment == "local" and not settings.openai_api_key:
    settings.openai_api_key = load_local_openai_key()
if not settings.gemini_api_key:
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


def enforce_upload_request_limit(http: Request) -> None:
    length = http.headers.get("content-length")
    if length:
        try:
            if int(length) > MAX_TOTAL_SIZE + 1024 * 1024:
                raise HTTPException(413, "The complete upload request must be 21 MB or smaller.")
        except ValueError as exc:
            raise HTTPException(400, "Invalid Content-Length header.") from exc


@app.get("/", include_in_schema=False)
@app.get("/login", include_in_schema=False)
@app.get("/signup", include_in_schema=False)
def index():
    return FileResponse(static_dir / "index.html")


@app.get("/staff/login", include_in_schema=False)
def staff_login():
    """Old staff log-in address: the one log-in page, with the Technician / Admin side selected."""
    return RedirectResponse("/login?as=staff", status_code=307)


@app.get("/portal", include_in_schema=False)
@app.get("/console", include_in_schema=False)
@app.get("/admin", include_in_schema=False)
def workspace_page():
    """Serve the same authenticated app shell for its role-specific entry URLs."""
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
async def customer_incident(http: Request, background_tasks: BackgroundTasks):
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
        valid_uploads = [u for u in uploads if getattr(u, 'filename', None)]
        if len(valid_uploads) > 3:
            raise HTTPException(400, "You can submit up to 3 images only.")
        for upload in valid_uploads:
            if not is_image(upload.filename):
                raise HTTPException(415, "File type is not supported. Only image uploads (up to 3 images) are currently supported.")

        staged = []
        total_size = 0
        for upload in valid_uploads:
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

    # Analysis and AI assistance run after the response, so the customer gets their ticket number immediately.
    case.assist = AIAssist(status='pending', reason='The AI assistant is reviewing the report and any images.')
    background_tasks.add_task(run_incident_assist, case.id, attachments_with_content)
    return visible_case(store.save_case(case), user)


def analyse_images(case: CaseRecord, images: list[tuple[Attachment, bytes]]) -> tuple[VisualAnalysisPayload | None, str]:
    """Analyse images onto the ticket and return (result, work-note text). Only real AI analysis may fill in ticket fields."""
    files, count = ', '.join(att.filename for att, _ in images), len(images)
    try:
        visual = engine.analyze_visual(case.ticket.description, images)
    except RuntimeError as exc:
        return None, f"Image analysis unavailable for {count} image(s) [{files}]: {exc}"
    case.ticket.visual_analysis = visual
    if not ai_analysed(visual):
        configured = engine.configured() if callable(engine.configured) else engine.configured  # method on OpenAI, property on Gemini
        why = ("this server runs in demo mode" if 'demo' in visual.analysis_source.lower() else
               "AI image analysis isn't set up" if not configured else "the AI service didn't respond")
        return visual, (f"Image analysis unavailable for {count} image(s) [{files}]: {why}, so the images weren't read. "
                        "A keyword-based estimate was saved as a suggestion only; ticket fields were not changed. "
                        "Staff can re-run the analysis from the Image analysis section.")
    if visual.suggested_service and case.ticket.service in {'General', ''}:
        case.ticket.service = visual.suggested_service
        case.understanding.product = visual.suggested_service
    if visual.suggested_priority and case.ticket.priority == 'P3':
        case.ticket.priority = visual.suggested_priority
    if visual.suggested_category and case.ticket.category == 'Incident':
        case.ticket.category = visual.suggested_category
    if visual.suggested_subcategory and case.ticket.subcategory in {'Unclassified', 'Investigation', 'Triage'}:
        case.ticket.subcategory = visual.suggested_subcategory
    if visual.recommended_action:
        case.recommended_action = visual.recommended_action
    return visual, f"Image analysed by {visual.analysis_source} · {count} image(s) [{files}]. Findings are in Image analysis."


@app.post('/api/cases/{case_id}/image-analysis', response_model=CaseRecord)
def rerun_image_analysis(case_id: str, http: Request):
    """Staff re-run image analysis on a ticket's saved images (e.g. after the AI service was unavailable)."""
    user = actor(http)
    if user['role'] not in {'admin', 'technician'}:
        raise HTTPException(403, 'Only staff can re-run image analysis.')
    case = require_case(store.get_case(case_id), user)
    images = [data for att in case.ticket.attachments if att.content_type.startswith('image/')
              if (data := get_attachment_data(att.id, att, settings))]
    if not images:
        raise HTTPException(400, 'This ticket has no saved images to analyse.')
    # Work on a copy: a failed re-run must not replace an earlier result with a keyword estimate.
    updated = case.model_copy(deep=True)
    visual, note = analyse_images(updated, images)
    if visual is None or not ai_analysed(visual):
        reason = note.split(': ', 1)[-1].split(', so the images')[0]
        raise HTTPException(503, f"Image analysis didn't run: {reason}. The ticket wasn't changed; try again in a minute.")
    updated.ticket.work_notes.append(WorkNote(id=f'NOTE-{uuid4().hex[:8].upper()}', author=user.get('name') or 'Staff',
                                              author_type='Technician', text=f"Re-ran image analysis.\n{note}"))
    return visible_case(store.save_case(updated), user)


def run_incident_assist(case_id: str, attachments_with_content: list[tuple[Attachment, bytes]]):
    """Image analysis, then AI self-help or a technician handover. Runs in the background after creation."""
    case = store.get_case(case_id)
    if not case or not case.assist or case.assist.status != 'pending':
        return
    notes_before = len(case.ticket.work_notes)
    try:
        visual = None
        if attachments_with_content:
            visual, analysis_note = analyse_images(case, attachments_with_content)
            case.ticket.work_notes.append(WorkNote(id=f'NOTE-{uuid4().hex[:8].upper()}', author='Image analysis', author_type='System', text=analysis_note))

        # AI-first help from approved knowledge; otherwise hand the ticket and its analysis to a technician.
        case.assist = assess(case, visual, bool(attachments_with_content), engine, settings)
        if case.assist.status == 'escalated':
            escalate(case, case.assist.reason, app.state.calling.snapshot()['technicians'], store.list_cases())
        else:
            case.routing.handler, case.handler_label = 'AI', 'AI handling'
            case.routing.rationale = 'AI offered self-help steps from approved knowledge; the customer confirms the fix or asks for a technician.'
            case.ticket.work_notes.append(WorkNote(id=f'NOTE-{uuid4().hex[:8].upper()}', author='AI assistance', author_type='System',
                text=f"AI assistance : offered {len(case.assist.steps)} self-help step(s) from {', '.join(case.assist.knowledge_ids)}\nWaiting for : the customer to confirm the fix or ask for a technician"))
    except Exception:
        logger.exception('AI assistance failed for incident %s', case_id)
        case.assist = AIAssist(status='escalated', reason='The AI assistant ran into a problem, so a technician will help you.')
        escalate(case, case.assist.reason, app.state.calling.snapshot()['technicians'], store.list_cases())

    # Merge onto the latest record so a comment added meanwhile isn't lost.
    fresh = store.get_case(case_id)
    if not fresh or not fresh.assist or fresh.assist.status != 'pending':
        return
    new_notes = case.ticket.work_notes[notes_before:]
    for field in ('visual_analysis', 'service', 'priority', 'category', 'subcategory', 'assigned_to', 'assigned_user_id'):
        setattr(fresh.ticket, field, getattr(case.ticket, field))
    fresh.understanding.product, fresh.recommended_action = case.understanding.product, case.recommended_action
    fresh.routing, fresh.handler_label, fresh.assist = case.routing, case.handler_label, case.assist
    fresh.ticket.work_notes.extend(new_notes)
    store.save_case(fresh)


@app.post('/api/cases/{case_id}/assist', response_model=CaseRecord)
def assist_feedback(case_id: str, value: AssistFeedback, http: Request, background_tasks: BackgroundTasks):
    """The customer answers the AI's self-help: fixed (resolve) or not fixed (hand over to a technician)."""
    user = actor(http)
    case = store.get_case(case_id)
    if not case or user['role'] != 'customer' or case.customer_id != user['id']:
        raise HTTPException(404, 'Case not found')
    if not case.assist or case.assist.status != 'offered':
        raise HTTPException(409, 'This suggestion has already been answered.')
    now = datetime.now(timezone.utc)
    note = value.note.strip()
    if value.resolved:
        case.assist = case.assist.model_copy(update={'status': 'resolved', 'customer_response': note or 'The suggested steps fixed it.', 'decided_at': now})
        store.save_case(case)
        steps = '\n'.join(f'- {step}' for step in case.assist.steps)
        update_ticket(case_id, TicketUpdate(state='Resolved', resolution=f"Customer confirmed the AI-suggested self-help steps fixed the issue.\n{steps}" + (f"\nCustomer note: {note}" if note else '')), background_tasks)
    else:
        case.assist = case.assist.model_copy(update={'customer_response': note or 'The suggested steps did not fix it.'})
        if note:
            case.ticket.work_notes.append(WorkNote(id=f'NOTE-{uuid4().hex[:8].upper()}', author=user['name'], author_type='Customer', text=note))
        escalate(case, "The customer said the AI-suggested steps didn't fix the issue.", app.state.calling.snapshot()['technicians'], store.list_cases())
        store.save_case(case)
    return visible_case(store.get_case(case_id), user)


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

    valid_uploads = [u for u in uploads if getattr(u, 'filename', None)]
    if not valid_uploads:
        raise HTTPException(400, 'No valid files provided.')
    if len(case.ticket.attachments) + len(valid_uploads) > 3:
        raise HTTPException(400, "You can submit up to 3 images in total.")
    for upload in valid_uploads:
        if not is_image(upload.filename):
            raise HTTPException(415, "File type is not supported. Only image uploads (up to 3 images) are currently supported.")

    new_attachments: list[tuple[Attachment, bytes]] = []
    staged = []
    total_size = 0
    for upload in valid_uploads:
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
    _, analysis = analyse_images(case, new_attachments)
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
    # Work notes and customer comments are allowed in every state, as in a normal service desk.
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
