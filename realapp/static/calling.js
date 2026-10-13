const calling = { user: null, data: null, selected: null, room: null, roomCallId: null, ready: false, auth: null, loading: false, notice: null };

function elapsed(at) { return at ? `${Math.max(0, Math.floor((Date.now() / 1000 - at) / 60))} min` : '—'; }
function callBadge(status) { return `<span class="call-status status-${esc(status.toLowerCase().replaceAll(' ', '-'))}">${esc(status)}</span>`; }

window.openTechnicianAuth = async () => {
  calling.auth = await api('/api/auth/status');
  const setup = calling.auth.setup_required;
  $('#authTitle').textContent = setup ? 'Create your administrator account' : 'Sign in';
  $('#authDescription').textContent = setup ? 'Create the single administrator account, then add technician and customer accounts.' : 'Sign in with the account your administrator created.';
  $('#setupNameLabel').hidden = !setup;
  $('#setupNameLabel input').required = setup;
  $('#setupTokenLabel').hidden = !setup || !calling.auth.setup_token_required;
  $('#authForm [name=password]').minLength = setup ? 12 : 1;
  $('#authSubmit').textContent = setup ? 'Create account' : 'Sign in';
  $('#authMessage').textContent = '';
  $('#authModal').hidden = false;
};

window.loadCalling = async () => {
  if (calling.loading) return;
  calling.loading = true;
  try {
    const auth = await api('/api/auth/status');
    calling.user = auth.user;
    window.applyAccountRole?.(auth.user);
    if (!calling.user) {
      $('#signInButton').hidden = false;
      $('#signInButton').textContent = auth.setup_required ? 'Set up your team' : 'Sign in';
      $('#presenceControl').hidden = $('#enablePhoneButton').hidden = true;
      $('#addTechnicianButton').hidden = true;
      $('#callPreferenceControl').hidden = true;
      $('#routeRequestButton').disabled = true;
      $('#callList').innerHTML = '<p class="helper">Sign in to view your team’s calls and queue.</p>';
      $('#technicianRows').innerHTML = '';
      $('#techniciansEmpty').hidden = false;
      return;
    }
    if (calling.user.role === 'customer') { calling.data = null; calling.selected = null; return; }
    calling.data = await api('/api/calling');
    calling.user = calling.data.user;
    if (calling.user.role === 'admin' && $('#view-technicians').classList.contains('active')) calling.data.users = await api('/api/users');
    await restorePhone();
    renderCalling();
    if (new URLSearchParams(location.search).get('connect') === 'livekit' && !calling.livekitShown && calling.user.role === 'admin') {
      calling.livekitShown = true;
      await openLiveKitSetup();
    }
  } catch (error) { $('#callingSync').textContent = 'Connection interrupted'; }
  finally { calling.loading = false; }
};

