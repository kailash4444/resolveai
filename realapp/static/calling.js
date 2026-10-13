const calling = { user: null, data: null, selected: null, room: null, roomCallId: null, ready: false, loading: false, notice: null, priority: 'All', micDenied: false, reconnecting: false, joining: null };

function elapsed(at) { return at ? `${Math.max(0, Math.floor((Date.now() / 1000 - at) / 60))} min` : '—'; }
const CALL_BADGES = {Completed: ['badge--ok', '✓ Completed'], Failed: ['badge--err', '✕ Failed'], Declined: ['badge--err', '✕ Declined'], Connected: ['badge--medium', '● Connected'], 'Callback requested': ['badge--high', '◆ Callback requested'], Ringing: ['badge--high', '◆ Ringing'], Queued: ['badge--low', '○ Waiting'], AI: ['badge--medium', '● With AI'], Triage: ['badge--medium', '● With AI']};
function callBadge(status) { const [tone, label] = CALL_BADGES[status] || ['badge--low', `○ ${status}`]; return `<span class="badge ${tone}">${esc(label)}</span>`; }
window.callBadge = callBadge;
function setBadge(el, tone, text) { el.className = `badge ${tone}`; el.textContent = text; }
// Polling re-renders every few seconds; only touch the DOM when content changed so focus and open details survive.
function patch(el, html) { if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } }

window.loadCalling = async () => {
  if (calling.loading) return;
  calling.loading = true;
  try {
    const auth = await api('/api/auth/status');
    calling.user = auth.user;
    if (!calling.user) { $('#signInButton').hidden = false; $('#routeRequestButton').disabled = true; return; }
    if (calling.user.role === 'customer') { calling.data = null; calling.selected = null; return; }
    calling.data = await api('/api/calling');
    calling.user = calling.data.user;
    if (calling.user.role === 'admin' && $('#view-technicians').classList.contains('active')) calling.data.users = await api('/api/users');
    $('#callsUnavailable').hidden = true;
    await restorePhone();
    renderCalling();
    if (new URLSearchParams(location.search).get('connect') === 'livekit' && !calling.livekitShown && calling.user.role === 'admin') {
      calling.livekitShown = true;
      await openLiveKitSetup();
    }
  } catch (error) {
    $('#callingSync').textContent = '✕ Connection interrupted';
    if (!calling.data) { $('#callsUnavailableMessage').textContent = error.message; $('#callsUnavailable').hidden = false; patch($('#callList'), '<p class="sec">Calls can’t be shown until the calling service responds.</p>'); }
  }
  finally { calling.loading = false; }
};

function renderIndicators() {
  const {voice} = calling.data, user = calling.user;
  const presence = user.availability || 'Offline';
  if (presence === 'Available' && user.calls_enabled) setBadge($('#presenceIndicator'), 'badge--ok', '✓ Available');
  else if (presence === 'Available') setBadge($('#presenceIndicator'), 'badge--low', '○ Available · browser calls off');
  else setBadge($('#presenceIndicator'), 'badge--low', `○ ${presence}`);
  const mic = !voice.configured ? ['badge--err', '✕ Browser calling not configured', 'Desk requests still work. An administrator can connect LiveKit.']
    : calling.micDenied ? ['badge--err', '✕ Blocked', 'Allow microphone access for this site in your browser, then select Enable microphone.']
    : !user.calls_enabled ? ['badge--low', '○ Off', 'Turn on Receive browser calls to use the microphone.']
    : calling.ready ? ['badge--ok', '✓ Ready', 'Your microphone is ready for browser calls.']
    : ['badge--low', '○ Not enabled', 'Select Enable microphone and allow access when the browser asks.'];
  setBadge($('#microphoneIndicator'), mic[0], mic[1]); $('#callMicState').textContent = mic[2];
  const offer = calling.data.calls.find(c => c.technician_id === user.id && c.status === 'Ringing');
  const waiting = (calling.data.incoming_calls || []).length;
  const call = calling.reconnecting ? ['badge--high', '◆ Reconnecting', 'Audio dropped. Trying to restore the call…']
    : calling.joining ? ['badge--medium', '● Joining call', 'Connecting your audio…']
    : calling.roomCallId ? ['badge--medium', '● Connected', 'You’re on a call. Your saved availability resumes afterward.']
    : offer ? ['badge--high', '◆ Ringing', `A call is offered to you. ${Math.max(0, Math.ceil(offer.reserved_until - Date.now() / 1000))} seconds to answer.`]
    : waiting ? ['badge--low', `○ ${waiting} waiting`, 'Customers are waiting for a technician.']
    : ['badge--low', '○ No active call', user.calls_enabled ? 'New calls appear here and in the banner.' : 'Browser calls are off; desk requests still reach you.'];
  setBadge($('#activeCallIndicator'), call[0], call[1]); $('#phoneConnection').textContent = call[2];
  $('#enablePhoneButton').hidden = !voice.configured || calling.ready || !user.calls_enabled;
  $('#voiceNotConfigured').hidden = voice.configured;
  if (!voice.configured) $('#voiceNotConfiguredText').textContent = user.role === 'admin' ? 'Connect LiveKit in Configuration to take browser calls. Desk requests still work.' : 'An administrator needs to connect LiveKit. Desk requests still work.';
  return offer;
}

