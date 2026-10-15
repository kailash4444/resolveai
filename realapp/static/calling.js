const calling = { user: null, data: null, noteDrafts: {}, noteDraftTimers: {}, noteDraftSaves: {}, selected: null, room: null, roomCallId: null, ready: false, loading: false, notice: null, priority: 'All', micDenied: false, reconnecting: false, joining: null, answering: null };

function elapsed(at) { return at ? `${Math.max(0, Math.floor((Date.now() / 1000 - at) / 60))} min` : '—'; }
const CALL_BADGES = {Completed: ['badge--ok', '✓ Completed'], Failed: ['badge--err', '✕ Failed'], Declined: ['badge--err', '✕ Declined'], Connected: ['badge--medium', '● Connected'], 'Callback requested': ['badge--high', '◆ Callback requested'], Ringing: ['badge--high', '◆ Ringing'], Queued: ['badge--muted', '○ Waiting'], AI: ['badge--medium', '● With AI'], Triage: ['badge--medium', '● With AI'], Available: ['badge--ok', '✓ Available'], Busy: ['badge--medium', '● On a call'], Away: ['badge--muted', '○ Away'], Offline: ['badge--muted', '○ Offline']};
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
    // Who is signed in only needs asking once; after that the calling data carries the user.
    if (!calling.data) {
      const auth = await api('/api/auth/status');
      calling.user = auth.user;
      if (!calling.user) { $('#signInButton').hidden = false; $('#routeRequestButton').disabled = true; return; }
      if (calling.user.role === 'customer') { calling.data = null; calling.selected = null; return; }
    }
    calling.data = await api('/api/calling');
    calling.user = calling.data.user;
    if (calling.user.role === 'admin' && $('#view-technicians').classList.contains('active')) calling.data.users = await api('/api/users');
    $('#callsUnavailable').hidden = true; $('#usersError').hidden = true;
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
  // One switch: on/off for taking browser calls, or mute/unmute while you are on a call. While a click is still
  // being applied, polling leaves the switch and its label alone so it doesn't flicker back.
  const micSwitch = $('#micSwitch'), on = inCall ? !muted : !!(user.calls_enabled && calling.ready);
  micSwitch.hidden = false;
  micSwitch.disabled = !voice.configured || (!!user.current_call_id && !inCall);
  if (!calling.micBusy) {
    setBadge($('#microphoneIndicator'), mic[0], mic[1]); $('#callMicState').textContent = mic[2];
    micSwitch.setAttribute('aria-checked', String(on));
    micSwitch.title = on ? 'Turn the microphone off' : 'Turn the microphone on';
  }
  const offer = calling.data.calls.find(c => c.technician_id === user.id && c.status === 'Ringing');
  const waiting = (calling.data.incoming_calls || []).filter(call => call.channel !== 'chat' && !dismissedOffers.has(call.id)).length;   // chats have their own card; rejected ones don't count
  const call = calling.reconnecting ? ['badge--high', '◆ Reconnecting', 'Audio dropped. Trying to restore the call…']
    : calling.joining ? ['badge--medium', '● Joining call', 'Connecting your audio…']
    : calling.roomCallId ? ['badge--medium', '● Connected', 'You’re on a call. Your saved availability resumes afterward.']
    : offer && offer.channel !== 'chat' ? ['badge--high', '◆ Ringing', `A call is offered to you. ${Math.max(0, Math.ceil(offer.reserved_until - Date.now() / 1000))} seconds to answer.`]
    : waiting ? ['badge--muted', `○ ${waiting} waiting`, 'Customers are waiting for a technician.']
    : ['badge--muted', '○ No active call', user.calls_enabled ? 'New calls appear here and in the banner.' : 'Browser calls are off; desk requests still reach you.'];
  setBadge($('#activeCallIndicator'), call[0], call[1]); $('#phoneConnection').textContent = call[2];
  $('#voiceNotConfigured').hidden = voice.configured;
  if (!voice.configured) $('#voiceNotConfiguredText').textContent = user.role === 'admin' ? 'Configure LiveKit on the server to take browser calls. Desk requests still work.' : 'An administrator needs to connect LiveKit. Desk requests still work.';
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
  const newest = $('#callSort').dataset.direction !== 'oldest';
  calls.sort((a, b) => newest ? b.created_at - a.created_at : a.created_at - b.created_at);
  $('#signInButton').hidden = true;
  $('#presenceControl').hidden = false;
  $('#routeRequestButton').disabled = false;
  $('#technicianIdentity').textContent = `${calling.user.name} · AI handles first contact; you join when a customer needs a person.`;
  if (document.activeElement !== $('#presenceSelect')) $('#presenceSelect').value = calling.user.availability;
  $('#presenceSelect').disabled = !!calling.user.current_call_id;
  const offer = renderIndicators();
  renderCallOffer(offer);
  renderChatOffer(offer);
  $('#callsQueued').textContent = metrics.queued;
  $('#callsAI').textContent = metrics.ai;
  $('#callsConnected').textContent = metrics.connected;
  $('#callsAvailable').textContent = metrics.available;
  $('#demoQueueAvailability').textContent = metrics.demo_available ? `${metrics.demo_available} demo technicians shown available; real calls require a connected microphone.` : '';
  $('#callPerformance').textContent = `All time: ${metrics.total ?? 0} requests · ${metrics.completed ?? 0} completed · ${metrics.callbacks ?? 0} callbacks to follow up · ${metrics.average_wait_seconds ?? 0} s average wait before a technician connected.`;
  $('#callingSync').textContent = `✓ Updated ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
  const callPage = paginateItems(calls, callPager, JSON.stringify([calling.user?.id, query, calling.priority, newest]), '#callPagination');
  patch($('#callList'), calls.length ? `<ul class="list">${callPage.map(c => { return `<li class="list__row"><span class="list__main"><strong>${esc(c.caller)}</strong><span class="help">${esc(c.service)} · ${(c.origin === 'browser' ? 'Browser call' : c.channel === 'chat' ? 'Chat' : 'Desk request')} · ${esc(c.technician_name || (['AI','Triage'].includes(c.status) ? 'AI assistant' : 'Unassigned'))} · ${esc(when(new Date(c.created_at * 1000).toISOString()))}</span></span>${priorityBadge(c.priority)}${callBadge(c.status)}<a class="link" href="?view=calls&amp;call=${encodeURIComponent(c.id)}" data-call-select="${esc(c.id)}"><span>Open<span class="sr"> call from ${esc(c.caller)}</span></span></a></li>`; }).join('')}</ul>`
    : calling.data.calls.length ? '<p class="sec">No calls match this search.</p>' : '<div class="empty"><h3 class="h4">The queue is empty</h3><p class="sec">Incoming browser calls and routed support requests appear here.</p></div>');
  const incoming = calling.data.incoming_calls || [];
  $('#sharedQueuePanel').hidden = !incoming.length;
  $('#answerHint').hidden = !incoming.some(call => call.origin === 'browser') || !!calling.user?.voice_ready;
  patch($('#sharedQueue'), incoming.map(call => `<li class="list__row"><span class="list__main"><strong>${esc(call.origin === 'browser' ? 'Incoming browser call' : call.channel === 'chat' ? 'Incoming chat' : 'Support request')}</strong><span class="help">${esc(call.service)} · Started ${esc(when(new Date(call.created_at * 1000).toISOString()))}</span></span>${priorityBadge(call.priority)}<button type="button" class="btn btn-primary btn-sm" data-pickup-call="${esc(call.id)}"><span>Answer<span class="sr"> ${esc(call.service)} call</span></span></button>${handoffCard(call)}</li>`).join(''));
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
  // An open call gets the page to itself: queue numbers and the waiting list return with "All calls".
  $('#view-calls').classList.toggle('calls--focused', open);
  if (!open) $('#view-calls').classList.remove('calls--live');
  if (open) renderCallDetail();
  renderDock(open ? pageCall : null);
}

// ---- Incoming call in the Call card: Answer or Reject ----
// A call offered to me comes first, then the oldest call waiting in the shared queue. Reject declines an offer made
// to me; for a shared-queue call it just hides it here (another technician can still answer it).
const dismissedOffers = new Set();
const ICON_PHONE = '<svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h3l2 5-2 2a15 15 0 0 0 5 5l2-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z"/></svg>';
const ICON_X = '<svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
function renderCallOffer(offer) {
  const box = $('#callOffer'), user = calling.user;
  const queued = (calling.data.incoming_calls || []).find(call => call.channel !== 'chat' && !dismissedOffers.has(call.id));
  const call = calling.roomCallId || myLiveCall() ? null : (offer && offer.channel !== 'chat' && !dismissedOffers.has(offer.id) ? offer : queued);
  box.hidden = !call;
  if (!call) { patch(box, ''); return; }
  const name = call.caller || 'Customer', mine = call.technician_id === user.id && call.status === 'Ringing';
  setBadge($('#activeCallIndicator'), 'badge--medium', `● Incoming ${call.channel === 'chat' ? 'chat' : 'call'} · ${name}`);
  $('#phoneConnection').textContent = call.summary && call.summary !== 'Understanding the customer issue' ? call.summary : 'A customer asked for a technician.';
  patch(box, `<div class="call-controls"><button type="button" class="call-btn call-btn--answer" data-pickup-call="${esc(call.id)}"><span class="call-btn__icon">${ICON_PHONE}</span>Answer ${call.channel === 'chat' ? 'chat' : 'call'}<span class="sr"> from ${esc(name)}</span></button><button type="button" class="call-btn call-btn--danger" data-reject-call="${esc(call.id)}" data-offered="${mine ? 1 : 0}"><span class="call-btn__icon">${ICON_X}</span>Reject ${call.channel === 'chat' ? 'chat' : 'call'}<span class="sr"> from ${esc(name)}</span></button></div>`);
}
document.addEventListener('click', async event => {
  const reject = event.target.closest('[data-reject-call]');
  if (!reject) return;
  const id = reject.dataset.rejectCall;
  dismissedOffers.add(id);
  if (calling.data) renderCalling();
  if (reject.dataset.offered === '1') {
    try { await api(`/api/calling/${id}/decline`, {method: 'POST', body: '{}'}); }
    catch (error) { showFeedback(error.message, true); }
    loadCalling();
  }
});

// ---- Chat card: incoming chats, with an alert (sound, title and, if allowed, a browser notification) ----
const notifiedChats = new Set();
function renderChatOffer(offer) {
  const live = myLiveCall(), box = $('#chatOffer');
  const waiting = (calling.data.incoming_calls || []).filter(call => call.channel === 'chat' && !dismissedOffers.has(call.id));
  const incoming = live ? null : (offer && offer.channel === 'chat' && !dismissedOffers.has(offer.id) ? offer : waiting[0]);
  box.hidden = !incoming;
  if (live?.channel === 'chat') {
    setBadge($('#chatIndicator'), 'badge--ok', `✓ Chatting with ${live.caller}`);
    $('#chatCardText').innerHTML = `<a class="link" href="?view=calls&amp;call=${encodeURIComponent(live.id)}" data-call-select="${esc(live.id)}">Open the chat</a>`;
  } else if (incoming) {
    const name = incoming.caller || 'Customer', mine = incoming.technician_id === calling.user.id && incoming.status === 'Ringing';
    setBadge($('#chatIndicator'), 'badge--medium', `● Incoming chat · ${name}`);
    $('#chatCardText').textContent = incoming.summary && incoming.summary !== 'Understanding the customer issue' ? incoming.summary : 'A customer is waiting in chat.';
    patch(box, `<div class="call-controls"><button type="button" class="call-btn call-btn--answer" data-pickup-call="${esc(incoming.id)}"><span class="call-btn__icon">${ICON_CHAT}</span>Accept chat<span class="sr"> from ${esc(name)}</span></button><button type="button" class="call-btn call-btn--danger" data-reject-call="${esc(incoming.id)}" data-offered="${mine ? 1 : 0}"><span class="call-btn__icon">${ICON_X}</span>Reject chat<span class="sr"> from ${esc(name)}</span></button></div>`);
  } else {
    setBadge($('#chatIndicator'), 'badge--muted', waiting.length ? `○ ${waiting.length} waiting` : '○ No chats waiting');
    $('#chatCardText').textContent = live ? 'You’re on a call. New chats go to other technicians.' : 'New chats from customers appear here.';
    patch(box, '');
  }
  $('#chatAlertsButton').hidden = !('Notification' in window) || Notification.permission !== 'default';
  document.title = (incoming ? '● New chat · ' : '') + document.title.replace(/^● New chat · /, '');
  if (incoming && !notifiedChats.has(incoming.id)) {
    notifiedChats.add(incoming.id);
    chime();
    if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !$('#view-calls').classList.contains('active'))) {
      const note = new Notification(`New chat · ${incoming.caller || 'Customer'}`, {body: incoming.summary || 'A customer is waiting in chat.', tag: incoming.id});
      note.onclick = () => { window.focus(); history.pushState({view: 'calls'}, '', `${location.pathname}?view=calls`); showView('calls'); note.close(); };
    }
  }
}
const ICON_CHAT = '<svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12z"/></svg>';
// Two soft notes. Browsers only allow sound after the person has clicked on the page, so this may stay silent.
function chime() {
  try {
    const audio = new (window.AudioContext || window.webkitAudioContext)(), start = audio.currentTime;
    [[660, 0], [880, .16]].forEach(([frequency, at]) => {
      const tone = audio.createOscillator(), gain = audio.createGain();
      tone.frequency.value = frequency; tone.connect(gain); gain.connect(audio.destination);
      gain.gain.setValueAtTime(0.0001, start + at); gain.gain.exponentialRampToValueAtTime(0.12, start + at + .02); gain.gain.exponentialRampToValueAtTime(0.0001, start + at + .25);
      tone.start(start + at); tone.stop(start + at + .3);
    });
  } catch (_) {}
}
$('#chatAlertsButton').addEventListener('click', async () => {
  try { await Notification.requestPermission(); } catch (_) {}
  if (calling.data) renderCalling();
});

// ---- Live call dock: a frosted panel at the top of Calls & queue while I'm connected to a call ----
// Header (name, LIVE CALL, queue / call ID / ticket), three always-visible sections that each scroll on their own,
// and Mute / End call. It isn't shown on the full call page for the same call, which has its own controls.
const ticketNumbers = {};
function myLiveCall() {
  const user = calling.user;
  return calling.data?.calls.find(call => call.id === user?.current_call_id && call.status === 'Connected' && call.technician_id === user.id);
}
function ticketNumber(call) {
  if (call.live_ticket_id) return call.live_ticket_id;
  if (!call.case_id) return null;
  if (!(call.case_id in ticketNumbers)) {
    ticketNumbers[call.case_id] = null;
    api(`/api/cases/${encodeURIComponent(call.case_id)}`).then(item => { ticketNumbers[call.case_id] = item.ticket.id; if (calling.data) renderCalling(); }).catch(() => {});
  }
  return ticketNumbers[call.case_id];
}
function renderDock(pageCallId) {
  const dock = $('#callDock'), call = myLiveCall();
  if (!call || pageCallId === call.id) { dock.hidden = true; delete dock.dataset.callId; return; }
  const fresh = dock.hidden || dock.dataset.callId !== call.id;
  if (dock.dataset.callId !== call.id) {
    dock.dataset.callId = call.id;
    dock.innerHTML = `<div class="dock-head" id="dockHead"></div><div class="dock-grid">
      <section class="dock-pane dock-pane--lead" aria-labelledby="dockSummaryTitle"><h3 class="dock-label" id="dockSummaryTitle">AI summary · next step</h3><div class="dock-scroll" id="dockSummary" tabindex="0"></div></section>
      <section class="dock-pane" aria-labelledby="dockKnowledgeTitle"><h3 class="dock-label" id="dockKnowledgeTitle">Related knowledge</h3><div class="dock-scroll" id="dockKnowledge" tabindex="0"></div></section>
      <section class="dock-pane" aria-labelledby="dockConvoTitle"><h3 class="dock-label" id="dockConvoTitle">Latest conversation</h3><div class="dock-scroll" id="dockConvo" tabindex="0" aria-live="polite"></div></section></div>
      <div class="dock-actions" id="dockActions"></div>`;
  }
  dock.hidden = false;
  const ticket = ticketNumber(call), chat = call.channel === 'chat';
  patch($('#dockHead'), `<div class="dock-title"><h2 class="dock-name">${esc(call.caller)}</h2><span class="live-chip"><i aria-hidden="true"></i>LIVE ${chat ? 'CHAT' : 'CALL'}</span></div>
    <a class="btn btn-soft btn-sm" href="?view=calls&amp;call=${encodeURIComponent(call.id)}" data-call-select="${esc(call.id)}">Open full ${chat ? 'chat' : 'call'}</a>
    <dl class="dock-meta"><div><dt>Queue</dt><dd>${esc(call.service || 'General')}</dd></div><div><dt>Call ID</dt><dd>${esc(call.id)}</dd></div><div><dt>Ticket</dt><dd>${esc(ticket || 'Creating…')}</dd></div></dl>`);
  const brief = call.handoff_brief || {};
  const summary = [call.summary, brief.issue].find(text => text && text !== 'Understanding the customer issue') || 'The AI is still working out the customer’s issue.';
  const question = call.next_question || brief.next_step || call.recommended_action;
  patch($('#dockSummary'), `<p>${esc(summary)}</p>${question ? `<p class="dock-question">${esc(question)}</p>` : ''}<p class="dock-note">Based on the latest customer update. Updates with the conversation.</p>`);
  const matches = call.knowledge_matches || [];
  patch($('#dockKnowledge'), matches.length ? `<ul class="dock-list">${matches.map(k => `<li><strong>${esc(k.title)}</strong><span class="dock-note">${esc(k.id)}</span></li>`).join('')}</ul>`
    : '<p>Related knowledge will appear as the customer describes the issue.</p>');
  const convo = $('#dockConvo'), before = convo.dataset.html;
  patch(convo, call.transcript.length ? call.transcript.map(turn => `<p class="dock-msg"><b>${esc(turn.speaker_name || turn.speaker)}:</b> ${esc(turn.text)}</p>`).join('')
    : '<p>The conversation appears here as people speak.</p>');
  if (fresh || convo.dataset.html !== before) convo.scrollTop = convo.scrollHeight;   // always open at the newest message
  const inRoom = calling.room && calling.roomCallId === call.id, muted = inRoom && !calling.room.localParticipant.isMicrophoneEnabled;
  patch($('#dockActions'), `${inRoom ? `<button type="button" class="btn btn-soft btn-sm" data-dock-mute aria-pressed="${muted}">${muted ? 'Unmute' : 'Mute'}</button>` : ''}<button type="button" class="btn btn-danger btn-sm" data-call-action="finish" data-call-id="${esc(call.id)}">End ${chat ? 'chat' : 'call'}</button>`);
}
document.addEventListener('click', async event => {
  const mute = event.target.closest('[data-dock-mute]');
  if (!mute || !calling.room) return;
  const participant = calling.room.localParticipant, muted = !participant.isMicrophoneEnabled;
  mute.disabled = true;
  try { await participant.setMicrophoneEnabled(muted); }
  catch (error) { showFeedback(error.message, true); }
  finally { mute.disabled = false; if (calling.data) renderCalling(); }
});

// Users lists staff only (technicians and administrators). Customers create their own accounts and aren't listed.
function renderUsersTable() {
  $('#addTechnicianButton').hidden = calling.user?.role !== 'admin';
  const users = (calling.data.users || calling.data.technicians).filter(t => t.role !== 'customer');
  const demoCount = users.filter(t => t.demo_available).length;
  $('#demoAvailabilitySummary').textContent = demoCount ? `${demoCount}/${users.length} staff are always available for the demo. Actual call routing requires a connected technician.` : '';
  $('#technicianRows').innerHTML = paginateItems(users, userPager, calling.user?.id, '#userPagination').map(t => { const customer = t.role === 'customer'; return `<tr><th scope="row"><span class="stack stack--sm"><strong>${esc(t.name)}</strong><span class="mono help">${esc(t.username)}</span>${t.email && t.email !== t.username ? `<span class="help">${esc(t.email)}</span>` : ''}</span></th><td>${t.role === 'admin' ? 'Administrator' : customer ? 'Customer' : 'Technician'}</td><td class="col-opt">${customer ? '—' : esc(t.skills.join(', '))}</td><td class="col-opt">${esc(t.languages.join(', '))}</td><td>${customer ? '—' : callBadge(t.demo_available ? 'Available' : t.status) + (t.demo_available ? '<span class="help"> · Demo</span>' : '')}</td><td class="col-opt">${customer ? '—' : t.voice_ready ? '<span class="badge badge--ok">✓ Ready</span>' : '<span class="badge badge--muted">○ Not ready</span>'}</td><td>${t.current_call_id ? `<span class="mono">${esc(t.current_call_id)}</span>` : '<span class="help">—</span>'}</td></tr>`; }).join('');
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
  $('#callWorkspace .call-full__title')?.focus({preventScroll: true});
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

// Full call page: what the technician needs right after answering. Main column: AI summary (with the transfer brief
// folded away), suggested articles, AI next steps. Side: knowledge search and the scratch pad. Live transcription and
// routing history stay on the page, collapsed. The frame is built once per call and each part is refreshed on its own,
// so polling never clears the search box, closes an open article or moves the transcript.
const BOILERPLATE = ['welcome to resolveai','this call is transcribed','please describe the issue','i am connecting you','i’m connecting you','i will connect you','a technician will help','please stay on the call'];
function kbItem(article, open) {
  const steps = article.steps || [];
  return `<details class="kb-item" data-kb="${esc(article.id)}" ${open ? 'open' : ''}><summary>${esc(article.title)} <span class="help">${esc(article.id)}</span></summary>${article.excerpt || article.symptoms ? `<p class="sec">${esc(article.excerpt || article.symptoms)}</p>` : ''}${steps.length ? `<ol class="plain-steps">${steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}</details>`;
}
function renderCallSearch() {
  const list = $('#cfKbList'); if (!list) return;
  const open = new Set([...list.querySelectorAll('details[open]')].map(item => item.dataset.kb));
  const query = ($('#cfKbSearch')?.value || '').trim().toLowerCase();
  const articles = (state.knowledge || []).filter(article => !query || [article.id, article.title, article.product, article.symptoms, (article.tags || []).join(' '), (article.steps || []).join(' ')].join(' ').toLowerCase().includes(query));
  patch(list, articles.map(article => kbItem(article, open.has(article.id))).join(''));
  $('#cfKbEmpty').hidden = articles.length > 0;
}
document.addEventListener('input', event => { if (event.target.id === 'cfKbSearch') renderCallSearch(); });