function renderCalling() {
  const { metrics, voice: telephony } = calling.data;
  const query = $('#callSearch').value.trim().toLowerCase();
  const calls = calling.data.calls.filter(call => !query || [call.id,call.caller,call.technician_name,call.service,call.summary].join(' ').toLowerCase().includes(query));
  const technicians = calling.data.technicians.filter(t=>t.role !== 'customer');
  $('#signInButton').hidden = true;
  $('#presenceControl').hidden = false;
  $('#routeRequestButton').disabled = false;
  $('#technicianIdentity').textContent = calling.user.name;
  $('#presenceSelect').value = calling.user.availability;
  $('#presenceSelect').disabled = !!calling.user.current_call_id;
  $('#callPreferenceControl').hidden = false;
  $('#receiveCallsToggle').checked = calling.user.calls_enabled;
  $('#receiveCallsToggle').disabled = !!calling.user.current_call_id;
  $('#phoneConnection').textContent = !calling.user.calls_enabled ? 'Calls disabled · your availability is saved.' : calling.user.current_call_id ? 'On a call · your saved availability resumes afterward.' : calling.ready ? (calling.user.availability === 'Available' ? 'Ready to receive calls · preferences saved' : `${calling.user.availability} · preferences saved`) : telephony.configured ? 'Calls enabled · allow microphone access to receive calls.' : 'Browser calling is not configured.';
  $('#enablePhoneButton').hidden = !telephony.configured || calling.ready || !calling.user.calls_enabled;
  $('#addTechnicianButton').hidden = calling.user.role !== 'admin';
  $('#callsQueued').textContent = metrics.queued;
  $('#callsAI').textContent = metrics.ai;
  $('#callsConnected').textContent = metrics.connected;
  $('#callsAvailable').textContent = metrics.available;
  if (!$('#callPerformance')) $('.call-metrics').insertAdjacentHTML('afterend', '<p id="callPerformance" class="helper"></p>');
  $('#callPerformance').textContent = `${metrics.total ?? 0} total requests · ${metrics.completed ?? 0} completed · ${metrics.callbacks ?? 0} callbacks to follow up · ${metrics.average_wait_seconds ?? 0}s average wait before connection`;
  $('#callingSync').textContent = 'Updated just now';
  $('#callList').className = calls.length ? 'call-list' : 'empty-list';
  $('#callList').innerHTML = calls.length ? calls.map(c => `<button class="call-row ${c.id === calling.selected ? 'selected' : ''}" data-call-select="${esc(c.id)}"><div><strong>${esc(c.caller)}</strong>${callBadge(c.status)}</div><p>${esc(c.service)} · ${esc(c.priority)} · ${c.origin === 'browser' ? 'Browser call' : 'Desk request'}</p><small>${esc(c.technician_name || (c.status === 'AI' ? 'AI assistant' : c.id))} · ${elapsed(c.created_at)} ago</small></button>`).join('') : 'No calls yet. Incoming calls and routed support requests appear here.';
  $('#sharedQueuePanel').hidden = !(calling.data.incoming_calls || []).length;
  $('#sharedQueue').innerHTML = (calling.data.incoming_calls || []).map(call=>`<div class="case-row"><div><strong>${esc(call.origin === 'browser' ? 'Incoming call' : 'Support request')}</strong><small>${esc(call.service)} · ${esc(call.priority)}</small></div><button class="primary small" data-pickup-call="${esc(call.id)}">Answer</button></div>`).join('');
  const users = calling.data.users || technicians;
  $('#technicianRows').innerHTML = users.map(t => `<tr><td><strong>${esc(t.name)}</strong><br><small>${esc(t.role)} · ${esc(t.username)}</small></td><td>${t.role === 'customer' ? '—' : esc(t.skills.join(', '))}</td><td>${esc(t.languages.join(', '))}</td><td>${t.role === 'customer' ? '—' : callBadge(t.status)}</td><td>${t.role === 'customer' ? '—' : t.voice_ready ? 'Connected' : 'Not connected'}</td><td>${esc(t.current_call_id || '—')}</td></tr>`).join('');
  $('#techniciansEmpty').hidden = users.length > 0;
  const offer = calling.data.calls.find(c => c.technician_id === calling.user.id && c.status === 'Ringing');
  $('#incomingCallBanner').hidden = !offer;
  if (offer) {
    $('#incomingCallBanner').innerHTML = `<div><strong>Incoming ${offer.origin === 'browser' ? 'call' : 'support request'} · ${esc(offer.caller)}</strong><small>${esc(offer.service)} · ${Math.max(0, Math.ceil(offer.reserved_until - Date.now()/1000))} seconds to answer</small></div><button class="primary small" data-call-select="${esc(offer.id)}">View request</button>`;
    if (calling.notice !== offer.dispatch_id) { calling.notice = offer.dispatch_id; calling.selected = offer.id; toast('A support request has been assigned to you.'); }
  }
  if (calling.selected) renderCallDetail();
}

async function selectCall(id) {
  calling.selected = id;
  showView('calls');
  renderCallDetail();
}