function renderCalling() {
  const { metrics } = calling.data;
  const query = $('#callSearch').value.trim().toLowerCase();
  const calls = calling.data.calls.filter(call => (calling.priority === 'All' || call.priority === calling.priority) && (!query || [call.id,call.caller,call.technician_name,call.service,call.summary].join(' ').toLowerCase().includes(query)));
  $('#signInButton').hidden = true;
  $('#presenceControl').hidden = false;
  $('#routeRequestButton').disabled = false;
  $('#technicianIdentity').textContent = `${calling.user.name} · AI handles first contact; you join when a customer needs a person.`;
  if (document.activeElement !== $('#presenceSelect')) $('#presenceSelect').value = calling.user.availability;
  $('#presenceSelect').disabled = !!calling.user.current_call_id;
  $('#callPreferenceControl').hidden = false;
  $('#receiveCallsToggle').checked = calling.user.calls_enabled;
  $('#receiveCallsToggle').disabled = !!calling.user.current_call_id;
  const offer = renderIndicators();
  $('#callsQueued').textContent = metrics.queued;
  $('#callsAI').textContent = metrics.ai;
  $('#callsConnected').textContent = metrics.connected;
  $('#callsAvailable').textContent = metrics.available;
  $('#callPerformance').textContent = `All time: ${metrics.total ?? 0} requests · ${metrics.completed ?? 0} completed · ${metrics.callbacks ?? 0} callbacks to follow up · ${metrics.average_wait_seconds ?? 0} s average wait before a technician connected.`;
  $('#callingSync').textContent = `✓ Updated ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
  patch($('#callList'), calls.length ? `<ul class="list">${calls.map(c => { const selected = c.id === calling.selected; return `<li class="list__row${selected ? ' is-selected' : ''}"><span class="list__main"><strong>${esc(c.caller)}</strong><span class="help">${esc(c.service)} · ${c.origin === 'browser' ? 'Browser call' : 'Desk request'} · ${esc(c.technician_name || (['AI','Triage'].includes(c.status) ? 'AI assistant' : 'Unassigned'))} · ${elapsed(c.created_at)} ago</span></span>${priorityBadge(c.priority)}${callBadge(c.status)}<button type="button" class="pop pop--quiet pop--sm" data-call-select="${esc(c.id)}" aria-pressed="${selected}"><span>${selected ? 'Viewing' : 'Open'}<span class="sr"> call from ${esc(c.caller)}</span></span></button></li>`; }).join('')}</ul>`
    : calling.data.calls.length ? '<p class="sec">No calls match this search.</p>' : '<div class="empty"><h3 class="h4">The queue is empty</h3><p class="sec">Incoming browser calls and routed support requests appear here.</p></div>');
  const incoming = calling.data.incoming_calls || [];
  $('#sharedQueuePanel').hidden = !incoming.length;
  patch($('#sharedQueue'), incoming.map(call => `<li class="list__row"><span class="list__main"><strong>${esc(call.origin === 'browser' ? 'Incoming browser call' : 'Support request')}</strong><span class="help">${esc(call.service)} · waiting ${elapsed(call.created_at)}</span></span>${priorityBadge(call.priority)}<button type="button" class="pop pop--sm" data-pickup-call="${esc(call.id)}"><span>Answer<span class="sr"> ${esc(call.service)} call</span></span></button></li>`).join(''));
  if ($('#technicianRows')) renderUsersTable();
  $('#incomingCallBanner').hidden = !offer;
  if (offer) {
    patch($('#incomingCallBanner'), `<div class="stack stack--sm"><strong>◆ Incoming ${offer.origin === 'browser' ? 'call' : 'support request'} · ${esc(offer.caller)}</strong><span class="help">${esc(offer.service)} · answer within ${Math.max(0, Math.ceil(offer.reserved_until - Date.now()/1000))} seconds</span></div><button type="button" class="pop" data-call-select="${esc(offer.id)}">View request</button>`);
    if (calling.notice !== offer.dispatch_id) { calling.notice = offer.dispatch_id; calling.selected = offer.id; }
  }
  if (calling.selected) renderCallDetail();
}

function renderUsersTable() {
  const users = calling.data.users || calling.data.technicians.filter(t => t.role !== 'customer');
  $('#technicianRows').innerHTML = users.map(t => { const customer = t.role === 'customer'; return `<tr><th scope="row"><span class="stack stack--sm"><strong>${esc(t.name)}</strong><span class="mono help">${esc(t.username)}</span></span></th><td>${t.role === 'admin' ? '<span class="badge badge--medium">● Admin</span>' : customer ? '<span class="badge badge--low">○ Customer</span>' : '<span class="badge badge--ok">✓ Technician</span>'}</td><td class="col-opt">${customer ? '—' : esc(t.skills.join(', '))}</td><td class="col-opt">${esc(t.languages.join(', '))}</td><td>${customer ? '—' : callBadge(t.status)}</td><td class="col-opt">${customer ? '—' : t.voice_ready ? '✓ Ready' : '○ Not ready'}</td></tr>`; }).join('');
  $('#techniciansEmpty').hidden = users.length > 0;
}

async function selectCall(id) {
  calling.selected = id;
  showView('calls');
  renderCalling();
  $('#callWorkspace h2')?.focus();
}

function renderCallDetail() {
  if ($('#callReplyForm')?.contains(document.activeElement)) return;
  const c = calling.data?.calls.find(c => c.id === calling.selected);
  if (!c) { patch($('#callWorkspace'), '<h2 class="h3">No call selected</h2><p class="sec">Choose a call to see the transcript, routing and linked incident.</p>'); $('#callTicketPanel').hidden = true; return; }
  const own = c.technician_id === calling.user.id, canManage = own || calling.user.role === 'admin';
  const controls = [];
  if (c.status === 'Ringing' && own) {
    const phoneReady = c.origin !== 'browser' || calling.ready;
    controls.push(`<button type="button" class="pop" data-call-action="accept" ${phoneReady ? '' : 'disabled aria-describedby="acceptHelp"'}>Accept</button><button type="button" class="pop pop--quiet" data-call-action="decline">Decline</button>${phoneReady ? '' : '<p class="help" id="acceptHelp">Enable your microphone to accept browser calls.</p>'}`);
  }
  if (c.status === 'Connected' && own && calling.room) controls.push(`<button type="button" class="pop pop--quiet" id="muteCallButton" aria-pressed="${!calling.room.localParticipant.isMicrophoneEnabled}">${!calling.room.localParticipant.isMicrophoneEnabled ? 'Unmute' : 'Mute'}</button>`);
  if ((c.status === 'AI' || c.status === 'Connected') && canManage) controls.push('<button type="button" class="pop pop--quiet" data-call-action="transfer">Transfer to queue</button>');
  if ((c.status === 'Connected' || c.status === 'AI') && canManage) controls.push('<button type="button" class="pop pop--danger" data-call-action="finish">End call</button>');
  const guidance = c.knowledge_matches || [], status = c.knowledge_status;
  const openKnowledge = new Set([...document.querySelectorAll('#callWorkspace details[data-kb][open]')].map(item => item.dataset.kb));
  patch($('#callWorkspace'), `<div class="section-head section-head--tight"><div><p class="kicker"><span class="mono">${esc(c.id)}</span></p><h2 class="h3" tabindex="-1">${esc(c.caller)}</h2></div>${callBadge(c.status)}</div>
    ${c.summary ? `<p class="sec">${esc(c.summary)}</p>` : ''}
    <dl class="kv"><div><dt>Service</dt><dd>${esc(c.service)}</dd></div><div><dt>Priority</dt><dd>${priorityBadge(c.priority)}</dd></div><div><dt>Technician</dt><dd>${esc(c.technician_name || 'Not assigned')}</dd></div><div><dt>Started</dt><dd>${elapsed(c.created_at)} ago</dd></div></dl>
    ${c.reason ? `<p class="help" data-detail>Routing: ${esc(c.reason)}</p>` : ''}
    ${c.last_error ? `<div class="alert" role="alert"><strong>✕ Call problem.</strong><span class="sec">${esc(c.last_error)}</span></div>` : ''}
    ${controls.length ? `<div class="row">${controls.join('')}</div>` : ''}
    <h3 class="h4">Conversation</h3>${c.transcript.length ? transcriptTurns(c.transcript) : '<p class="help">The transcript appears as people speak.</p>'}
    ${c.origin === 'desk' && c.status === 'AI' ? '<form id="callReplyForm" class="stack stack--sm" novalidate><div class="field field--inline"><label for="callReplyText">Customer reply</label><textarea class="input" id="callReplyText" name="text" rows="2" required maxlength="4000"></textarea></div><div class="row"><button type="submit" class="pop pop--sm">Send reply</button><p class="form-status" id="callReplyMessage" role="status"></p></div></form>' : ''}
    <section class="stack stack--sm" aria-labelledby="callKnowledgeTitle"><h3 class="h4" id="callKnowledgeTitle">Suggested knowledge</h3><p class="help">${status === 'searching' ? '● Finding guidance for the latest customer problem…' : status === 'error' ? `✕ ${esc(c.knowledge_error)}` : 'AI suggestions, updated as the customer describes the issue. Verify before using.'}</p>
    ${guidance.map(k => `<details data-kb="${esc(k.id)}" ${openKnowledge.has(k.id) ? 'open' : ''}><summary><span class="mono">${esc(k.id)}</span>&nbsp;· ${esc(k.title)}</summary><p class="sec">${esc(k.excerpt)}</p><ol class="plain-steps">${k.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol></details>`).join('') || `<p class="sec">${status === 'ready' ? 'No relevant articles found.' : 'Suggestions appear after the customer speaks.'}</p>`}</section>
    <details data-detail><summary>Routing history</summary><ol class="plain-steps">${c.events.slice().reverse().map(e => `<li><time class="help">${new Date(e.at).toLocaleTimeString()}</time> ${esc(e.text)}</li>`).join('')}</ol></details>`);
  renderCallTicket(c);
}

async function renderCallTicket(call) {
  const panel = $('#callTicketPanel');
  panel.hidden = false;
  if (!call.case_id) {
    patch(panel, `<h2 class="h3">Incident</h2><p class="sec">${['Completed','Failed','Callback requested'].includes(call.status) ? (call.transcript.some(t=>t.speaker==='Customer') ? '● Creating the incident from the conversation…' : 'No incident: the customer didn’t describe an issue.') : 'An incident is created from the conversation when the call ends.'}</p>`);
    return;
  }
  try {
    const item = await api(`/api/cases/${call.case_id}`);
    if (calling.selected !== call.id) return;
    const t = item.ticket;
    patch(panel, `<div class="section-head section-head--tight"><div><p class="kicker">Linked incident</p><h2 class="h3"><span class="mono">${esc(t.id)}</span></h2></div>${stateBadge(t.state)}</div><p><strong>${esc(t.short_description)}</strong></p><dl class="kv"><div><dt>Priority</dt><dd>${priorityBadge(t.priority)}</dd></div><div><dt>Service</dt><dd>${esc(t.service)}</dd></div><div><dt>Assigned to</dt><dd>${esc(t.assigned_to || 'Unassigned')}</dd></div><div><dt>Category</dt><dd>${esc(t.category)} · ${esc(t.subcategory)}</dd></div></dl><p class="sec pre" data-detail>${esc(t.description)}</p><div><a class="pop pop--quiet pop--sm" href="${window.Shell.home(state.user.role)}?ticket=${encodeURIComponent(item.id)}" data-ticket-link="${esc(item.id)}"><span>Open<span class="sr"> ${esc(t.id)}</span> to edit</span></a></div>`);
  } catch(error) {
    if (calling.selected === call.id) patch(panel, `<h2 class="h3">Incident</h2><div class="alert" role="alert"><strong>✕ Couldn’t load the incident.</strong><span class="sec">${esc(error.message)}</span></div>`);
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
  const button = $('#enablePhoneButton'); button.disabled = true; button.setAttribute('aria-busy', 'true');
  try {
    await ResolveAIVoice.microphonePermission();
    calling.micDenied = false;
    await api('/api/calling/check');
    calling.ready = true; await heartbeat(); await loadCalling();
  } catch(error) {
    calling.ready = false;
    if (['NotAllowedError', 'SecurityError'].includes(error.name)) calling.micDenied = true;
    else showFeedback(`Browser calling check failed: ${error.message}`, true);
    if (calling.data) renderIndicators();
  }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}

async function acceptBrowserCall(id, connection) {
  let room;
  calling.joining = id; if (calling.data) renderIndicators();
  try {
    room = await ResolveAIVoice.connect(connection, () => {
      if (calling.room === room) {calling.room = null;calling.roomCallId = null;}
      loadCalling();
    }, false);
    calling.room = room; calling.roomCallId = id; calling.joining = null;
    room.on(LivekitClient.RoomEvent.Reconnecting, () => { calling.reconnecting = true; renderIndicators(); });
    room.on(LivekitClient.RoomEvent.Reconnected, () => { calling.reconnecting = false; renderIndicators(); });
    await api(`/api/calling/${id}/connected`, {method:'POST',body:'{}'});
    for(let i=0;i<40 && !room.localParticipant.permissions?.canPublish;i++) await new Promise(resolve=>setTimeout(resolve,50));
    await room.localParticipant.setMicrophoneEnabled(true);
    await ResolveAIVoice.microphonePanel(room);
  } catch(error) {
    await room?.disconnect(); calling.room=null;calling.roomCallId=null;calling.joining=null;calling.reconnecting=false;
    try {await api(`/api/calling/${id}/transfer`,{method:'POST',body:'{}'});} catch(_) {}
    throw error;
  }
}

document.addEventListener('click', async event => {
  try {
    if (event.target.classList.contains('modal-backdrop')) {
      event.target.hidden = true;
    }
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
      if (['transfer', 'finish'].includes(kind)) {
        const dialog = $('#callActionDialog'); dialog.dataset.callId = id; dialog.dataset.action = kind;
        $('#callActionTitle').textContent = kind === 'transfer' ? 'Transfer this call?' : 'Finish this call?';
        $('#callActionDescription').textContent = kind === 'transfer' ? 'The call will return to the support queue for another technician.' : 'The conversation will stop for everyone.';
        $('#confirmCallAction').textContent = kind === 'transfer' ? 'Transfer call' : 'Finish call';
        dialog.showModal(); return;
      }
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
    if (event.target.closest('#signInButton')) location.assign('/login?role=technician');
    if (event.target.closest('#enablePhoneButton')) await enablePhone();
    if (event.target.closest('#addTechnicianButton')) { $('#technicianModal').hidden = false; $('#technicianForm [name=role]').focus(); }
    if (event.target.closest('#routeRequestButton')) { $('#requestMessage').textContent = ''; $('#requestModal').showModal(); }
    if (event.target.closest('#retryCalls')) await loadCalling();
    if (event.target.closest('#confirmCallAction')) {
      const dialog = $('#callActionDialog'), id = dialog.dataset.callId, kind = dialog.dataset.action;
      dialog.close();
      const result = await api(`/api/calling/${id}/${kind}`, {method:'POST',body:'{}'});
      if (['finish','transfer'].includes(kind) && calling.roomCallId === id) { const room=calling.room; calling.room=null; calling.roomCallId=null; await room?.disconnect(); }
      await loadCalling();
    }
    if (event.target.closest('#accountSignOut, [data-sign-out]')) {
      const blockSignOut = () => { window.Shell?.closeDrawer(false); const notice = $('#signOutCallNotice'); notice.hidden = false; notice.focus(); };
      if (calling.user?.current_call_id || calling.roomCallId) { blockSignOut(); return; }
      try { await api('/api/auth/logout', {method:'POST',body:'{}'}); }
      catch (error) { if (error.status === 409) { blockSignOut(); return; } throw error; }
      await calling.room?.disconnect(); calling.ready = false; calling.user = null; location.assign('/');
    }
  } catch(error) { showFeedback(error.message, true); loadCalling(); }
});

$('#presenceSelect').addEventListener('change', async event => {
  try { await api('/api/technicians/me/presence', {method:'PATCH',body:JSON.stringify({status:event.target.value})}); await heartbeat(); await loadCalling(); }
  catch(error) { showFeedback(error.message, true); }
});

$('#receiveCallsToggle').addEventListener('change', async event => {
  const enabled = event.target.checked;
  event.target.disabled = true;
  try {
    calling.user = await api('/api/technicians/me/call-settings', {method:'PATCH',body:JSON.stringify({enabled})});
    calling.ready = false;
    if (enabled) await enablePhone();
    else { await heartbeat(); await loadCalling(); }
  } catch(error) { showFeedback(error.message, true); }
  finally { event.target.disabled = false; await loadCalling(); }
});

async function submitCallingForm(event, path, messageId, transform, after) {
  event.preventDefault();
  const form = event.target, button = form.querySelector('button[type=submit]');
  const message = $(messageId);
  if (!form.checkValidity()) { const bad = [...form.elements].find(el => el.willValidate && !el.validity.valid); bad.setAttribute('aria-invalid', 'true'); message.className = 'form-status err'; message.textContent = `✕ Check ${form.querySelector(`label[for="${bad.id}"]`)?.textContent || 'the highlighted field'}: ${bad.validationMessage}`; bad.focus(); return; }
  form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
  message.className = 'form-status'; message.textContent = 'Saving…'; button.disabled = true; button.setAttribute('aria-busy', 'true');
  try {
    const values = Object.fromEntries(new FormData(form));
    const result = await api(path, {method:'POST',body:JSON.stringify(transform ? transform(values) : values)});
    form.reset(); message.textContent = ''; await after(result); await loadCalling();
  } catch(error) { message.className = 'form-status err'; message.textContent = `✕ ${error.message}`; }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}

document.addEventListener('submit', event => {
  if (event.target.id === 'callReplyForm') submitCallingForm(event, `/api/calling/${calling.selected}/message`, '#callReplyMessage', null, async () => document.activeElement?.blur());
});
$('#technicianForm [name=role]').addEventListener('change', event => {
  const customer = event.target.value === 'customer';
  ['userSkillsField','userLanguagesField'].forEach(id => { const field = $('#'+id), input = field.querySelector('input'); field.hidden = customer; input.required = !customer; input.disabled = customer; if (customer) input.value = ''; else if (!input.value) input.value = id === 'userSkillsField' ? 'general' : 'en'; });
});
$('#technicianForm').addEventListener('submit', event => submitCallingForm(event, '/api/users', '#technicianMessage', values => ({...values, skills:(values.skills || 'general').split(',').map(x=>x.trim()).filter(Boolean), languages:(values.languages || 'en').split(',').map(x=>x.trim()).filter(Boolean)}), async () => { $('#technicianModal').hidden = true; state.users=await api('/api/users');toast('User account created.'); }));
$('#routeRequestForm').addEventListener('submit', event => submitCallingForm(event, '/api/calling/requests', '#requestMessage', null, async result => {
  calling.selected = result.id; $('#requestModal').close(); toast('Incident created and routed.');
}));

async function openLiveKitSetup() {
  const config = await api('/api/config/livekit');
  $('#livekitForm [name=url]').value=config.url;
  $('#livekitForm [name=api_key]').value=config.api_key;
  const secret=$('#livekitForm [name=api_secret]');secret.value='';secret.required=!config.credentials_saved;
  secret.placeholder=config.credentials_saved?'Saved securely · leave blank to keep':'Enter your API secret';
  $('#livekitMessage').textContent='';$('#livekitModal').hidden=false;$('#livekitForm [name=url]').focus();
}
window.openLiveKitSetup = openLiveKitSetup;
$('#configurationLiveKitButton')?.addEventListener('click', async () => {
  const message = $('#configurationLiveKitMessage'); message.textContent = '';
  try { await openLiveKitSetup(); } catch (error) { message.textContent = error.message; }
});
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
document.addEventListener('click', event => {
  const filter = event.target.closest('[data-call-filter]');
  if (!filter) return;
  calling.priority = filter.dataset.callFilter;
  document.querySelectorAll('[data-call-filter]').forEach(button => button.setAttribute('aria-pressed', String(button === filter)));
  if (calling.data) renderCalling();
});
loadCalling();
