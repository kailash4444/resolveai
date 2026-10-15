from concurrent.futures import ThreadPoolExecutor
import asyncio
import time
import hmac
from contextlib import asynccontextmanager
from pydantic import BaseModel, Field

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from fastapi.responses import PlainTextResponse
from realapp.call_analytics import CallQuality, filtered_analytics, overall_quality, visible_call, audit_current

from realapp.calling import CallingService, TechnicianCreate, Registration, Login, Presence, Heartbeat, CallSettings, SupportRequest, CustomerMessage, TERMINAL
from realapp.calling_store import create_calling_store
from realapp.models import TicketUpdate
from realapp.livekit_transport import LiveKitTransport
from realapp.livekit_setup import LiveKitSetup, LiveKitCredentials, check_connection


class ChatStart(BaseModel):
    description: str = Field(min_length=10, max_length=8000)
    language: str = Field(default='en', pattern=r'^[a-z]{2}(-[A-Z]{2})?$')


class BrowserCallRequest(BaseModel):
    caller: str = Field(min_length=2, max_length=100)
    language: str = Field(default='en', pattern=r'^[a-z]{2}(-[A-Z]{2})?$')


class TechnicianCallNote(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class FinishCallRequest(BaseModel):
    technician_comment: str = Field(default='', max_length=4000)


class TechnicianCallNoteDraft(BaseModel):
    text: str = Field(default='', max_length=4000)


def install_calling(app, settings, store, engine, update_ticket):
    service = CallingService(settings, create_calling_store(settings), store, engine)
    transport = LiveKitTransport(settings, service)
    setup_service = LiveKitSetup(settings, service)
    app.state.livekit_setup = setup_service
    app.state.calling = service
    quality = CallQuality(service)
    app.state.call_quality = quality
    service.on_finished = quality.submit
    service.background = ThreadPoolExecutor(max_workers=2, thread_name_prefix='incident')
    app.state.voice = transport
    app.state.calling_task = None
    app.state.qa_tasks = set()
    router = APIRouter()
    # Preserve legacy assignments where they identify exactly one existing account.
    existing = service.snapshot()
    for case in store.list_cases():
        if not case.ticket.assigned_user_id and case.ticket.assigned_to:
            matches = [u for u in existing['technicians'] if u['role'] in {'admin','technician'} and u['name'] == case.ticket.assigned_to]
            if len(matches) == 1:
                case.ticket.assigned_user_id = matches[0]['id']
                store.save_case(case)

    def local(request):
        return settings.environment == "local" and request.client.host in {"127.0.0.1", "::1", "testclient"} and request.url.hostname in {"127.0.0.1", "localhost", "::1", "testserver"}

    def user(request, admin=False, staff=False):
        # The API guard already looked the session up for this request; reuse it instead of reading it again.
        result = getattr(request.state, 'user', None) or service.authenticate(request.cookies.get("resolveai_session"))
        if not result:
            raise HTTPException(401, "Log in to ResolveAI.")
        if admin and result["role"] != "admin":
            raise HTTPException(403, "Administrator access is required.")
        if staff and result['role'] not in {'admin','technician'}:
            raise HTTPException(403, 'Technician access is required.')
        return result

    @app.middleware("http")
    async def protect_api(request, next_handler):
        path = request.url.path
        if path.startswith("/api/"):
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                origin = request.headers.get("origin")
                allowed = {str(request.base_url).rstrip("/"), settings.public_base_url.rstrip("/")}
                if origin and origin not in allowed:
                    return JSONResponse({"detail": "Cross-site requests are not allowed."}, status_code=403)
            public = path in {'/api/health','/api/auth/status','/api/auth/setup','/api/auth/login','/api/auth/register'}
            if not public:
                actor = service.authenticate(request.cookies.get('resolveai_session'))
                if not actor:
                    return JSONResponse({'detail':'Log in to ResolveAI.'},status_code=401)
                request.state.user = actor
                if (path.startswith('/api/config/') or path == '/api/users' or path == '/api/technicians') and actor['role'] != 'admin':
                    return JSONResponse({'detail':'Administrator access is required.'},status_code=403)
                if actor['role'] == 'customer':
                    allowed = (path in {'/api/config','/api/auth/logout','/api/cases','/api/customer/incidents','/api/customer/calls'}
                        or (path == '/api/transcripts' or path.startswith('/api/transcripts/')) and request.method == 'GET'
                        or path.startswith('/api/support/')
                        or path == '/api/knowledge' and request.method == 'GET'
                        or path.startswith('/api/attachments/') and request.method == 'GET'
                        or path.startswith('/api/cases/') and (request.method == 'GET' or (path.endswith('/work-notes') or path.endswith('/attachments') or path.endswith('/assist')) and request.method == 'POST'))
                    if not allowed:
                        return JSONResponse({'detail':'This feature is available to support staff only.'},status_code=403)
        response = await next_handler(request)
        if path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def cookie(response, token, request):
        response.set_cookie("resolveai_session", token, httponly=True, secure=not local(request), samesite="strict", max_age=43200)

    @router.get("/api/auth/status")
    def auth_status(request: Request):
        return {"setup_required": not service.has_users(), "user": service.authenticate(request.cookies.get("resolveai_session")),
                "setup_token_required": not local(request), "login_required": True, "signup_enabled": settings.allow_customer_signup}

    @router.post("/api/auth/setup", status_code=201)
    def setup(value: TechnicianCreate, request: Request, response: Response):
        if not local(request) and (not settings.admin_setup_token or not hmac.compare_digest(value.setup_token, settings.admin_setup_token)):
            raise HTTPException(403, "Enter the administrator setup token configured on the server.")
        service.create_technician(value, first=True)
        token, tech = service.login(Login(username=value.username, password=value.password, expected_role='technician'), request.client.host)
        cookie(response, token, request)
        return tech

    signups: dict[str, list[float]] = {}

    @router.post("/api/auth/register", status_code=201)
    def register(value: Registration, request: Request, response: Response):
        """Self-service customer sign-up, then signed in. Never creates staff accounts."""
        if not settings.allow_customer_signup:
            raise HTTPException(403, "Creating an account is turned off. Ask your ResolveAI administrator for an account.")
        if not service.has_users():
            raise HTTPException(409, "ResolveAI isn't set up yet. The administrator account must be created first.")
        if value.username.lower() in value.password.lower():
            raise HTTPException(422, "Choose a password that doesn't contain your username.")
        peer, now = request.client.host, time.time()
        recent = [at for at in signups.get(peer, []) if now - at < 3600]
        if len(recent) >= settings.signups_per_hour_per_address:
            raise HTTPException(429, "Too many new accounts from this network. Try again in an hour.")
        service.create_technician(TechnicianCreate(role='customer', name=value.name.strip(), username=value.username, password=value.password))
        signups[peer] = recent + [now]
        token, account = service.login(Login(username=value.username, password=value.password, expected_role='customer'), peer)
        cookie(response, token, request)
        return account

    @router.post("/api/auth/login")
    def login(value: Login, request: Request, response: Response):
        token, tech = service.login(value, request.client.host)
        cookie(response, token, request)
        return tech

    @router.post("/api/auth/logout")
    def logout(request: Request, response: Response):
        actor = user(request)
        if actor["current_call_id"]:
            raise HTTPException(409, "Finish or decline your call before logging out.")
        service.logout(request.cookies.get("resolveai_session", ""), actor["id"])
        response.delete_cookie("resolveai_session")
        return {"ok": True}

    @router.get("/api/calling")
    def workspace(request: Request):
        actor = user(request, staff=True)
        data = service.snapshot(actor)
        data['technicians'] = [t for t in data['technicians'] if t['role'] in {'admin', 'technician'}]
        data["calls"] = [{k: v for k, v in c.items() if k not in {"customer_token_hash", "draft_case"}} for c in data["calls"]]
        data.update(user=actor, voice=transport.config())
        return data

    @router.get('/api/customer/calls')
    def customer_calls(request: Request):
        actor = user(request)
        return [{key:call.get(key) for key in ('id','status','created_at','case_id','technician_name','origin','channel')}
                for call in service.snapshot()['calls'] if call.get('customer_id') == actor['id']]

    def transcript_sources(actor):
        cases = {case.id:case for case in service.case_store.list_cases()}
        result=[]
        calls=service.snapshot()['calls']
        linked={call.get('case_id') for call in calls}
        for call in calls:
            if not visible_call(call,actor) or not call.get('transcript'): continue
            case=cases.get(call.get('case_id'))
            result.append(dict(source_id=call['id'],call_id=call['id'],case_id=call.get('case_id'),
                ticket_number=case.ticket.id if case else '',customer=call['caller'],technician=call.get('technician_name') or 'AI assistant',
                service=call.get('service','General'),status=call['status'],created_at=call['created_at'],
                duration_seconds=max(0,round(call['ended_at']-call['created_at'])) if call.get('ended_at') is not None else None,
                overall_quality=overall_quality(call) if actor['role']!='customer' else None,
                transcript=call['transcript'],quality_audit=call.get('quality_audit') if actor['role']!='customer' and audit_current(call) else None))
        for case in cases.values():
            own = actor['role']=='admin' or (case.ticket.assigned_user_id==actor['id'] if actor['role']=='technician' else case.customer_id==actor['id'])
            if case.id in linked or not own or not case.transcript: continue
            result.append(dict(source_id=case.id,call_id=case.ticket.call_id,case_id=case.id,ticket_number=case.ticket.id,
                customer=case.caller,technician=case.ticket.assigned_to or 'Not assigned',service=case.ticket.service,
                status=case.ticket.state,created_at=case.created_at.timestamp(),duration_seconds=None,transcript=[t.model_dump(mode='json') for t in case.transcript],quality_audit=None))
        return sorted(result,key=lambda item:item['created_at'],reverse=True)

    @router.get('/api/transcripts')
    def transcript_list(request: Request):
        actor = user(request)
        result = []
        for source in transcript_sources(actor):
            item = {k:v for k,v in source.items() if k not in {'transcript','quality_audit'}}
            if actor['role'] != 'customer':
                item['quality_scores'] = {key:metric.get('score') for key, metric in
                    (source.get('quality_audit') or {}).get('metrics', {}).items()}
            result.append(item)
        return result

    def transcript_for(source_id,request):
        source=next((s for s in transcript_sources(user(request)) if s['source_id']==source_id),None)
        if not source: raise HTTPException(404,'Transcript not found.')
        return source

    @router.get('/api/transcripts/{source_id}')
    def transcript_detail(source_id: str, request: Request):
        return transcript_for(source_id,request)

    @router.get('/api/transcripts/{source_id}/download')
    def transcript_download(source_id: str, request: Request):
        source=transcript_for(source_id,request)
        text=f"Call ID: {source['call_id'] or 'Not a call'}\nIncident: {source['ticket_number']}\nTechnician: {source['technician']}\nCustomer: {source['customer']}\n\n"
        for turn in source['transcript']:
            name=turn.get('speaker_name') or ('ResolveAI' if turn['speaker']=='AI Agent' else source['customer'] if turn['speaker']=='Customer' else source['technician'])
            text+=f"{turn['speaker']} ({name}): {turn['text']}\n\n"
        return PlainTextResponse(text,headers={'Content-Disposition':'attachment; filename="transcript.txt"'})

    @router.get('/api/call-analytics')
    def call_analytics(request: Request, call_id: str = '', technician: str = '', service_name: str = ''):
        actor=user(request,staff=True)
        return filtered_analytics([call for call in service.snapshot()['calls'] if visible_call(call,actor)],call_id,technician,service_name)

    @router.get('/api/call-analytics/audit-job')
    def call_quality_status(request: Request):
        return quality.status(user(request,staff=True)['id'])

    @router.post('/api/call-analytics/evaluate',status_code=202)
    def evaluate_calls(request: Request):
        actor=user(request,staff=True)
        return quality.start(actor['id'],[call for call in service.snapshot()['calls'] if visible_call(call,actor)])

    @router.get('/api/users')
    def list_users(request: Request):
        user(request, admin=True)
        return service.snapshot()['technicians']

    @router.post('/api/users', status_code=201)
    def create_account(value: TechnicianCreate, request: Request):
        user(request, admin=True)
        return service.create_technician(value)

    @router.post("/api/technicians", status_code=201)
    def create_technician(value: TechnicianCreate, request: Request):
        user(request, admin=True)
        return service.create_technician(value)

    def setup_admin(request):
        user(request, admin=True)
        if not local(request) or not setup_service.available:
            raise HTTPException(403, "Open ResolveAI on this Windows computer at localhost to manage credentials. Use environment secrets for cloud deployment.")

    @router.get("/api/config/livekit")
    def livekit_status(request: Request):
        setup_admin(request)
        return setup_service.status()

    @router.post("/api/config/livekit")
    async def livekit_save(value: LiveKitCredentials, request: Request):
        setup_admin(request)
        async with transport.start_lock:
            return await setup_service.save(value)

    @router.post("/api/technicians/me/heartbeat")
    def heartbeat(value: Heartbeat, request: Request):
        return service.heartbeat(user(request, staff=True)["id"], value.voice_ready)

    @router.patch("/api/technicians/me/presence")
    def presence(value: Presence, request: Request):
        return service.presence(user(request, staff=True)["id"], value.status)

    @router.patch('/api/technicians/me/call-settings')
    def call_settings(value: CallSettings, request: Request):
        return service.call_settings(user(request, staff=True)['id'], value.enabled)

    @router.get("/api/calling/check")
    async def voice_check(request: Request):
        user(request)
        await check_connection(settings)
        return {"ok": True}

    @router.get("/api/support/status")
    def support_status():
        return {"configured": transport.configured and service.has_users(), "provider": "LiveKit"}

    @router.post("/api/support/calls", status_code=201)
    async def browser_call(value: BrowserCallRequest, request: Request):
        actor = user(request)
        return await transport.start(actor['name'], value.language, request.client.host, actor['id'])

    def customer_call(call_id, request):
        actor = user(request)
        call = transport.customer_call(call_id, request.headers.get('x-support-token',''))
        if call.get('customer_id') != actor['id']:
            raise HTTPException(404, 'Call not found.')
        return call

    @router.get("/api/support/calls/{call_id}")
    def customer_status(call_id: str, request: Request):
        return transport.customer_status(customer_call(call_id, request))

    @router.post("/api/support/calls/{call_id}/end")
    async def customer_end(call_id: str, request: Request):
        customer_call(call_id, request)
        return transport.customer_status(await transport.end(call_id))

    @router.post("/api/support/calls/{call_id}/technician")
    async def customer_technician(call_id: str, request: Request):
        call = customer_call(call_id, request)
        if call['status'] in {'Triage', 'AI'}:
            session = transport.sessions.get(call_id)
            if session:
                session.interrupt()
                # Queue this request behind any active transcription/analysis.
                await session.queue.put(('Customer', None))
        return transport.customer_status(call)

    # ---- Customer text chat. Reuses desk-request triage, AI replies and technician dispatch;
    # every route is scoped to the signed-in customer who started the chat.
    def chat_view(call):
        case = service.case_store.get_case(call['case_id']) if call.get('case_id') else None
        return {key: call.get(key) for key in ('id', 'status', 'technician_name', 'case_id', 'created_at', 'ended_at', 'last_error')} | {
            'ticket_number': case.ticket.id if case else '',
            'transcript': [{key: turn.get(key) for key in ('speaker', 'text', 'timestamp')} for turn in call.get('transcript', [])[-100:]]}

    def own_chat(request, chat_id):
        actor = user(request)
        call = service.repository.read(lambda db: db['calls'].get(chat_id), call_ids=(chat_id,))
        if not call or call.get('channel') != 'chat' or call.get('customer_id') != actor['id']:
            raise HTTPException(404, 'Chat not found.')
        return call

    def ai_turn(call_id, background_tasks, resolve_on_confirm):
        try:
            reply = service.reply(call_id)
            service.add_turn(call_id, "AI Agent", reply.reply)
            if reply.escalate:
                service.enqueue(call_id, "AI requested technician assistance")
            elif resolve_on_confirm and reply.customer_confirmed_resolved:
                call = service.get(call_id)
                update_ticket(call["case_id"], TicketUpdate(state="Resolved", resolution="Customer confirmed the issue was fixed. " + reply.reply), background_tasks)
                service.finish(call_id)
        except Exception:
            service.enqueue(call_id, "AI assistance is unavailable")

    @router.post('/api/support/chats', status_code=201)
    def start_chat(value: ChatStart, request: Request, background_tasks: BackgroundTasks):
        actor = user(request)
        call = service.create_call(actor['name'], language=value.language, customer_id=actor['id'])
        service.repository.mutate(lambda db: db['calls'][call['id']].update(channel='chat'), call_ids=(call['id'],))
        service.add_turn(call['id'], 'Customer', value.description)
        call = service.triage(call['id'])
        background_tasks.add_task(service.refresh_knowledge, call['id'])
        if call['status'] == 'AI':
            ai_turn(call['id'], background_tasks, resolve_on_confirm=False)
        return chat_view(service.get(call['id']))

    @router.get('/api/support/chats/{chat_id}')
    def read_chat(chat_id: str, request: Request):
        return chat_view(own_chat(request, chat_id))

    @router.post('/api/support/chats/{chat_id}/messages')
    def chat_message(chat_id: str, value: CustomerMessage, request: Request, background_tasks: BackgroundTasks):
        call = own_chat(request, chat_id)
        if call['status'] in TERMINAL:
            raise HTTPException(409, 'This chat has ended. Start a new one if you still need help.')
        service.add_turn(chat_id, 'Customer', value.text)
        background_tasks.add_task(service.refresh_knowledge, chat_id)
        if call['status'] == 'AI':
            ai_turn(chat_id, background_tasks, resolve_on_confirm=True)
        return chat_view(service.get(chat_id))

    @router.post('/api/support/chats/{chat_id}/technician')
    def chat_technician(chat_id: str, request: Request):
        call = own_chat(request, chat_id)
        if call['status'] in {'Triage', 'AI'}:
            service.enqueue(chat_id, 'Customer asked for a technician')
        return chat_view(service.get(chat_id))

    @router.post('/api/support/chats/{chat_id}/end')
    def end_chat(chat_id: str, request: Request):
        own_chat(request, chat_id)
        return chat_view(service.finish(chat_id))

    @router.post("/api/calling/requests", status_code=201)
    def support_request(value: SupportRequest, request: Request, background_tasks: BackgroundTasks):
        user(request)
        call = service.create_call(value.caller, language=value.language)
        service.add_turn(call["id"], "Customer", value.description)
        call = service.triage(call["id"])
        background_tasks.add_task(service.refresh_knowledge, call['id'])
        if call["status"] == "AI":
            try:
                reply = service.reply(call["id"])
                service.add_turn(call["id"], "AI Agent", reply.reply)
                if reply.escalate:
                    service.enqueue(call["id"], "AI requested technician assistance")
            except Exception:
                service.enqueue(call["id"], "AI assistance is unavailable")
        return service.get(call["id"])

    @router.post("/api/calling/{call_id}/message")
    def message(call_id: str, value: CustomerMessage, request: Request, background_tasks: BackgroundTasks):
        actor, call = own_call(request, call_id)
        if call["origin"] != "desk" or call["status"] != "AI":
            raise HTTPException(409, "Customer replies are available for desk requests being handled by AI.")
        service.add_turn(call_id, "Customer", value.text)
        background_tasks.add_task(service.refresh_knowledge, call_id)
        try:
            reply = service.reply(call_id)
            service.add_turn(call_id, "AI Agent", reply.reply)
            if reply.escalate:
                service.enqueue(call_id, "AI requested technician assistance")
            elif reply.customer_confirmed_resolved:
                update_ticket(call["case_id"], TicketUpdate(state="Resolved", resolution="Customer confirmed the issue was fixed. " + reply.reply), background_tasks)
                service.finish(call_id)
        except Exception:
            service.enqueue(call_id, "AI assistance is unavailable")
        return service.get(call_id)

    @router.post('/api/calling/{call_id}/reply')
    def technician_reply(call_id: str, value: CustomerMessage, request: Request):
        actor, call = own_call(request, call_id)
        if call.get('channel') != 'chat' or call['status'] != 'Connected':
            raise HTTPException(409, 'You can reply after you accept this chat.')
        service.add_turn(call_id, 'Technician', value.text)
        return service.get(call_id)

    def own_call(request, call_id):
        actor = user(request)
        call = service.get(call_id)
        if actor["role"] != "admin" and call["technician_id"] != actor["id"]:
            raise HTTPException(403, "This call is assigned to another technician.")
        return actor, call

    @router.post("/api/calling/{call_id}/accept")
    def accept(call_id: str, request: Request):
        actor = user(request, staff=True)
        call = service.claim_pickup(call_id, actor["id"])
        return transport.offer(call_id, actor, call) if call["origin"] == "browser" else service.accept(call_id, actor["id"])

    @router.post("/api/calling/{call_id}/notes")
    def add_call_note(call_id: str, value: TechnicianCallNote, request: Request):
        actor, call = own_call(request, call_id)
        if call["status"] != "Connected":
            raise HTTPException(409, "Technician notes can be added while the call is connected.")
        return service.add_technician_note(call_id, actor["name"], value.text.strip())

    @router.put("/api/calling/{call_id}/note-draft")
    def save_call_note_draft(call_id: str, value: TechnicianCallNoteDraft, request: Request):
        actor, call = own_call(request, call_id)
        if call["status"] != "Connected":
            raise HTTPException(409, "Technician notes can be drafted while the call is connected.")
        return service.save_technician_note_draft(call_id, actor['name'], value.text)

    @router.post("/api/calling/{call_id}/connected")
    async def connected(call_id: str, request: Request):
        actor = await asyncio.to_thread(user, request, staff=True)
        return await transport.confirm_join(call_id, actor)

    @router.post("/api/calling/{call_id}/decline")
    async def decline(call_id: str, request: Request):
        actor, call = own_call(request, call_id)
        if call["origin"] == "browser":
            await transport.remove_technician(call)
        return service.decline(call_id, actor["id"])

    @router.post("/api/calling/{call_id}/finish")
    async def finish(call_id: str, request: Request, value: FinishCallRequest | None = None):
        actor, call = own_call(request, call_id)
        comment = (value.technician_comment if value else '').strip()
        if comment and call['status'] == 'Connected':
            service.add_technician_note(call_id, actor['name'], comment)
        return await transport.end(call_id) if call["origin"] == "browser" else service.finish(call_id)

    @router.post("/api/calling/{call_id}/transfer")
    async def transfer(call_id: str, request: Request):
        actor, call = own_call(request, call_id)
        if call["status"] == "Ringing":
            if call["origin"] == "browser":
                await transport.remove_technician(call)
            return service.decline(call_id, None if actor['role'] == 'admin' else actor['id'])
        if call["status"] == "Connected":
            if call["origin"] == "browser":
                await transport.remove_technician(call)
            def requeue(db):
                current = db["calls"][call_id]
                if current["status"] == "Connected":
                    service._release(db, current, f"Transferred by {actor['name']}", away=True)
                return current
            return service.repository.mutate(requeue)
        updated = service.enqueue(call_id, f"Technician requested by {actor['name']}")
        if call["origin"] == "browser":
            session = transport.sessions.get(call_id)
            if session:
                session.interrupt()
            updated = service.mark_waiting(call_id)
        return updated

    async def resolve(call, reply):
        if not call["case_id"]:
            return
        notes = "Customer confirmed that the issue was resolved during the AI-assisted call.\n" + reply
        tasks = BackgroundTasks()
        await asyncio.to_thread(update_ticket, call["case_id"], TicketUpdate(state="Resolved", resolution=notes), tasks)
        task = asyncio.create_task(tasks())
        app.state.qa_tasks.add(task)
        task.add_done_callback(app.state.qa_tasks.discard)

    transport.resolve = resolve

    async def loop():
        while True:
            try:
                await transport.maintenance()
            except asyncio.CancelledError:
                raise
            except Exception:
                import logging
                logging.getLogger(__name__).warning("Call dispatcher temporarily unavailable; retrying")
            await asyncio.sleep(2)

    @asynccontextmanager
    async def lifespan(_):
        # One voice worker per deployment; recover calls left by a process crash.
        for call in service.snapshot()["calls"]:
            if call["origin"] != "desk" and call["status"] not in TERMINAL:
                service.error(call["id"], "Voice service restarted. Please start a new call.")
                service.finish(call["id"], "Failed")
        # Finish writing incidents that a restart interrupted (incident ids are deterministic, so this can't duplicate).
        for call in service.snapshot()["calls"]:
            if service.needs_incident(call):
                service.background.submit(service.finalize_ticket_safely, call["id"])
        app.state.calling_task = asyncio.create_task(loop())
        try:
            yield
        finally:
            app.state.calling_task.cancel()
            await asyncio.gather(app.state.calling_task, return_exceptions=True)
            await transport.close()
            if app.state.qa_tasks:
                await asyncio.gather(*app.state.qa_tasks, return_exceptions=True)

    app.router.lifespan_context = lifespan
    app.include_router(router)
    return service