function renderCallDetail() {
  if ($('#callReplyForm')?.contains(document.activeElement)) return;
  const c = calling.data?.calls.find(c => c.id === calling.selected);
  if (!c) {$('#callWorkspace').innerHTML='<p class="helper">Choose one of your calls to view its details.</p>';return;}
  const openKnowledge = new Set([...document.querySelectorAll('#callKnowledge details[open]')].map(item=>item.dataset.kb));
  const own = c.technician_id === calling.user.id;
  const canManage = own || calling.user.role === 'admin';
  const controls = [];
  if (c.status === 'Ringing' && own) {
    const phoneReady = c.origin !== 'browser' || calling.ready;
    controls.push(`<button class="primary" data-call-action="accept" ${phoneReady ? '' : 'disabled'}>${phoneReady ? 'Accept' : 'Enable calls first'}</button><button class="secondary" data-call-action="decline">Decline</button>`);
  }
  if (c.status === 'Connected' && own && calling.room) controls.push(`<button class="secondary" id="muteCallButton">${!calling.room.localParticipant.isMicrophoneEnabled ? 'Unmute' : 'Mute'}</button>`);
  if (c.status === 'AI' || c.status === 'Connected' && canManage) controls.push('<button class="secondary" data-call-action="transfer">Transfer to queue</button>');
  if ((c.status === 'Connected' || c.status === 'AI') && canManage) controls.push('<button class="secondary danger" data-call-action="finish">End call</button>');
  $('#callWorkspace').innerHTML = `<div class="panel-head"><div><p class="eyebrow">${esc(c.id)}</p><h3>${esc(c.caller)}</h3></div>${callBadge(c.status)}</div><p>${esc(c.summary)}</p><div class="call-context"><span>${esc(c.service)} · ${esc(c.priority)}</span><span>${esc(c.technician_name || 'Not assigned')}</span></div><p class="helper">${esc(c.reason)}</p>${c.last_error ? `<p class="form-message error">${esc(c.last_error)}</p>` : ''}<div class="call-actions">${controls.join('')}</div><h4 class="call-section-label">Conversation</h4><div class="live-transcript">${c.transcript.map(t => `<div class="transcript-turn"><b>${esc(t.speaker)}${t.speaker_name ? ` · ${esc(t.speaker_name)}` : ''}</b><small>${t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : ''}</small><p>${esc(t.text)}</p></div>`).join('') || '<p class="helper">The transcript will appear as participants speak.</p>'}</div><div id="callKnowledge"></div><details class="routing-history"><summary>Routing history</summary>${c.events.slice().reverse().map(e => `<p><small>${new Date(e.at).toLocaleTimeString()}</small> ${esc(e.text)}</p>`).join('')}</details>`;
  if (c.origin === 'desk' && c.status === 'AI') $('#callWorkspace').insertAdjacentHTML('beforeend', '<form id="callReplyForm"><label>Customer reply<textarea name="text" rows="2" required maxlength="4000"></textarea></label><button class="primary small">Send reply</button><p class="form-message" id="callReplyMessage"></p></form>');
  const guidance = c.knowledge_matches || [];
  const status = c.knowledge_status;
  $('#callKnowledge').innerHTML = `<h4 class="call-section-label">Suggested knowledge · Top 5</h4><p class="helper">${status === 'searching' ? 'Finding guidance for the latest customer problem…' : status === 'error' ? esc(c.knowledge_error) : 'Updated as the customer describes the issue.'}</p>${guidance.map(k => `<details class="call-knowledge" data-kb="${esc(k.id)}" ${openKnowledge.has(k.id) ? 'open' : ''}><summary>${esc(k.id)} · ${esc(k.title)}</summary><p>${esc(k.excerpt)}</p><ol>${k.steps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol></details>`).join('') || '<p class="helper">' + (status === 'ready' ? 'No relevant knowledge articles found.' : 'Suggestions will appear after the customer speaks.') + '</p>'}`;
  renderCallTicket(c);
}

async function renderCallTicket(call) {
  const panel = $('#callTicketPanel');
  panel.hidden = false;
  if (!call.case_id) {
    panel.innerHTML = `<h3>Incident</h3><p class="helper">${['Completed','Failed','Callback requested'].includes(call.status) ? (call.transcript.some(t=>t.speaker==='Customer') ? 'Creating the incident from the conversation…' : 'No incident created because the customer did not describe an issue.') : 'An incident will be created from the conversation when the call ends.'}</p>`;
    return;
  }
  try {
    const item = await api(`/api/cases/${call.case_id}`);
    if (calling.selected !== call.id) return;
    const t = item.ticket;
    panel.innerHTML = `<div class="panel-head"><div><p class="eyebrow">INCIDENT</p><h3>${esc(t.id)}</h3></div><button class="secondary" data-call-ticket="${esc(item.id)}">Edit incident</button></div><h4>${esc(t.short_description)}</h4><div class="call-ticket-fields">${[['State',t.state],['Priority',t.priority],['Service',t.service],['Assigned to',t.assigned_to || 'Unassigned'],['Category',t.category],['Subcategory',t.subcategory]].map(([label,value])=>`<div><span class="helper">${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div><h4>Description</h4><p class="call-ticket-description">${esc(t.description)}</p>${t.resolution ? `<h4>Resolution notes</h4><p class="call-ticket-description">${esc(t.resolution)}</p>` : ''}`;
  } catch(error) {
    if (calling.selected === call.id) panel.innerHTML = `<h3>Incident</h3><p class="form-message error">${esc(error.message)}</p>`;
  }
}

async function restorePhone() {
  if (!calling.user.calls_enabled) { calling.ready = false; return; }
  if (calling.ready || !calling.data.voice.configured || Date.now() < (calling.retryPhoneAt || 0)) return;
  calling.retryPhoneAt = Date.now() + 30000;
  try {
    const permission = await navigator.permissions.query({name:'microphone'});
    if (permission.state !== 'granted') return;
    await ResolveAIVoice.microphonePermission();
    await api('/api/calling/check');
    calling.ready = true;
    await heartbeat();
  } catch (_) { calling.ready = false; }
}

async function heartbeat() {
  if (!calling.user || calling.user.role === 'customer') return;
  try { await api('/api/technicians/me/heartbeat', {method:'POST', body:JSON.stringify({voice_ready:calling.ready})}); }
  catch (_) { calling.ready = false; }
}

async function enablePhone() {
  const button = $('#enablePhoneButton'); button.disabled = true;
  try {
    await ResolveAIVoice.microphonePermission();
    await api('/api/calling/check');
    calling.ready = true; await heartbeat(); await loadCalling();
  } catch(error) { toast(error.message); }
  finally { button.disabled = false; }
}

async function acceptBrowserCall(id, connection) {
  let room;
  try {
    room = await ResolveAIVoice.connect(connection, () => {
      if (calling.room === room) {calling.room = null;calling.roomCallId = null;}
      loadCalling();
    }, false);
    calling.room = room; calling.roomCallId = id;
    await api(`/api/calling/${id}/connected`, {method:'POST',body:'{}'});
    for(let i=0;i<40 && !room.localParticipant.permissions?.canPublish;i++) await new Promise(resolve=>setTimeout(resolve,50));
    await room.localParticipant.setMicrophoneEnabled(true);
    await ResolveAIVoice.microphonePanel(room);
  } catch(error) {
    await room?.disconnect(); calling.room=null;calling.roomCallId=null;
    try {await api(`/api/calling/${id}/transfer`,{method:'POST',body:'{}'});} catch(_) {}
    throw error;
  }
}

document.addEventListener('click', async event => {
  try {
    const close = event.target.closest('[data-close-call-modal]');
    if (close) $(`#${close.dataset.closeCallModal}`).hidden = true;
    if (close?.dataset.closeCallModal === 'livekitModal') $('#livekitForm [name=api_secret]').value = '';
    const select = event.target.closest('[data-call-select]');
    if (select) await selectCall(select.dataset.callSelect);
    const ticket = event.target.closest('[data-call-ticket]');
    if (ticket) await openTicketDetails(ticket.dataset.callTicket);
    const pickup = event.target.closest('[data-pickup-call]');
    if (pickup) {
      pickup.disabled=true; const id=pickup.dataset.pickupCall;
      const result=await api(`/api/calling/${id}/accept`,{method:'POST',body:'{}'});
      calling.selected=id;
      if(result.token)await acceptBrowserCall(id,result);
      showView('calls');await loadCalling();
    }
    const action = event.target.closest('[data-call-action]');
    if (action) {
      const id = calling.selected, kind = action.dataset.callAction;
      action.disabled = true;
      const result = await api(`/api/calling/${id}/${kind}`, {method:'POST',body:'{}'});
      if (kind === 'accept' && result.token) await acceptBrowserCall(id, result);
      if (['decline','finish','transfer'].includes(kind) && calling.roomCallId === id) {
        const room=calling.room; calling.room=null;calling.roomCallId=null;await room?.disconnect();
      }
      await loadCalling();
    }
    if (event.target.closest('#muteCallButton') && calling.room) {await calling.room.localParticipant.setMicrophoneEnabled(!calling.room.localParticipant.isMicrophoneEnabled);renderCallDetail();}
    if (event.target.closest('#resumeAudioButton')) {await calling.room?.startAudio();$('#resumeAudioButton').hidden=true;}
    if (event.target.closest('#signInButton')) await openTechnicianAuth();
    if (event.target.closest('#enablePhoneButton')) await enablePhone();
    if (event.target.closest('#addTechnicianButton')) $('#technicianModal').hidden = false;
    if (event.target.closest('#routeRequestButton')) $('#requestModal').hidden = false;
    if (event.target.closest('#accountSignOut')) {
      await api('/api/auth/logout', {method:'POST',body:'{}'}); await calling.room?.disconnect(); calling.ready = false; calling.user = null; location.reload();
    }
  } catch(error) { toast(error.message); loadCalling(); }
});

$('#presenceSelect').addEventListener('change', async event => {
  try { await api('/api/technicians/me/presence', {method:'PATCH',body:JSON.stringify({status:event.target.value})}); await heartbeat(); await loadCalling(); }
  catch(error) { toast(error.message); }
});

$('#receiveCallsToggle').addEventListener('change', async event => {
  const enabled = event.target.checked;
  event.target.disabled = true;
  try {
    calling.user = await api('/api/technicians/me/call-settings', {method:'PATCH',body:JSON.stringify({enabled})});
    calling.ready = false;
    if (enabled) await enablePhone();
    else { await heartbeat(); await loadCalling(); }
  } catch(error) { toast(error.message); }
  finally { event.target.disabled = false; await loadCalling(); }
});

async function submitCallingForm(event, path, messageId, transform, after) {
  event.preventDefault();
  const form = event.target, button = form.querySelector('button[type=submit], button.primary');
  const message = $(messageId); message.className = 'form-message'; message.textContent = 'Saving…'; button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const result = await api(path, {method:'POST',body:JSON.stringify(transform ? transform(values) : values)});
    form.reset(); message.textContent = ''; await after(result); await loadCalling();
  } catch(error) { message.className = 'form-message error'; message.textContent = error.message; }
  finally { button.disabled = false; }
}

