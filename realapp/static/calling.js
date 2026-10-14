const calling = { user: null, data: null, noteDrafts: {}, noteDraftTimers: {}, noteDraftSaves: {}, selected: null, room: null, roomCallId: null, ready: false, loading: false, notice: null, priority: 'All', micDenied: false, reconnecting: false, joining: null, answering: null };

function elapsed(at) { return at ? `${Math.max(0, Math.floor((Date.now() / 1000 - at) / 60))} min` : '—'; }
const CALL_BADGES = {Completed: ['badge--ok', '✓ Completed'], Failed: ['badge--err', '✕ Failed'], Declined: ['badge--err', '✕ Declined'], Connected: ['badge--medium', '● Connected'], 'Callback requested': ['badge--high', '◆ Callback requested'], Ringing: ['badge--high', '◆ Ringing'], Queued: ['badge--muted', '○ Waiting'], AI: ['badge--medium', '● With AI'], Triage: ['badge--medium', '● With AI']};
function callBadge(status) { const [tone, label] = CALL_BADGES[status] || ['badge--muted', `○ ${status}`]; return `<span class="badge ${tone}">${esc(label)}</span>`; }
window.callBadge = callBadge;
function setBadge(el, tone, text) { el.className = `badge ${tone}`; el.textContent = text; }
// Polling re-renders every few seconds; only touch the DOM when content changed so focus and open details survive.
function patch(el, html) { if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } }
// Handoff summary shown with incoming requests: what the customer said, what was tried, what to do next.
function handoffCard(call) {
  const tried = call.attempted_steps || [];
  const next = call.recommended_action || call.next_question || 'Review the transcript and confirm the customer’s impact.';
  return `<div class="handoff stack stack--sm"><p class="kicker">Technician handoff</p><p><strong>Issue:</strong> ${esc(call.summary || 'Customer issue is still being understood.')}</p>${tried.length ? `<p><strong>Already tried:</strong></p><ul class="plain-steps">${tried.map(step => `<li>${esc(step)}</li>`).join('')}</ul>` : '<p class="help">No troubleshooting steps reported yet.</p>'}<p><strong>Suggested next step:</strong> ${esc(next)}</p></div>`;
}

window.loadCalling = async () => {
  if (calling.loading || calling.answering) return;
  calling.loading = true;
  try {
    const auth = await api('/api/auth/status');
    calling.user = auth.user;
    if (!calling.user) { $('#signInButton').hidden = false; $('#routeRequestButton').disabled = true; return; }
    if (calling.user.role === 'customer') { calling.data = null; calling.selected = null; return; }
    calling.data = await api('/api/calling');
    if (!calling.knowledgeData) calling.knowledgeData = await api('/api/knowledge').catch(() => []);
    calling.user = calling.data.user;
    if (calling.user.role === 'admin' && $('#view-technicians').classList.contains('active')) calling.data.users = await api('/api/users');
    $('#callsUnavailable').hidden = true; $('#usersError').hidden = true;
    renderLiveKitConfig();
    await restorePhone();
    renderCalling();
    if (new URLSearchParams(location.search).get('connect') === 'livekit' && !calling.livekitShown && calling.user.role === 'admin') {
      calling.livekitShown = true;
      await openLiveKitSetup();
    }
  } catch (error) {
    $('#callingSync').textContent = '✕ Connection interrupted';
    $('#usersErrorMessage').textContent = error.message; $('#usersError').hidden = !$('#view-technicians').classList.contains('active');
    if (!calling.data) { $('#callsUnavailableMessage').textContent = error.message; $('#callsUnavailable').hidden = false; patch($('#callList'), '<p class="sec">Calls can’t be shown until the calling service responds.</p>'); }
  }
  finally { calling.loading = false; }
};

function renderLiveKitConfig() {
  const voice = calling.data?.voice; if (!voice) return;
  const checks = Object.entries(voice.checks || {});
  const badge = $('#configurationLiveKitStatus');
  if (voice.configured) { badge.className = 'badge badge--ok'; badge.textContent = '✓ Connected'; }
  else if (checks.some(([, ok]) => ok)) { badge.className = 'badge badge--err'; badge.textContent = '✕ Incomplete'; }
  else { badge.className = 'badge badge--high'; badge.textContent = '◆ Not configured'; }
  $('#liveKitChecks').innerHTML = checks.map(([name, ok]) => `<li>${ok ? '<span class="badge badge--ok">✓ OK</span>' : '<span class="badge badge--err">✕ Missing</span>'} ${esc(name)}</li>`).join('') + (voice.url ? `<li><span class="badge badge--muted">○ Address</span> <span class="mono">${esc(voice.url)}</span></li>` : '');
  $('#liveKitHelp').textContent = voice.setup_available === false ? 'Credentials can only be edited when ResolveAI runs on this computer (localhost). Cloud deployments set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in the environment.' : voice.configured ? 'Saving new details replaces the current ones. The secret is never shown.' : 'Add your LiveKit address and API credentials to turn on browser voice.';
  $('#configurationLiveKitButton').hidden = voice.setup_available === false;
}