function renderCallDetail() {
  const c = calling.data?.calls.find(c => c.id === calling.selected);
  if (!c) return;
  const own = c.technician_id === calling.user.id, canManage = own || calling.user.role === 'admin', chat = c.channel === 'chat';
  const live = ['Connected', 'AI'].includes(c.status);
  const workspace = $('#callWorkspace'), sameCall = workspace.dataset.callId === c.id;
  // The queue's own readiness cards are only needed while this call is still ringing (to switch the microphone on).
  $('#view-calls').classList.toggle('calls--live', c.status !== 'Ringing');
  if (!sameCall) {
    workspace.dataset.callId = c.id;
    workspace.innerHTML = `<header class="call-full__head" id="cfHead"></header><div class="stack" id="cfAlerts"></div>
      <div class="call-full__grid"><div class="call-full__col">
        <section class="card call-full__card call-brief" aria-labelledby="cfSummaryTitle"><h2 class="dock-label" id="cfSummaryTitle">AI summary · conversation so far</h2><div class="cf-scroll" id="cfSummary" tabindex="0"></div><details class="brief-more"><summary>Transfer brief</summary><div id="cfBrief"></div></details></section>
        <section class="card call-full__card" aria-labelledby="cfArticlesTitle"><div class="row row--between"><h2 class="dock-label" id="cfArticlesTitle">Suggested knowledge articles</h2><span class="help" id="cfArticlesStatus"></span></div><div class="cf-scroll" id="cfArticles" tabindex="0"></div></section>
        <section class="card call-full__card" aria-labelledby="cfStepsTitle"><h2 class="dock-label" id="cfStepsTitle">AI next steps</h2><div class="cf-scroll" id="cfSteps" tabindex="0"></div></section>
        <div id="cfReply"></div>
      </div><aside class="call-full__col" aria-label="Tools">
        <section class="card call-full__card" aria-labelledby="cfSearchTitle"><h2 class="dock-label" id="cfSearchTitle">Knowledge search</h2><div class="field field--inline"><label for="cfKbSearch">Search knowledge articles</label><input class="input" id="cfKbSearch" type="search" placeholder="For example: VPN, Outlook, printer" autocomplete="off"></div><div class="cf-scroll" id="cfKbList" tabindex="0" aria-label="Knowledge articles"></div><p class="help" id="cfKbEmpty" hidden>No articles match. Try another word.</p></section>
        <section class="card call-full__card" id="cfPad"></section>
      </aside></div>
      ${chat ? `<section class="card call-full__card" aria-labelledby="cfChatTitle"><div class="row row--between"><h2 class="dock-label" id="cfChatTitle">Chat with ${esc(c.caller)}</h2><span class="help" id="cfChatState"></span></div>
        <div class="chat-window" id="cfChat" tabindex="0" aria-live="polite" aria-relevant="additions" aria-label="Chat messages"></div>
        <form id="techReplyForm" class="chat-composer" novalidate><label class="sr" for="techReplyText">Reply to ${esc(c.caller)}</label><textarea class="input" id="techReplyText" name="text" rows="1" required maxlength="4000"></textarea><button type="submit" class="btn btn-primary">Send</button></form>
        <p class="form-status" id="techReplyMessage" role="status"></p></section>`
      : '<details class="card call-full__card" id="cfTranscript"><summary>Live transcription <span id="cfTxState"></span></summary><div id="cfTxBody"></div></details>'}
      <details class="card call-full__card"><summary>Routing history</summary><ol class="plain-steps" id="cfHistory"></ol></details>
      <div class="callbar" id="cfBar"></div>`;
    renderCallSearch();
  }
  const ticket = ticketNumber(c), caseKey = c.case_id || c.live_case_id;
  patch($('#cfHead'), `<div><p class="kicker"><span class="mono">${esc(c.id)}</span></p><h2 class="call-full__title" tabindex="-1">${esc(c.caller)}</h2>
    <p class="sec">${esc(c.service || 'General')} · ${esc(c.priority || 'P3')} · ${esc(c.technician_name || 'No technician yet')}${ticket ? ` · Ticket <a class="mono" href="${window.Shell.home(state.user.role)}?ticket=${encodeURIComponent(caseKey)}" data-ticket-link="${esc(caseKey)}">${esc(ticket)}</a>` : ''}</p></div>${callBadge(c.status)}`);

  // Alerts and the Accept / Decline choice for a call that is still ringing.
  const joinHint = c.status === 'Queued' ? '<p class="alert alert--info"><strong>◆ Waiting for a technician.</strong><span class="sec">Choose Answer in the Call card to join. Browser calls need the microphone switched on.</span></p>'
    : c.status === 'Completed' && c.queued_at && !c.connected_at ? '<p class="alert alert--info"><strong>○ This call ended while waiting.</strong><span class="sec">Its audio room is closed and can’t be joined. Ask the customer to start another support call.</span></p>'
    : ['Completed', 'Failed'].includes(c.status) ? '<p class="help">○ This call has ended, so it can’t be joined.</p>' : '';
  let ringing = '';
  if (c.status === 'Ringing' && own) {
    const phoneReady = c.origin !== 'browser' || calling.ready;
    ringing = `<div class="call-controls"><button type="button" class="call-btn call-btn--answer" data-call-action="accept" ${phoneReady ? '' : 'disabled aria-describedby="acceptHelp"'}><span class="call-btn__icon">${ICON_PHONE}</span>Accept</button><button type="button" class="call-btn call-btn--danger" data-call-action="decline"><span class="call-btn__icon">${ICON_X}</span>Decline</button>${phoneReady ? '' : '<p class="help" id="acceptHelp">Turn the microphone on above to accept browser calls.</p>'}</div>`;
  }
  patch($('#cfAlerts'), `${c.last_error ? `<div class="alert" role="alert"><strong>✕ Call problem.</strong><span class="sec">${esc(c.last_error)}</span></div>` : ''}${joinHint}${ringing}`);

  // AI summary and the folded transfer brief.
  const brief = c.handoff_brief, customerTurns = c.transcript.filter(turn => turn.speaker === 'Customer' && turn.text?.trim());
  const summary = [c.summary, brief?.issue].find(text => text && text !== 'Understanding the customer issue') || 'The AI is still working out the customer’s issue.';
  patch($('#cfSummary'), `<p class="call-brief__text">${esc(summary)}</p>${brief?.impact ? `<p class="sec"><strong>Impact:</strong> ${esc(brief.impact)}</p>` : ''}`);
  const tried = (brief?.tried || []).filter(item => !BOILERPLATE.some(phrase => item.toLowerCase().includes(phrase)));
  patch($('#cfBrief'), brief ? `<dl class="brief-grid"><dt>Issue</dt><dd>${esc(customerTurns[0]?.text || brief.issue || 'Not yet described')}</dd><dt>Already tried</dt><dd>${tried.length ? tried.map(esc).join('<br>') : 'Nothing recorded'}</dd><dt>Why transferred</dt><dd>${esc(brief.handoff_reason || 'Customer asked for a technician')}</dd></dl>`
    : '<p class="help">No transfer brief: this conversation didn’t come through the AI assistant.</p>');

  // Suggested articles and next steps from the AI.
  const guidance = c.knowledge_matches || [], status = c.knowledge_status, articles = $('#cfArticles');
  const openArticles = new Set([...articles.querySelectorAll('details[open]')].map(item => item.dataset.kb));
  $('#cfArticlesStatus').textContent = status === 'searching' ? '● Searching…' : status === 'error' ? '✕ Search failed' : guidance.length ? 'Verify before using' : '';
  patch(articles, guidance.map(article => kbItem(article, openArticles.has(article.id))).join('')
    || `<p class="sec">${status === 'error' ? esc(c.knowledge_error || 'Knowledge search failed.') : status === 'ready' ? 'No relevant articles found. Try Knowledge search.' : 'Suggestions appear after the customer describes the issue.'}</p>`);
  const steps = [...new Set([brief?.next_step, c.next_question, c.recommended_action, ...(guidance[0]?.steps || [])].filter(Boolean).map(step => step.trim()))].slice(0, 6);
  patch($('#cfSteps'), steps.length ? `<ol class="steps-list">${steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : '<p class="sec">Next steps appear once the customer describes the issue.</p>');

  // Replies (chat and desk requests keep their existing forms).
  if (!$('#cfReply').contains(document.activeElement)) patch($('#cfReply'), `${c.origin === 'desk' && !chat && c.status === 'AI' ? '<form id="callReplyForm" class="card call-full__card stack stack--sm" novalidate><div class="field field--inline"><label for="callReplyText">Customer reply</label><textarea class="input" id="callReplyText" name="text" rows="2" required maxlength="4000"></textarea></div><div class="row"><button type="submit" class="btn btn-primary btn-sm">Send reply</button><p class="form-status" id="callReplyMessage" role="status"></p></div></form>' : ''}`);

  // Scratch pad: private notes, saved to the incident when the call ends (existing draft saving).
  if (!$('#cfPad').contains(document.activeElement)) patch($('#cfPad'), c.status === 'Connected' && canManage
    ? `<div class="field field--inline"><label for="callNoteText">Scratch pad</label><textarea class="input" id="callNoteText" data-call-id="${esc(c.id)}" rows="6" maxlength="4000" placeholder="Private notes for this call. Saved to the incident when the call ends.">${esc(calling.noteDrafts[c.id] || '')}</textarea></div>`
    : `<h2 class="dock-label">Scratch pad</h2><p class="help">${['Completed', 'Failed', 'Callback requested'].includes(c.status) ? 'Notes were saved to the incident when the call ended.' : 'Available while you’re connected to the call.'}</p>`);

  // Chats: the conversation is a chat window with a reply box (enabled once you've accepted the chat).
  if (chat) {
    const canReply = c.status === 'Connected' && own, box = $('#techReplyText');
    renderChatWindow($('#cfChat'), c.transcript, {mine: 'Technician', name: turn => turn.speaker === 'Customer' ? c.caller : turn.speaker === 'AI Agent' ? 'ResolveAI assistant' : turn.speaker === 'Technician' ? 'You' : turn.speaker,
      typing: c.customer_typing && !['Completed', 'Failed'].includes(c.status) ? c.caller : ''});
    box.disabled = !canReply; $('#techReplyForm button').disabled = !canReply;
    box.placeholder = canReply ? 'Write a reply. Enter sends, Shift+Enter adds a line.' : c.status === 'Ringing' ? 'Accept the chat to reply.' : 'This chat isn’t open for replies.';
    $('#cfChatState').textContent = c.status === 'Connected' ? '● Live' : ['Completed', 'Failed'].includes(c.status) ? 'Ended' : '';
    announceNewTurns(c, sameCall);
  }
  // Live transcription (collapsed), newest first, keeping the reader's place.
  const body = $('#cfTxBody'), oldTurns = body?.querySelector('.turns');
  if (body) {
  const atTop = !sameCall || !oldTurns || oldTurns.scrollTop < 40, fromBottom = oldTurns ? oldTurns.scrollHeight - oldTurns.scrollTop : 0;
  patch($('#cfTxState'), c.transcript.length ? (live ? '<span class="badge badge--ok">● Live</span>' : '<span class="badge badge--muted">○ Recorded</span>') : '<span class="badge badge--muted">○ Waiting for speech</span>');
  patch(body, c.transcript.length ? transcriptTurns(c.transcript.slice().reverse()) : '<p class="help">The transcript appears as people speak.</p>');
  const turnsBox = body.querySelector('.turns');
  if (turnsBox) turnsBox.scrollTop = atTop ? 0 : Math.max(0, turnsBox.scrollHeight - fromBottom);
  announceNewTurns(c, sameCall);
  }

  // Routing history: repeated connection errors are shown once with a count.
  const errorCounts = new Map(), shownErrors = new Set();
  c.events.forEach(e => { if (/failed|unavailable|interrupted/i.test(e.text)) errorCounts.set(e.text, (errorCounts.get(e.text) || 0) + 1); });
  patch($('#cfHistory'), c.events.slice().reverse().map(e => {
    const noisy = /failed|unavailable|interrupted/i.test(e.text);
    if (noisy && shownErrors.has(e.text)) return '';
    if (noisy) shownErrors.add(e.text);
    const count = noisy ? errorCounts.get(e.text) : 1;
    return `<li><time class="help">${new Date(e.at).toLocaleTimeString()}</time> ${esc(e.text)}${count > 1 ? ` <span class="help">(repeated ${count} times)</span>` : ''}</li>`;
  }).join('') || '<li class="help">No routing events recorded.</li>');

  // Bottom bar: Mute (voice), Transfer to queue, End call.
  const inRoom = calling.room && calling.roomCallId === c.id, muted = inRoom && !calling.room.localParticipant.isMicrophoneEnabled;
  patch($('#cfBar'), live && canManage ? `${inRoom ? `<button type="button" class="btn btn-soft btn-sm" data-dock-mute aria-pressed="${muted}">${muted ? 'Unmute' : 'Mute'}</button>` : ''}<button type="button" class="btn btn-soft btn-sm" data-call-action="transfer" data-call-id="${esc(c.id)}">Transfer to queue</button><button type="button" class="btn btn-danger btn-sm" data-call-action="finish" data-call-id="${esc(c.id)}">End ${chat ? 'chat' : 'call'}</button>` : '');
  $('#cfBar').hidden = !(live && canManage);
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
    $('#callAnswerStatus').textContent = call?.channel === 'chat' ? '' : '✓ Call connected.';
    if (call?.channel === 'chat') history.pushState({view: 'calls', call: id}, '', `${location.pathname}?view=calls&call=${encodeURIComponent(id)}`);
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
      const id = action.dataset.callId || calling.selected, kind = action.dataset.callAction;
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
      if (kind === 'finish' && new URLSearchParams(location.search).get('call') === id) closeCall();   // back to Calls & queue
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

// The switch flips the moment it's clicked and shows a spinner while the browser and server catch up; if that fails
// it flips back and says why. Permission, the saved setting and the LiveKit check run at the same time.
$('#micSwitch').addEventListener('click', async () => {
  const button = $('#micSwitch');
  if (calling.micBusy || button.disabled) return;
  const turnOn = button.getAttribute('aria-checked') !== 'true';
  calling.micBusy = true; button.setAttribute('aria-checked', String(turnOn)); button.setAttribute('aria-busy', 'true');
  setBadge($('#microphoneIndicator'), 'badge--muted', turnOn ? '● Turning on…' : '● Turning off…');
  try {
    if (calling.room && calling.roomCallId) {
      await calling.room.localParticipant.setMicrophoneEnabled(turnOn);
    } else if (!turnOn) {
      calling.ready = false;
      calling.user = await api('/api/technicians/me/call-settings', {method:'PATCH', body:JSON.stringify({enabled:false})});
      heartbeat();
    } else {
      const permission = ResolveAIVoice.microphonePermission().then(() => { calling.micDenied = false; });
      const setting = calling.user.calls_enabled ? null : api('/api/technicians/me/call-settings', {method:'PATCH', body:JSON.stringify({enabled:true})});
      const [, user] = await Promise.all([permission, setting, api('/api/calling/check')]);
      if (user) calling.user = user;
      calling.ready = true; calling.retryPhoneAt = 0;
      heartbeat();
    }
  } catch (error) {
    calling.ready = false;
    if (['NotAllowedError', 'SecurityError'].includes(error.name)) calling.micDenied = true;
    else showFeedback(turnOn ? `Couldn’t turn the microphone on: ${error.message}` : error.message, true);
  } finally {
    calling.micBusy = false; button.removeAttribute('aria-busy');
    if (calling.data) renderIndicators();
    button.focus(); loadCalling();
  }
});

// Technician chat replies: shown at once, sent in the background; the box stays focused for the next message.
async function sendTechnicianReply(event) {
  event.preventDefault();
  const field = $('#techReplyText'), text = field.value.trim(), id = calling.selected, status = $('#techReplyMessage');
  if (!text || field.disabled) return;
  showPendingBubble($('#cfChat'), text, 'You'); field.value = ''; techTypingAt = 0; status.textContent = '';
  try { await api(`/api/calling/${id}/reply`, {method: 'POST', body: JSON.stringify({text})}); loadCalling(); }
  catch (error) { $('#cfChat').querySelectorAll('[data-pending]').forEach(item => item.remove()); field.value = text; status.className = 'form-status err'; status.textContent = `✕ Not sent: ${error.message}`; }
  field.focus();
}
let techTypingAt = 0;
document.addEventListener('keydown', event => {
  if (event.target.id === 'techReplyText' && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#techReplyForm').requestSubmit(); }
});
document.addEventListener('input', event => {
  if (event.target.id !== 'techReplyText' || !event.target.value.trim() || Date.now() - techTypingAt < 2500) return;
  techTypingAt = Date.now();
  api(`/api/calling/${calling.selected}/typing`, {method: 'POST', body: '{}'}).catch(() => {});
});

async function submitCallingForm(event, path, messageId, transform, after) {
  event.preventDefault();
  const form = event.target, button = form.querySelector('button[type=submit]');
  const message = $(messageId);
  if (!form.checkValidity()) { const bad = [...form.elements].find(el => el.willValidate && !el.validity.valid); bad.setAttribute('aria-invalid', 'true'); message.className = 'form-status err'; const label = form.querySelector(`label[for="${bad.id}"]`)?.textContent || 'This field';
    const why = bad.validity.valueMissing ? 'is required.' : bad.validity.typeMismatch ? 'must be an email address, like name@company.com.' : bad.validity.tooShort ? `needs at least ${bad.minLength} characters.` : bad.validity.patternMismatch ? `can only use ${bad.id === 'userUsername' ? 'letters, numbers and . _ @ -' : 'the allowed characters'}.` : bad.validationMessage;
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
  if (event.target.id === 'techReplyForm') sendTechnicianReply(event);
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
$('#callSort').addEventListener('click', () => { toggleTimeSort($('#callSort'), 'Calls'); if (calling.data) renderCalling(); });
document.addEventListener('click', event => {
  const filter = event.target.closest('[data-call-filter]');
  if (!filter) return;
  calling.priority = filter.dataset.callFilter;
  document.querySelectorAll('[data-call-filter]').forEach(button => button.setAttribute('aria-pressed', String(button === filter)));
  if (calling.data) renderCalling();
});
loadCalling();