$('#authForm').addEventListener('submit', event => submitCallingForm(event, calling.auth?.setup_required ? '/api/auth/setup' : '/api/auth/login', '#authMessage', null, async result => {
  calling.user = result; calling.ready = false; calling.retryPhoneAt = 0; window.applyAccountRole?.(result); $('#authModal').hidden = true; await window.loadApplication();
}));
document.addEventListener('submit', event => {
  if (event.target.id === 'callReplyForm') submitCallingForm(event, `/api/calling/${calling.selected}/message`, '#callReplyMessage', null, async () => document.activeElement?.blur());
});
$('#technicianForm').addEventListener('submit', event => submitCallingForm(event, '/api/users', '#technicianMessage', values => ({...values, skills:values.skills.split(',').map(x=>x.trim()).filter(Boolean), languages:values.languages.split(',').map(x=>x.trim()).filter(Boolean)}), async () => { $('#technicianModal').hidden = true; state.users=await api('/api/users');toast('User account created.'); }));
$('#routeRequestForm').addEventListener('submit', event => submitCallingForm(event, '/api/calling/requests', '#requestMessage', null, async result => {
  calling.selected = result.id; $('#requestModal').hidden = true; toast('Incident created and routed.');
}));

async function openLiveKitSetup() {
  const config = await api('/api/config/livekit');
  $('#livekitForm [name=url]').value=config.url;
  $('#livekitForm [name=api_key]').value=config.api_key;
  const secret=$('#livekitForm [name=api_secret]');secret.value='';secret.required=!config.credentials_saved;
  secret.placeholder=config.credentials_saved?'Saved securely · leave blank to keep':'Enter your API secret';
  $('#livekitMessage').textContent='';$('#livekitModal').hidden=false;
}
$('#livekitForm').addEventListener('submit', async event=>{
  event.preventDefault();const form=event.target,button=form.querySelector('button[type=submit]'),message=$('#livekitMessage');
  button.disabled=true;message.textContent='Checking the LiveKit connection…';message.className='form-message';
  try {
    await api('/api/config/livekit',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    calling.ready=false;await heartbeat();await loadCalling();
    message.textContent='LiveKit connection verified and saved. Enable calls to start receiving customers.';
    form.querySelector('[name=api_secret]').required=false;
    form.querySelector('[name=api_secret]').placeholder='Saved securely · leave blank to keep';
  }catch(error){message.className='form-message error';message.textContent=error.message;}
  finally{form.querySelector('[name=api_secret]').value='';button.disabled=false;}
});

setInterval(() => { if (calling.user && calling.user.role !== 'customer') loadCalling(); }, 4000);
setInterval(heartbeat, 10000);
$('#callSearch').addEventListener('input', () => { if (calling.data) renderCalling(); });
loadCalling();