function renderIndicators() {
  const {voice} = calling.data, user = calling.user;
  const presence = user.availability || 'Offline';
  if (presence === 'Available' && user.calls_enabled) setBadge($('#presenceIndicator'), 'badge--ok', '✓ Available');
  else if (presence === 'Available') setBadge($('#presenceIndicator'), 'badge--muted', '○ Available · browser calls off');
  else setBadge($('#presenceIndicator'), 'badge--muted', `○ ${presence}`);
  const inCall = !!(calling.room && calling.roomCallId), muted = inCall && !calling.room.localParticipant.isMicrophoneEnabled;
  const mic = !voice.configured ? ['badge--err', '✕ Browser calling not configured', 'Desk requests and chats still work. An administrator can connect LiveKit.']
    : calling.micDenied ? ['badge--err', '✕ Blocked', 'Allow microphone access for this site in your browser, then turn the microphone on again.']
    : inCall ? (muted ? ['badge--high', '◆ Muted', 'The customer can’t hear you. Turn the microphone on to talk.'] : ['badge--ok', '✓ On · in a call', 'Turn the microphone off to mute yourself.'])
    : !user.calls_enabled ? ['badge--muted', '○ Off', 'Turn the microphone on to take browser calls.']
    : calling.ready ? ['badge--ok', '✓ On', 'You can take browser calls. Turn the microphone off to stop.']
    : ['badge--muted', '○ Waiting for permission', 'Turn the microphone on and allow access when the browser asks.'];
  setBadge($('#microphoneIndicator'), mic[0], mic[1]); $('#callMicState').textContent = mic[2];
  // One switch: on/off for taking browser calls, or mute/unmute while you are on a call.
  const micSwitch = $('#micSwitch'), on = inCall ? !muted : !!(user.calls_enabled && calling.ready);
  micSwitch.hidden = false;
  micSwitch.setAttribute('aria-checked', String(on));
  micSwitch.title = on ? 'Turn the microphone off' : 'Turn the microphone on';
  micSwitch.disabled = !voice.configured || !!calling.micBusy || (!!user.current_call_id && !inCall);
  const offer = calling.data.calls.find(c => c.technician_id === user.id && c.status === 'Ringing');
  const waiting = (calling.data.incoming_calls || []).length;
  const call = calling.reconnecting ? ['badge--high', '◆ Reconnecting', 'Audio dropped. Trying to restore the call…']
    : calling.joining ? ['badge--medium', '● Joining call', 'Connecting your audio…']
    : calling.roomCallId ? ['badge--medium', '● Connected', 'You’re on a call. Your saved availability resumes afterward.']
    : offer ? ['badge--high', '◆ Ringing', `A call is offered to you. ${Math.max(0, Math.ceil(offer.reserved_until - Date.now() / 1000))} seconds to answer.`]
    : waiting ? ['badge--muted', `○ ${waiting} waiting`, 'Customers are waiting for a technician.']
    : ['badge--muted', '○ No active call', user.calls_enabled ? 'New calls appear here and in the banner.' : 'Browser calls are off; desk requests still reach you.'];
  setBadge($('#activeCallIndicator'), call[0], call[1]); $('#phoneConnection').textContent = call[2];
  $('#voiceNotConfigured').hidden = voice.configured;
  if (!voice.configured) $('#voiceNotConfiguredText').textContent = user.role === 'admin' ? 'Connect LiveKit in Configuration to take browser calls. Desk requests still work.' : 'An administrator needs to connect LiveKit. Desk requests still work.';
  return offer;
}

const callPager = {page: 1, key: null}, userPager = {page: 1, key: null};
bindPagination('#callPagination', callPager, () => calling.data && renderCalling());
bindPagination('#userPagination', userPager, () => calling.data && renderUsersTable());
function renderCalling() {
  if (calling.answering) return;   // don't redraw the Answer buttons while a call is connecting
  const { metrics } = calling.data;
  const query = $('#callSearch').value.trim().toLowerCase();
  const calls = calling.data.calls.filter(call => (calling.priority === 'All' || call.priority === calling.priority) && (!query || [call.id,call.caller,call.technician_name,call.service,call.summary].join(' ').toLowerCase().includes(query)));
  const newest = $('#callSort').value !== 'oldest';
  calls.sort((a, b) => newest ? b.created_at - a.created_at : a.created_at - b.created_at);
  $('#signInButton').hidden = true;
  $('#presenceControl').hidden = false;
  $('#routeRequestButton').disabled = false;
  $('#technicianIdentity').textContent = `${calling.user.name} · AI handles first contact; you join when a customer needs a person.`;
  if (document.activeElement !== $('#presenceSelect')) $('#presenceSelect').value = calling.user.availability;
  $('#presenceSelect').disabled = !!calling.user.current_call_id;
  const offer = renderIndicators();
  $('#callsQueued').textContent = metrics.queued;
  $('#callsAI').textContent = metrics.ai;
  $('#callsConnected').textContent = metrics.connected;
  $('#callsAvailable').textContent = metrics.available;
  $('#callPerformance').textContent = `All time: ${metrics.total ?? 0} requests · ${metrics.completed ?? 0} completed · ${metrics.callbacks ?? 0} callbacks to follow up · ${metrics.average_wait_seconds ?? 0} s average wait before a technician connected.`;
  $('#callingSync').textContent = `✓ Updated ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
  const callPage = paginateItems(calls, callPager, JSON.stringify([calling.user?.id, query, calling.priority, newest]), '#callPagination');
  patch($('#callList'), calls.length ? `<ul class="list">${callPage.map(c => { return `<li class="list__row"><span class="list__main"><strong>${esc(c.caller)}</strong><span class="help">${esc(c.service)} · ${(c.origin === 'browser' ? 'Browser call' : c.channel === 'chat' ? 'Chat' : 'Desk request')} · ${esc(c.technician_name || (['AI','Triage'].includes(c.status) ? 'AI assistant' : 'Unassigned'))} · ${elapsed(c.created_at)} ago</span></span>${priorityBadge(c.priority)}${callBadge(c.status)}<a class="link" href="?view=calls&amp;call=${encodeURIComponent(c.id)}" data-call-select="${esc(c.id)}"><span>Open<span class="sr"> call from ${esc(c.caller)}</span></span></a></li>`; }).join('')}</ul>`
    : calling.data.calls.length ? '<p class="sec">No calls match this search.</p>' : '<div class="empty"><h3 class="h4">The queue is empty</h3><p class="sec">Incoming browser calls and routed support requests appear here.</p></div>');
  const incoming = calling.data.incoming_calls || [];
  $('#sharedQueuePanel').hidden = !incoming.length;
  $('#answerHint').hidden = !incoming.some(call => call.origin === 'browser') || !!calling.user?.voice_ready;
  patch($('#sharedQueue'), incoming.map(call => `<li class="list__row"><span class="list__main"><strong>${esc(call.origin === 'browser' ? 'Incoming browser call' : call.channel === 'chat' ? 'Incoming chat' : 'Support request')}</strong><span class="help">${esc(call.service)} · waiting ${elapsed(call.created_at)}</span></span>${priorityBadge(call.priority)}<button type="button" class="btn btn-primary btn-sm" data-pickup-call="${esc(call.id)}"><span>Answer<span class="sr"> ${esc(call.service)} call</span></span></button>${handoffCard(call)}</li>`).join(''));
  if ($('#technicianRows')) renderUsersTable();
  $('#incomingCallBanner').hidden = !offer;
  if (offer) {
    patch($('#incomingCallBanner'), `<div class="stack stack--sm"><strong>◆ Incoming ${offer.origin === 'browser' ? 'call' : offer.channel === 'chat' ? 'chat' : 'support request'} · ${esc(offer.caller)}</strong><span class="help">${esc(offer.service)} · answer within ${Math.max(0, Math.ceil(offer.reserved_until - Date.now()/1000))} seconds</span></div><button type="button" class="btn btn-primary" data-call-select="${esc(offer.id)}">View request</button>`);
  }
  // List or call page, never both, so neither gets squeezed. The address (?call=ID) decides which one shows.
  const pageCall = new URLSearchParams(location.search).get('call');
  if (pageCall) calling.selected = pageCall;
  const open = !!pageCall && calling.data.calls.some(call => call.id === pageCall);
  $('#callActivity').hidden = open; $('#callPage').hidden = !open;
  if (open) renderCallDetail();
}

// Users lists staff only (technicians and administrators). Customers create their own accounts and aren't listed.
function renderUsersTable() {
  $('#addTechnicianButton').hidden = calling.user?.role !== 'admin';
  const users = (calling.data.users || calling.data.technicians).filter(t => t.role !== 'customer');
  $('#technicianRows').innerHTML = paginateItems(users, userPager, calling.user?.id, '#userPagination').map(t => { const customer = t.role === 'customer'; return `<tr><th scope="row"><span class="stack stack--sm"><strong>${esc(t.name)}</strong><span class="mono help">${esc(t.username)}</span></span></th><td>${t.role === 'admin' ? '<span class="badge badge--medium">● Admin</span>' : customer ? '<span class="badge badge--muted">○ Customer</span>' : '<span class="badge badge--ok">✓ Technician</span>'}</td><td class="col-opt">${customer ? '—' : esc(t.skills.join(', '))}</td><td class="col-opt">${esc(t.languages.join(', '))}</td><td>${customer ? '—' : callBadge(t.status)}</td><td class="col-opt">${customer ? '—' : t.voice_ready ? '✓ Ready' : '○ Not ready'}</td><td>${t.current_call_id ? `<span class="mono">${esc(t.current_call_id)}</span>` : '<span class="help">—</span>'}</td></tr>`; }).join('');
  $('#techniciansEmpty').hidden = users.length > 0;
}

// Opening a call shows it as its own page inside Calls & queue (linkable as ?view=calls&call=ID); "All calls" or the
// browser's Back button returns to the list.
async function selectCall(id, push = true) {
  calling.selected = id;
  if (push) history.pushState({view: 'calls', call: id}, '', `${location.pathname}?view=calls&call=${encodeURIComponent(id)}`);
  showView('calls');
  if (calling.data) renderCalling();
  window.scrollTo({top: 0});
  $('#callWorkspace h2')?.focus({preventScroll: true});
}
function closeCall(push = true) {
  const id = calling.selected;
  calling.selected = null;
  if (push) history.pushState({view: 'calls'}, '', `${location.pathname}?view=calls`);
  if (calling.data) renderCalling();
  document.querySelector(`[data-call-select="${CSS.escape(id || '')}"]`)?.focus();
}
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(location.search);
  if (params.get('view') !== 'calls') return;
  const id = params.get('call');
  if (id) selectCall(id, false); else if (calling.selected) closeCall(false);
});
document.addEventListener('click', event => {
  const back = event.target.closest('[data-call-back]');
  if (!back || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault(); closeCall();
});

// Screen readers hear each new transcript line once (the transcript box itself is re-rendered on every refresh).
const spokenTurns = {};
function announceNewTurns(call, sameCall) {
  const seen = spokenTurns[call.id] ?? call.transcript.length;
  spokenTurns[call.id] = call.transcript.length;
  if (!sameCall || call.transcript.length <= seen) return;
  const latest = call.transcript.slice(seen).map(turn => `${turn.speaker_name || turn.speaker}: ${turn.text}`).join(' ');
  $('#callAnnouncer').textContent = latest.slice(0, 500);
}

function renderCallDetail() {
  if ($('#callReplyForm')?.contains(document.activeElement) || $('#techReplyForm')?.contains(document.activeElement) || $('#callNoteText')?.contains(document.activeElement)) return;
  const c = calling.data?.calls.find(c => c.id === calling.selected);
  if (!c) return;
  const own = c.technician_id === calling.user.id, canManage = own || calling.user.role === 'admin';
  const controls = [];
  if (c.status === 'Ringing' && own) {
    const phoneReady = c.origin !== 'browser' || calling.ready;
    controls.push(`<button type="button" class="call-btn call-btn--go" data-call-action="accept" ${phoneReady ? '' : 'disabled aria-describedby="acceptHelp"'}><span class="call-btn__icon"><svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h3l2 5-2 2a15 15 0 0 0 5 5l2-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z"/></svg></span>Accept</button><button type="button" class="call-btn" data-call-action="decline"><span class="call-btn__icon"><svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></span>Decline</button>${phoneReady ? '' : '<p class="help" id="acceptHelp">Enable your microphone to accept browser calls.</p>'}`);
  }
  if ((c.status === 'AI' || c.status === 'Connected') && canManage) controls.push('<button type="button" class="call-btn" data-call-action="transfer"><span class="call-btn__icon"><svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h10M4 18h7M17 15l3 3-3 3"/></svg></span>Transfer to queue</button>');
  if ((c.status === 'Connected' || c.status === 'AI') && canManage) controls.push(`<button type="button" class="call-btn call-btn--danger" data-call-action="finish"><span class="call-btn__icon"><svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15c5-5 13-5 18 0l-2 3-4-1v-3a10 10 0 0 0-6 0v3l-4 1z"/></svg></span>${c.channel === 'chat' ? 'End chat' : 'End call'}</button>`);
  const guidance = c.knowledge_matches || [], status = c.knowledge_status;
  // Handoff brief written when the AI transfers a call; greetings the AI spoke aren't troubleshooting steps.
  const brief = c.handoff_brief, customerTurns = c.transcript.filter(turn => turn.speaker === 'Customer' && turn.text?.trim());
  const boilerplate = ['welcome to resolveai','this call is transcribed','please describe the issue','i am connecting you','i’m connecting you','i will connect you','a technician will help','please stay on the call'];
  const tried = (brief?.tried || []).filter(item => !boilerplate.some(phrase => item.toLowerCase().includes(phrase)));
  const briefPanel = brief ? `<section class="handoff stack stack--sm" aria-label="Technician handoff brief"><p class="kicker">Technician handoff brief</p>
    <p><strong>Issue:</strong> ${esc(customerTurns[0]?.text || (customerTurns.length ? brief.issue : 'No customer issue was captured before the call transferred.'))}</p>${brief.impact ? `<p><strong>Impact:</strong> ${esc(brief.impact)}</p>` : ''}
    ${tried.length ? `<p><strong>Already tried:</strong></p><ul class="plain-steps">${tried.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p><strong>Already tried:</strong> No AI troubleshooting steps recorded.</p>'}
    ${brief.outcome && customerTurns.length ? `<p><strong>Latest customer update:</strong> ${esc(brief.outcome)}</p>` : ''}<p><strong>Why transferred:</strong> ${esc(brief.handoff_reason)}</p><p><strong>Suggested next step:</strong> ${esc(brief.next_step)}</p></section>` : (c.status === 'Ringing' ? handoffCard(c) : '');
  const joinHint = c.status === 'Queued' ? '<p class="alert alert--info"><strong>◆ Waiting for a technician.</strong><span class="sec">Choose Answer in Waiting for a technician to join. Browser calls need calls switched on and microphone access.</span></p>'
    : c.status === 'Completed' && c.queued_at && !c.connected_at ? '<p class="alert alert--info"><strong>○ This call ended while waiting.</strong><span class="sec">Its audio room is closed and can’t be joined. Ask the customer to start another support call.</span></p>'
    : ['Completed', 'Failed'].includes(c.status) ? '<p class="help">○ This call has ended, so it can’t be joined.</p>' : '';
  // Repeated connection errors are shown once with a count, so the history stays readable.
  const errorCounts = new Map(), shownErrors = new Set();
  c.events.forEach(e => { if (/failed|unavailable|interrupted/i.test(e.text)) errorCounts.set(e.text, (errorCounts.get(e.text) || 0) + 1); });
  const history = c.events.slice().reverse().map(e => {
    const noisy = /failed|unavailable|interrupted/i.test(e.text);
    if (noisy && shownErrors.has(e.text)) return '';
    if (noisy) shownErrors.add(e.text);
    const count = noisy ? errorCounts.get(e.text) : 1;
    return `<li><time class="help">${new Date(e.at).toLocaleTimeString()}</time> ${esc(e.text)}${count > 1 ? ` <span class="help">(repeated ${count} times)</span>` : ''}</li>`;
  }).join('');
  const openKnowledge = new Set([...document.querySelectorAll('#callContext details[data-kb][open]')].map(item => item.dataset.kb));
  // Live transcript, newest line first: stay at the top unless the technician scrolled down to read earlier turns,
  // in which case keep the same lines in view as new ones arrive above.
  const workspace = $('#callWorkspace'), oldTurns = workspace.querySelector('.turns'), sameCall = workspace.dataset.callId === c.id;
  const atTop = !sameCall || !oldTurns || oldTurns.scrollTop < 40, fromBottom = oldTurns ? oldTurns.scrollHeight - oldTurns.scrollTop : 0;
  patch($('#callWorkspace'), `<div class="section-head section-head--tight"><div><p class="kicker"><span class="mono">${esc(c.id)}</span></p><h2 class="h3" tabindex="-1">${esc(c.caller)}</h2></div>${callBadge(c.status)}</div>
    ${c.summary ? `<p class="sec">${esc(c.summary)}</p>` : ''}
    ${c.status === 'Connected' && canManage ? `<section class="card stack stack--sm"><label for="callNoteText">Technician scratchpad</label><textarea class="input" id="callNoteText" data-call-id="${esc(c.id)}" rows="3" maxlength="4000" placeholder="Jot down a note; it will be attached to the incident when the call ends…">${esc(calling.noteDrafts[c.id] || '')}</textarea><p class="help">Your note will be added to the incident when you end the call.</p></section>` : ''}
    ${c.last_error ? `<div class="alert" role="alert"><strong>✕ Call problem.</strong><span class="sec">${esc(c.last_error)}</span></div>` : ''}
    ${joinHint}
    ${controls.length ? `<div class="call-controls">${controls.join('')}</div>` : ''}
    <div class="section-head section-head--tight"><h3 class="h4">Conversation</h3><span class="help">Newest first</span></div>${c.transcript.length ? transcriptTurns(c.transcript.slice().reverse()) : '<p class="help">The transcript appears as people speak.</p>'}
    ${c.channel === 'chat' && c.status === 'Connected' && own ? '<form id="techReplyForm" class="stack stack--sm" novalidate><div class="field field--inline"><label for="techReplyText">Reply to customer</label><textarea class="input" id="techReplyText" name="text" rows="2" required maxlength="4000"></textarea></div><div class="row"><button type="submit" class="btn btn-primary btn-sm">Send</button><p class="form-status" id="techReplyMessage" role="status"></p></div></form>' : ''}
    ${c.origin === 'desk' && c.channel !== 'chat' && c.status === 'AI' ? '<form id="callReplyForm" class="stack stack--sm" novalidate><div class="field field--inline"><label for="callReplyText">Customer reply</label><textarea class="input" id="callReplyText" name="text" rows="2" required maxlength="4000"></textarea></div><div class="row"><button type="submit" class="btn btn-primary btn-sm">Send reply</button><p class="form-status" id="callReplyMessage" role="status"></p></div></form>' : ''}`);
  // Facts sit beside the conversation: details, the handoff brief, suggested knowledge and routing history.
  patch($('#callContext'), `<section class="card stack stack--sm" aria-labelledby="callDetailsTitle"><h2 class="h4" id="callDetailsTitle">Details</h2>
    <dl class="kv"><div><dt>Service</dt><dd>${esc(c.service)}</dd></div><div><dt>Priority</dt><dd>${priorityBadge(c.priority)}</dd></div><div><dt>Technician</dt><dd>${esc(c.technician_name || 'Not assigned')}</dd></div><div><dt>Started</dt><dd>${elapsed(c.created_at)} ago</dd></div></dl>
    ${c.reason ? `<p class="help">Routing: ${esc(c.reason)}</p>` : ''}</section>
    ${briefPanel ? `<section class="card">${briefPanel}</section>` : ''}
    <div class="card stack stack--sm"><section class="stack stack--sm" aria-labelledby="callKnowledgeTitle"><h3 class="h4" id="callKnowledgeTitle">Suggested knowledge</h3><p class="help">${status === 'searching' ? '● Finding guidance for the latest customer problem…' : status === 'error' ? `✕ ${esc(c.knowledge_error)}` : 'AI suggestions, updated as the customer describes the issue. Verify before using.'}</p>
    ${guidance.map(k => `<details data-kb="${esc(k.id)}" ${openKnowledge.has(k.id) ? 'open' : ''}><summary><span class="mono">${esc(k.id)}</span>&nbsp;· ${esc(k.title)}</summary><p class="sec">${esc(k.excerpt)}</p><ol class="plain-steps">${k.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol></details>`).join('') || `<p class="sec">${status === 'ready' ? 'No relevant articles found.' : 'Suggestions appear after the customer speaks.'}</p>`}</section></div>
    <section class="card"><details data-detail><summary>Routing history</summary><ol class="plain-steps">${history || '<li class="help">No routing events recorded.</li>'}</ol></details></section>`);
  const turnsBox = workspace.querySelector('.turns');
  if (turnsBox) turnsBox.scrollTop = atTop ? 0 : Math.max(0, turnsBox.scrollHeight - fromBottom);
  announceNewTurns(c, sameCall);
  workspace.dataset.callId = c.id;
  renderCallTicket(c);
}

function renderCallKnowledge(call, open = new Set()) {
  const container = $('#activeCallKnowledge');
  if (!container) return;
  const matched = call.knowledge_matches || [];
  const all = calling.knowledgeData || [];
  const search = calling.knowledgeSearch.trim().toLowerCase();
  const searchWords = search.split(/\s+/).filter(Boolean);
  let articles;
  if (matched.length && !search) {
    articles = matched.slice(0, 5).map(match => {
      const full = all.find(article => article.id === match.id);
      return full ? {...full, excerpt: match.excerpt || full.symptoms} : {...match, symptoms: match.excerpt || '', product: '', resolution: ''};
    });
  } else {
    const words = `${call.service || ''} ${(call.transcript || []).map(turn => turn.text).join(' ')}`.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2);
    const uniqueWords = [...new Set(words)];
    articles = all.map(article => {
      const haystack = `${article.title} ${article.product} ${article.symptoms} ${(article.tags || []).join(' ')} ${(article.steps || []).join(' ')}`.toLowerCase();
      const score = uniqueWords.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
      return {article, score, haystack};
    }).filter(item => !searchWords.length || searchWords.every(word => item.haystack.includes(word)))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5).map(item => item.article);
  }
  const status = call.knowledge_status;
  const note = matched.length ? 'Ranked from this call’s latest conversation.' : all.length ? 'Browse the team knowledge base while the customer explains the issue.' : status === 'error' ? esc(call.knowledge_error || 'Could not load knowledge articles.') : 'No knowledge articles have been added yet.';
  container.innerHTML = `<p class="helper">${note}</p>${articles.map(article => {
    const summary = article.excerpt || article.symptoms || '';
    const steps = article.steps || [];
    return `<details class="active-call-article" data-kb="${esc(article.id)}" ${open.has(article.id) ? 'open' : ''}><summary>${esc(article.title)}</summary><p><strong>${esc(article.product || call.service || 'Support')}</strong>${summary ? ` · ${esc(summary)}` : ''}</p>${steps.length ? `<ol>${steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}${article.resolution ? `<p><strong>Resolution:</strong> ${esc(article.resolution)}</p>` : ''}<button type="button" class="text-button" data-call-knowledge="${esc(article.id)}" data-call-knowledge-title="${esc(article.title)}">Open in Knowledge →</button></details>`;
  }).join('') || `<p class="helper">${search ? 'No matching articles. Try a shorter search.' : status === 'searching' ? 'Finding call-related guidance…' : 'No matching guidance yet. Search the knowledge base above.'}</p>`}`;
}

async function renderCallTicket(call) {
  const panel = $('#activeCallTicketPanel');
  const ended = ['Completed','Failed','Callback requested'].includes(call.status);
  $('#activeCallKnowledgePanel').hidden = ended;
  panel.hidden = !ended;
  if (!ended) return;
  if (!call.case_id) {
    patch(panel, `<h2 class="h3">Incident</h2><p class="sec">${['Completed','Failed','Callback requested'].includes(call.status) ? (call.transcript.some(t=>t.speaker==='Customer') ? '● Creating the incident from the conversation…' : 'No incident: the customer didn’t describe an issue.') : 'An incident is created from the conversation when the call ends.'}</p>`);
    return;
  }
  try {
    const item = await api(`/api/cases/${call.case_id}`);
    if (calling.selected !== call.id) return;
    const t = item.ticket;
    patch(panel, `<div class="section-head section-head--tight"><div><p class="kicker">Linked incident</p><h2 class="h3"><span class="mono">${esc(t.id)}</span></h2></div>${stateBadge(t.state)}</div><p><strong>${esc(t.short_description)}</strong></p><dl class="kv"><div><dt>Priority</dt><dd>${priorityBadge(t.priority)}</dd></div><div><dt>Service</dt><dd>${esc(t.service)}</dd></div><div><dt>Assigned to</dt><dd>${esc(t.assigned_to || 'Unassigned')}</dd></div><div><dt>Category</dt><dd>${esc(t.category)} · ${esc(t.subcategory)}</dd></div></dl><p class="sec pre" data-detail>${esc(t.description)}</p><div><a class="link" href="${window.Shell.home(state.user.role)}?ticket=${encodeURIComponent(item.id)}" data-ticket-link="${esc(item.id)}"><span>Open<span class="sr"> ${esc(t.id)}</span> to edit</span></a></div>`);
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
}

async function acceptBrowserCall(id, connection, microphone) {
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
    if (!room.localParticipant.permissions?.canPublish) throw new Error('Microphone permission confirmation timed out. Please retry.');
    const capture = microphone ? await microphone : null;
    if (capture?.error) throw capture.error;
    if (capture?.track) await room.localParticipant.publishTrack(capture.track, {source: LivekitClient.Track.Source.Microphone});
    else await room.localParticipant.setMicrophoneEnabled(true);
    // Device enumeration is supplementary and must not delay the connected state.
    ResolveAIVoice.microphonePanel(room).catch(() => {});
  } catch(error) {
    await room?.disconnect(); calling.room=null;calling.roomCallId=null;calling.joining=null;calling.reconnecting=false;
    try {await api(`/api/calling/${id}/transfer`,{method:'POST',body:'{}'});} catch(_) {}
    throw error;
  }
}

// Answer: claim the call and join its audio room. The microphone is opened at the same time as the claim, so the
// customer hears the technician sooner. Refusals are explained in plain words next to the queue.
async function answerCall(id) {
  if (calling.answering || calling.roomCallId) return;
  calling.answering = id; calling.selected = id;
  const started = performance.now(), error = $('#answerError');
  const call = [...(calling.data?.calls || []), ...(calling.data?.incoming_calls || [])].find(c => c.id === id);
  const buttons = $$('[data-pickup-call], [data-call-action="accept"]');
  buttons.forEach(button => { button.disabled = true; button.setAttribute('aria-busy', 'true'); });
  error.hidden = true; $('#callAnswerStatus').textContent = '● Connecting your call…';
  const microphone = call?.origin === 'browser' ? Promise.resolve().then(() => LivekitClient.createLocalAudioTrack({echoCancellation: true, noiseSuppression: true, autoGainControl: true})).then(track => ({track}), failure => ({error: failure})) : null;
  try {
    const result = await api(`/api/calling/${id}/accept`, {method: 'POST', body: '{}'});
    if (result.token) await acceptBrowserCall(id, result, microphone);
    $('#callAnswerStatus').textContent = '✓ Call connected.';
    if (new URLSearchParams(location.search).get('call') !== id) history.pushState({view: 'calls', call: id}, '', `${location.pathname}?view=calls&call=${encodeURIComponent(id)}`);
    console.info('Call pickup duration (ms)', Math.round(performance.now() - started));
    showView('calls');
  } catch (failure) {
    const fixes = {'Enable calls before answering.': 'Turn the Microphone switch on above, then choose Answer again.',
                   'Set yourself Available before answering a call.': 'Set Availability to Available above, then choose Answer again.'};
    $('#callAnswerStatus').textContent = '';
    $('#answerErrorMessage').textContent = `${failure.message} ${fixes[failure.message] || ''}`.trim();
    error.hidden = false; error.focus();
  } finally {
    microphone?.then(capture => { if (capture?.track && calling.roomCallId !== id) capture.track.stop(); });
    calling.answering = null;
    buttons.forEach(button => { button.disabled = false; button.removeAttribute('aria-busy'); });
    await loadCalling();
  }
}

document.addEventListener('click', async event => {
  try {
    if (event.target.closest('[data-close-call-modal="livekitModal"]')) $('#livekitForm [name=api_secret]').value = '';
    const select = event.target.closest('[data-call-select]');
    if (select && !(event.metaKey || event.ctrlKey || event.shiftKey)) { event.preventDefault(); await selectCall(select.dataset.callSelect); }
    const ticket = event.target.closest('[data-call-ticket]');
    if (ticket) await openTicketDetails(ticket.dataset.callTicket);
    const pickup = event.target.closest('[data-pickup-call]');
    if (pickup) await answerCall(pickup.dataset.pickupCall);
    const action = event.target.closest('[data-call-action]');
    if (action) {
      const id = calling.selected, kind = action.dataset.callAction;
      if (kind === 'accept') { await answerCall(id); return; }
      if (['transfer', 'finish'].includes(kind)) {
        const dialog = $('#callActionDialog'); dialog.dataset.callId = id; dialog.dataset.action = kind;
        $('#callActionTitle').textContent = kind === 'transfer' ? 'Transfer this call?' : 'Finish this call?';
        $('#callActionDescription').textContent = kind === 'transfer' ? 'The call will return to the support queue for another technician.' : 'The conversation will stop for everyone.';
        $('#confirmCallAction').textContent = kind === 'transfer' ? 'Transfer call' : 'Finish call';
        dialog.showModal(); return;
      }
      action.disabled = true;
      const comment = kind === 'finish' ? (calling.noteDrafts[id] ?? $('#callNoteText')?.value ?? '') : '';
      const result = await api(`/api/calling/${id}/${kind}`, {method:'POST',body:JSON.stringify({technician_comment:comment})});
      if (kind === 'finish') delete calling.noteDrafts[id];
      if (['decline','finish','transfer'].includes(kind) && calling.roomCallId === id) {
        const room=calling.room; calling.room=null;calling.roomCallId=null;await room?.disconnect();
      }
      await loadCalling();
    }
    if (event.target.closest('#resumeAudioButton')) {await calling.room?.startAudio();$('#resumeAudioButton').hidden=true;}
    if (event.target.closest('#signInButton')) location.assign('/?auth=login&as=staff');
    if (event.target.closest('#addTechnicianButton')) { $('#technicianForm').reset(); $('#technicianMessage').textContent = ''; $('#technicianModal').showModal(); }
    if (event.target.closest('#retryUsers')) await loadCalling();
    if (event.target.closest('#routeRequestButton')) { $('#requestMessage').textContent = ''; $('#requestModal').showModal(); }
    if (event.target.closest('#retryCalls')) await loadCalling();
    if (event.target.closest('#confirmCallAction')) {
      const dialog = $('#callActionDialog'), id = dialog.dataset.callId, kind = dialog.dataset.action;
      dialog.close();
      const comment = kind === 'finish' ? (calling.noteDrafts[id] ?? $('#callNoteText')?.value ?? '') : '';
      const result = await api(`/api/calling/${id}/${kind}`, {method:'POST',body:JSON.stringify({technician_comment:comment})});
      if (kind === 'finish') delete calling.noteDrafts[id];
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

document.addEventListener('input', event => {
  const note = event.target.closest('#callNoteText');
  if (!note?.dataset.callId) return;
  const callId = note.dataset.callId, text = note.value;
  calling.noteDrafts[callId] = text;
  clearTimeout(calling.noteDraftTimers[callId]);
  calling.noteDraftTimers[callId] = setTimeout(() => {
    calling.noteDraftSaves[callId] = (calling.noteDraftSaves[callId] || Promise.resolve())
      .catch(() => {}).then(() => api(`/api/calling/${callId}/note-draft`, {method:'PUT', body:JSON.stringify({text})}));
  }, 350);
});

$('#presenceSelect').addEventListener('change', async event => {
  try { await api('/api/technicians/me/presence', {method:'PATCH',body:JSON.stringify({status:event.target.value})}); await heartbeat(); await loadCalling(); }
  catch(error) { showFeedback(error.message, true); }
});

$('#micSwitch').addEventListener('click', async () => {
  const button = $('#micSwitch');
  if (calling.micBusy || button.disabled) return;
  calling.micBusy = true; button.disabled = true; button.setAttribute('aria-busy', 'true');
  try {
    if (calling.room && calling.roomCallId) {
      await calling.room.localParticipant.setMicrophoneEnabled(!calling.room.localParticipant.isMicrophoneEnabled);
    } else if (button.getAttribute('aria-checked') === 'true') {
      calling.user = await api('/api/technicians/me/call-settings', {method:'PATCH', body:JSON.stringify({enabled:false})});
      calling.ready = false; await heartbeat();
    } else {
      if (!calling.user.calls_enabled) calling.user = await api('/api/technicians/me/call-settings', {method:'PATCH', body:JSON.stringify({enabled:true})});
      calling.ready = false; await enablePhone();
    }
  } catch (error) { showFeedback(error.message, true); }
  finally { calling.micBusy = false; button.removeAttribute('aria-busy'); await loadCalling(); button.focus(); }
});

async function submitCallingForm(event, path, messageId, transform, after) {
  event.preventDefault();
  const form = event.target, button = form.querySelector('button[type=submit]');
  const message = $(messageId);
  if (!form.checkValidity()) { const bad = [...form.elements].find(el => el.willValidate && !el.validity.valid); bad.setAttribute('aria-invalid', 'true'); message.className = 'form-status err'; const label = form.querySelector(`label[for="${bad.id}"]`)?.textContent || 'This field';
    const why = bad.validity.valueMissing ? 'is required.' : bad.validity.tooShort ? `needs at least ${bad.minLength} characters.` : bad.validity.patternMismatch ? `can only use ${bad.id === 'userUsername' ? 'letters, numbers and . _ @ -' : 'the allowed characters'}.` : bad.validationMessage;
    message.textContent = `✕ ${label} ${why}`; bad.focus(); return; }
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
  if (event.target.id === 'techReplyForm') submitCallingForm(event, `/api/calling/${calling.selected}/reply`, '#techReplyMessage', null, async () => { document.activeElement?.blur(); });
});
$('#technicianForm').addEventListener('submit', event => submitCallingForm(event, '/api/users', '#technicianMessage', values => ({...values, skills: (values.skills || 'general').split(',').map(x => x.trim()).filter(Boolean), languages: (values.languages || 'en').split(',').map(x => x.trim()).filter(Boolean)}), async user => {
  $('#technicianModal').close(); state.users = await api('/api/users');
  toast(`Account created for ${user.name} (${user.username}). Share the login details securely.`);
}));
$('#routeRequestForm').addEventListener('submit', event => submitCallingForm(event, '/api/calling/requests', '#requestMessage', null, async result => {
  $('#requestModal').close(); toast('Incident created and routed.'); selectCall(result.id);
}));

async function openLiveKitSetup() {
  const config = await api('/api/config/livekit');
  $('#livekitForm [name=url]').value=config.url;
  $('#livekitForm [name=api_key]').value=config.api_key;
  const secret=$('#livekitForm [name=api_secret]');secret.value='';secret.required=!config.credentials_saved;
  secret.placeholder=config.credentials_saved?'Saved securely · leave blank to keep':'Enter your API secret';
  $('#livekitMessage').textContent='';$('#livekitModal').showModal();
}
window.openLiveKitSetup = openLiveKitSetup;
$('#configurationLiveKitButton')?.addEventListener('click', async () => {
  const message = $('#configurationLiveKitMessage'); message.textContent = '';
  try { await openLiveKitSetup(); setFormStatus(message, ''); }
  catch (error) { setFormStatus(message, error.status === 403 ? `○ ${error.message}` : `✕ ${error.message}`, error.status !== 403); }
});
$('#livekitForm').addEventListener('submit', async event=>{
  event.preventDefault();const form=event.target,button=form.querySelector('button[type=submit]'),message=$('#livekitMessage');
  button.disabled=true;button.setAttribute('aria-busy','true');setFormStatus(message,'Checking the LiveKit connection…');
  try {
    await api('/api/config/livekit',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    calling.ready=false;await heartbeat();await loadCalling();
    setFormStatus(message,'✓ Connected and saved. Technicians can now enable browser calls.');toast('LiveKit connection saved.');
    form.querySelector('[name=api_secret]').required=false;
    form.querySelector('[name=api_secret]').placeholder='Saved securely · leave blank to keep';
  }catch(error){setFormStatus(message,`✕ Not saved: ${error.message}`,true);}
  finally{form.querySelector('[name=api_secret]').value='';button.disabled=false;button.removeAttribute('aria-busy');}
});

// Refresh every second while a call is live (so the transcript keeps up), every 4 s otherwise.
let callTick = 0;
setInterval(() => {
  if (!calling.user || calling.user.role === 'customer') return;
  const selected = calling.data?.calls.find(call => call.id === calling.selected);
  const live = calling.user.current_call_id || ['AI', 'Ringing', 'Queued', 'Connected'].includes(selected?.status);
  if (live || ++callTick % 4 === 0) loadCalling();
}, 1000);
setInterval(heartbeat, 10000);
$('#callSearch').addEventListener('input', () => { if (calling.data) renderCalling(); });
$('#callSort').addEventListener('change', () => { if (calling.data) renderCalling(); });
document.addEventListener('click', event => {
  const filter = event.target.closest('[data-call-filter]');
  if (!filter) return;
  calling.priority = filter.dataset.callFilter;
  document.querySelectorAll('[data-call-filter]').forEach(button => button.setAttribute('aria-pressed', String(button === filter)));
  if (calling.data) renderCalling();
});
loadCalling();
