const calling = { user: null, data: null, noteDrafts: {}, noteDraftTimers: {}, noteDraftSaves: {}, selected: null, room: null, roomCallId: null, ready: false, loading: false, notice: null, priority: 'All', micDenied: false, reconnecting: false, joining: null, answering: null };

function elapsed(at) { return at ? `${Math.max(0, Math.floor((Date.now() / 1000 - at) / 60))} min` : '—'; }
const CALL_BADGES = {Completed: ['badge--ok', '✓ Completed'], Failed: ['badge--err', '✕ Failed'], Declined: ['badge--err', '✕ Declined'], Connected: ['badge--medium', '● Connected'], 'Callback requested': ['badge--high', '◆ Callback requested'], Ringing: ['badge--high', '◆ Ringing'], Queued: ['badge--muted', '○ Waiting'], AI: ['badge--medium', '● With AI'], Triage: ['badge--medium', '● With AI'], Available: ['badge--ok', '✓ Available'], Busy: ['badge--medium', '● On a call'], Away: ['badge--muted', '○ Away'], Offline: ['badge--muted', '○ Offline']};
function callBadge(status) { const [tone, label] = CALL_BADGES[status] || ['badge--muted', `○ ${status}`]; return `<span class="badge ${tone}">${esc(label)}</span>`; }
window.callBadge = callBadge;
function setBadge(el, tone, text) { el.className = `badge ${tone}`; el.textContent = text; }
// Polling re-renders every few seconds; only touch the DOM when content changed so focus and open details survive.
function patch(el, html) { if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } }
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
    : presence !== 'Available' && !inCall ? ['badge--muted', `○ Off · ${presence}`, `Set your availability to Available to use the microphone.`]
    : calling.micDenied ? ['badge--err', '✕ Blocked', 'Allow microphone access for this site in your browser, then turn the microphone on again.']
    : inCall ? (muted ? ['badge--high', '◆ Muted', 'The customer can’t hear you. Turn the microphone on to talk.'] : ['badge--ok', '✓ On · in a call', 'Turn the microphone off to mute yourself.'])
    : !user.calls_enabled ? ['badge--muted', '○ Off', 'Turn the microphone on to take browser calls.']
    : calling.ready ? ['badge--ok', '✓ On', 'You can take browser calls. Turn the microphone off to stop.']
    : ['badge--muted', '○ Waiting for permission', 'Turn the microphone on and allow access when the browser asks.'];
  // One switch: on/off for taking browser calls, or mute/unmute while you are on a call. While a click is still
  // being applied, polling leaves the switch and its label alone so it doesn't flicker back.
  // Away or Offline: the switch is locked (shown off) until the technician is Available again. Mute still works in a call.
  const away = presence !== 'Available' && !inCall;
  const micSwitch = $('#micSwitch'), on = inCall ? !muted : !away && !!(user.calls_enabled && calling.ready);
  micSwitch.hidden = false;
  micSwitch.disabled = !voice.configured || away || (!!user.current_call_id && !inCall);
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
  const focusedCallId = new URLSearchParams(location.search).get('call');
  $('#sharedQueuePanel').hidden = !incoming.length && !focusedCallId;
  $('#answerHint').hidden = !incoming.some(call => call.origin === 'browser') || !!calling.user?.voice_ready;
  $('#sharedQueueTitle').textContent = `Calls waiting in queue${incoming.length ? ` · ${incoming.length}` : ''}`;
  patch($('#sharedQueue'), incoming.length ? incoming.map(call => `<li class="list__row"><span class="list__main"><strong>${esc(call.caller || 'Waiting customer')}</strong><span class="help">${esc(call.service)} · ${call.channel === 'chat' ? 'Chat' : call.origin === 'browser' ? 'Browser call' : 'Support request'} · ${esc(call.priority || 'P3')} · Waiting ${esc(elapsed(call.queued_at || call.created_at))}</span></span>${priorityBadge(call.priority)}<button type="button" class="btn btn-primary btn-sm" data-pickup-call="${esc(call.id)}"><span>Answer<span class="sr"> ${esc(call.channel === 'chat' ? 'chat' : 'call')} from ${esc(call.caller || 'customer')}</span></span></button></li>`).join('')
    : '<li class="list__row"><span class="sec">No other calls are waiting right now.</span></li>');
  if ($('#technicianRows')) renderUsersTable();
  $('#incomingCallBanner').hidden = !offer || focusedCallId === offer.id;
  if (offer) {
    patch($('#incomingCallBanner'), `<div class="stack stack--sm"><strong>◆ Incoming ${offer.origin === 'browser' ? 'call' : offer.channel === 'chat' ? 'chat' : 'support request'} · ${esc(offer.caller)}</strong><span class="help">${esc(offer.service)} · answer within ${Math.max(0, Math.ceil(offer.reserved_until - Date.now()/1000))} seconds</span></div><a class="btn btn-primary btn-sm" href="?view=calls&amp;call=${encodeURIComponent(offer.id)}" data-call-select="${esc(offer.id)}">View request</a>`);
  }
  // List or call page, never both, so neither gets squeezed. The address (?call=ID) decides which one shows.
  const pageCall = new URLSearchParams(location.search).get('call');
  if (pageCall) calling.selected = pageCall;
  const open = !!pageCall && calling.data.calls.some(call => call.id === pageCall);
  $('#callActivity').hidden = open; $('#callPage').hidden = !open;
  // Keep the waiting queue alongside a focused call so technicians can see other customers still waiting.
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
const ICON_MIC = '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const ICON_MIC_OFF = '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5 2.2M5 11a7 7 0 0 0 11.4 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16"/></svg>';
function callMicButton(enabled, label) {
  const speaking = !!calling.room?.localParticipant.isSpeaking && enabled;
  return `<button type="button" class="icon-btn call-mic-btn${speaking ? ' is-speaking' : ''}" data-call-mic-toggle role="switch" aria-checked="${enabled}" aria-label="${label}" title="${label}" ${$('#micSwitch').disabled ? 'disabled' : ''}>${enabled ? ICON_MIC : ICON_MIC_OFF}</button>`;
}
function renderCallOffer(offer) {
  const box = $('#callOffer'), user = calling.user;
  let call = calling.roomCallId || myLiveCall() ? null : (offer && offer.channel !== 'chat' && !dismissedOffers.has(offer.id) ? offer : null);
  if (call?.id === new URLSearchParams(location.search).get('call')) call = null;
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
  const assignedOffer = offer && offer.channel === 'chat' && !dismissedOffers.has(offer.id) ? offer : null;
  const incoming = live ? null : (assignedOffer || waiting[0]);
  const focused = new URLSearchParams(location.search).get('call');
  box.hidden = !incoming || (!!assignedOffer && focused === assignedOffer.id);
  if (live?.channel === 'chat') {
    setBadge($('#chatIndicator'), 'badge--ok', `✓ Chatting with ${live.caller}`);
    $('#chatCardText').innerHTML = `<a class="link" href="?view=calls&amp;call=${encodeURIComponent(live.id)}" data-call-select="${esc(live.id)}">Open the chat</a>`;
  } else if (incoming) {
    const name = incoming.caller || 'Customer', mine = incoming.technician_id === calling.user.id && incoming.status === 'Ringing';
    setBadge($('#chatIndicator'), 'badge--medium', `● Incoming chat · ${name}`);
    $('#chatCardText').textContent = incoming.summary && incoming.summary !== 'Understanding the customer issue' ? incoming.summary : 'A customer is waiting in chat.';
    patch(box, assignedOffer && !focused
      ? `<div class="call-controls"><button type="button" class="call-btn call-btn--answer" data-pickup-call="${esc(incoming.id)}"><span class="call-btn__icon">${ICON_CHAT}</span>Accept chat<span class="sr"> from ${esc(name)}</span></button><button type="button" class="call-btn call-btn--danger" data-reject-call="${esc(incoming.id)}" data-offered="1"><span class="call-btn__icon">${ICON_X}</span>Reject chat<span class="sr"> from ${esc(name)}</span></button></div>`
      : `<p class="help">${waiting.length} chat${waiting.length === 1 ? '' : 's'} waiting in the queue below.</p>`);
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

// ---- Compact live call bar: shown across the workspace except on this call's full page ----
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
  if (dock.dataset.callId !== call.id) {
    dock.dataset.callId = call.id;
    dock.innerHTML = `<div class="dock-head" id="dockHead"></div><div class="dock-guidance" id="dockGuidance"></div><div class="dock-scratch" id="dockScratch"></div><div class="dock-actions" id="dockActions"></div>`;
  }
  dock.hidden = false;
  const ticket = ticketNumber(call), chat = call.channel === 'chat';
  patch($('#dockHead'), `<div class="dock-title"><h2 class="dock-name">${esc(call.caller)}</h2><span class="live-chip"><i aria-hidden="true"></i>LIVE ${chat ? 'CHAT' : 'CALL'}</span></div>
    <a class="btn btn-soft btn-sm" href="?view=calls&amp;call=${encodeURIComponent(call.id)}" data-call-select="${esc(call.id)}">Open full ${chat ? 'chat' : 'call'}</a>
    <span class="dock-meta">${esc(call.service || 'General')} · ${esc(call.id)}${ticket ? ` · ${esc(ticket)}` : ''}</span>`);
  const questions = technicianQuestions(call), action = technicianAction(call);
  patch($('#dockGuidance'), `<strong class="dock-guidance__title">Questions to ask</strong>${questions.length
    ? `<ol class="dock-question-list">${questions.map(item => `<li>${esc(item.question)}</li>`).join('')}</ol>`
    : '<p class="dock-question-empty">Listening for useful details in the conversation.</p>'}${action ? `<div class="dock-action-suggestion"><strong>Possible next step</strong><span>${esc(action.step)}</span></div>` : ''}`);
  if (!$('#dockScratch').contains(document.activeElement)) {
    const note = calling.noteDrafts[call.id] ?? call.technician_note_draft ?? '';
    patch($('#dockScratch'), `<label class="dock-scratch__label" for="dockCallNoteText">Scratch pad</label><textarea class="input dock-scratch__text" id="dockCallNoteText" data-call-id="${esc(call.id)}" maxlength="4000" rows="2" aria-label="Scratch pad" placeholder="Private notes for this ${chat ? 'chat' : 'call'}… Saved to the incident when it ends.">${esc(note)}</textarea>`);
  }
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
  $('#technicianRows').innerHTML = paginateItems(users, userPager, calling.user?.id, '#userPagination').map(t => { const customer = t.role === 'customer'; return `<tr><th scope="row"><span class="stack stack--sm"><strong>${esc(t.name)}</strong><span class="mono help">${esc(t.username)}</span>${t.email && t.email !== t.username ? `<span class="help">${esc(t.email)}</span>` : ''}</span></th><td>${t.role === 'admin' ? 'Administrator' : customer ? 'Customer' : 'Technician'}</td><td class="col-opt">${customer ? '—' : esc(t.skills.join(', '))}</td><td class="col-opt">${esc(t.languages.join(', '))}</td><td>${customer ? '—' : callBadge(t.demo_available ? 'Available' : t.status) + (t.demo_available ? '<span class="help"> · Demo</span>' : '')}</td><td class="col-opt">${customer ? '—' : t.voice_ready ? '<span class="badge badge--ok">✓ Ready</span>' : '<span class="badge badge--muted">○ Not ready</span>'}</td><td>${t.current_call_id ? `<span class="mono">${esc(t.current_call_id)}</span>` : '<span class="help">—</span>'}</td><td class="col-actions">${calling.user?.role === 'admin' && t.role === 'technician' ? `<button type="button" class="btn btn-danger btn-sm" data-delete-user="${esc(t.id)}" data-user-name="${esc(t.name)}">Delete<span class="sr"> ${esc(t.name)}</span></button>` : ''}</td></tr>`; }).join('');
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

// Full call page: transcript-and-KB follow-up questions lead. Handoff context and scratch notes stay left; searchable
// Knowledge stays right. The frame is built once per call and layout so polling doesn't clear user input.
function kbItem(article, open) {
  const steps = article.steps || [];
  return `<details class="kb-item" data-kb="${esc(article.id)}" ${open ? 'open' : ''}><summary>${esc(article.title)} <span class="help">${esc(article.id)}</span></summary>${article.excerpt || article.symptoms ? `<p class="sec">${esc(article.excerpt || article.symptoms)}</p>` : ''}${steps.length ? `<ol class="plain-steps">${steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}</details>`;
}
// One Knowledge card: the AI's suggestions for this call while the search box is empty, search results once you type.
function renderCallSearch() {
  const list = $('#cfKbList'), c = calling.pageCall; if (!list || !c) return;
  const status = $('#cfKbStatus');
  if (status) {
    const updated = c.knowledge_updated_at ? new Date(c.knowledge_updated_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
    status.textContent = c.knowledge_status === 'searching' ? 'Updating article matches from the latest conversation…'
      : c.knowledge_status === 'error' ? (c.knowledge_error || 'Could not refresh article matches. Search the knowledge base instead.')
      : updated ? `Suggested articles updated from the conversation · ${updated}`
      : 'Suggested articles update as the customer and technician share details.';
  }
  const open = new Set([...list.querySelectorAll('details[open]')].map(item => item.dataset.kb));
  const query = ($('#cfKbSearch')?.value || '').trim().toLowerCase();
  const articles = query
    ? (state.knowledge || []).filter(article => [article.id, article.title, article.product, article.symptoms, (article.tags || []).join(' '), (article.steps || []).join(' ')].join(' ').toLowerCase().includes(query))
    : (c.knowledge_matches || []);
  patch(list, articles.map(article => kbItem(article, open.has(article.id))).join('')
    || `<p class="help">${query ? 'No articles match. Try another word.' : 'Suggestions appear after the customer describes the issue. Search to find any article.'}</p>`);
}
document.addEventListener('input', event => { if (event.target.id === 'cfKbSearch') renderCallSearch(); });

// Suggest up to two missing details from current KB matches. The retrieved article also supplies a safe next step.
function technicianQuestions(call) {
  const turns = (call.transcript || []).filter(turn => ['Customer', 'Technician'].includes(turn.speaker));
  const transcript = turns.map(turn => turn.text || '').join(' ').toLowerCase();
  const customerTranscript = turns.filter(turn => turn.speaker === 'Customer').map(turn => turn.text || '').join(' ').toLowerCase();
  const articles = call.knowledge_matches || [];
  const checks = [
    {key: 'version', evidence: /\b(version|build|release)\b/i,
      known: /\b(?:version|build|release)\s*(?:number\s*)?(?:is\s*|:|=)?v?\d[\w.-]*|\b(?:forticlient|anyconnect|globalprotect|openvpn|client|application|app)\s*(?:version\s*)?v?\d+(?:\.\d+)+|\bv\d+(?:\.\d+)+/i,
      asked: /\b(which|what|tell me|share).{0,50}\b(version|build|release)\b/i,
      question: 'Which version or build of the client are you using?'},
    {key: 'error', evidence: /\b(exact error|error code|error message|capture the error)\b/i,
      known: /\b(?:error|code)\s*[:#-]?\s*[a-z]{1,8}[-_]?[0-9]{2,}\b|\b(?:error|message) (?:says|reads)\b/i,
      asked: /\b(exact error|error code|error message)\b/i,
      question: 'What is the exact error message or code you see?'},
    {key: 'device', evidence: /\b(device|operating system|platform|macos|windows|android|ios)\b/i,
      known: /\b(windows|macos|macbook|linux|android|iphone|ipad|ios|chromebook)\b/i,
      asked: /\b(which|what|tell me).{0,40}\b(device|operating system|platform)\b/i,
      question: 'What device and operating system are you using?'},
    {key: 'network', evidence: /\b(network|wi-?fi|hotspot|ethernet)\b/i,
      known: /\b(wi-?fi|hotspot|ethernet|home network|office network|mobile data)\b/i,
      asked: /\b(which|what|tell me).{0,40}\b(network|wi-?fi|hotspot)\b/i,
      question: 'Which network are you connected to, and does it happen on another network?'},
    {key: 'scope', evidence: /\b(scope|affected users|multiple users|who else|business impact)\b/i,
      known: /\b(only me|only my|other users|teammates|multiple users|everyone|whole team|affected users)\b/i,
      asked: /\b(only you|other people|who else|how many users)\b/i,
      question: 'Is this affecting only you, or are other people affected too?'},
    {key: 'start', evidence: /\b(start time|when it started|when did|recent change)\b/i,
      known: /\b(yesterday|today|last night|this morning|since \w+|started \w+|began \w+|after (?:the )?(?:update|change|restart))\b/i,
      asked: /\b(when did (?:it|this) start|what changed|before it began)\b/i,
      question: 'When did this start, and did anything change just before it began?'},
    {key: 'mfa', evidence: /\b(mfa|multi-factor|verification prompt|authentication prompt)\b/i,
      known: /\b(mfa|multi-factor|verification code|authentication prompt)\b/i,
      asked: /\b(before or after|which step|verification prompt)\b/i,
      question: 'Does the connection fail before or after the verification prompt?'},
    {key: 'certificate', evidence: /\b(certificate|cert validity|cert is valid)\b/i,
      known: /\b(certificate|cert)\b/i,
      asked: /\b(certificate|cert).{0,40}\b(expired|changed|valid)\b/i,
      question: 'Has the device certificate expired or changed recently?'},
    {key: 'attempts', evidence: /\b(retry|retest|troubleshoot|attempt|restart|reinstall|clear the cache)\b/i,
      known: /\b(i (?:already )?(?:tried|restarted|reinstalled|cleared|reset)|we (?:already )?(?:tried|restarted|reinstalled|cleared|reset)|after (?:restarting|reinstalling|clearing))\b/i,
      asked: /\bwhat have you tried|what steps have you|what happened when you (?:tried|restarted)\b/i,
      question: 'What have you already tried, and what happened?'},
  ];
  const result = [];
  for (const article of articles) {
    const guidance = `${article.title || ''} ${article.excerpt || ''} ${(article.steps || []).join(' ')}`;
    for (const check of checks) {
      if (check.evidence.test(guidance) && !check.known.test(customerTranscript) && !check.asked?.test(transcript)
          && !result.some(item => item.key === check.key)) {
        result.push({key: check.key, question: check.question, id: article.id, title: article.title});
      }
      if (result.length === 2) break;
    }
    if (result.length === 2) break;
  }
  return result;
}
function technicianAction(call) {
  const transcript = (call.transcript || []).filter(turn => ['Customer', 'Technician'].includes(turn.speaker))
    .map(turn => turn.text || '').join(' ').toLowerCase();
  const safeAction = /^(?:step\s*)?\d*[.)\s-]*(restart|reboot|refresh|reconnect|clear|check|verify|test|retry|confirm|capture|review|inspect)\b/i;
  const sensitive = /\b(password|unlock|delete|disable|credential|admin|wipe|format|install|uninstall|reset account|security setting|verification code)\b/i;
  const completionByVerb = {restart: /\b(restarted|rebooted|power.?cycled)\b/i, reboot: /\b(rebooted|restarted|power.?cycled)\b/i,
    refresh: /\b(refreshed|refresh(ed|ing) the connection)\b/i, reconnect: /\b(reconnected|connected again)\b/i,
    clear: /\b(cleared|removed from the cache)\b/i, check: /\b(checked|verified|confirmed)\b/i,
    verify: /\b(verified|checked|confirmed)\b/i, test: /\b(tested|tried|retested)\b/i,
    retry: /\b(retried|tried again)\b/i, confirm: /\b(confirmed|checked|verified)\b/i,
    capture: /\b(captured|copied|recorded)\b/i, review: /\b(reviewed|checked)\b/i, inspect: /\b(inspected|checked)\b/i};
  for (const article of call.knowledge_matches || []) {
    for (const rawStep of article.steps || []) {
      const step = rawStep.replace(/^\s*\d+[.)]\s*/, '').trim();
      const verb = step.match(safeAction)?.[1]?.toLowerCase();
      const subject = step.toLowerCase().replace(safeAction, '').replace(/[^a-z0-9 ]/g, ' ').trim();
      const subjectWords = subject.split(/\s+/).filter(word => word.length > 3 && !['this', 'that', 'with', 'from', 'your', 'then', 'before', 'after', 'user'].includes(word));
      const completedInContext = verb && completionByVerb[verb]?.test(transcript)
        && (subjectWords.length === 0 || subjectWords.some(word => transcript.includes(word)));
      if (!safeAction.test(step) || sensitive.test(step) || transcript.includes(step.toLowerCase()) || completedInContext) continue;
      return {step, id: article.id, title: article.title};
    }
  }
  return null;
}
document.addEventListener('click', event => {
  const source = event.target.closest('[data-open-kb]');
  if (source) {
    event.preventDefault();
    $('#cfKbSearch').value = '';
    renderCallSearch();
    const article = [...$('#cfKbList').querySelectorAll('details[data-kb]')].find(item => item.dataset.kb === source.dataset.openKb);
    if (article) article.open = true;
    return;
  }
});

// Finished calls arrive in the feed as summaries; their conversation and history are fetched once, when opened.
const fullCalls = {};
async function loadFullCall(id) {
  if (fullCalls[id]?.loading) return;
  fullCalls[id] = {loading: true};
  try { fullCalls[id] = await api(`/api/calling/calls/${encodeURIComponent(id)}`); }
  catch (error) { delete fullCalls[id]; showFeedback(error.message, true); return; }
  if (calling.data && calling.selected === id) renderCalling();
}
function renderCallDetail() {
  let c = calling.data?.calls.find(c => c.id === calling.selected);
  if (!c) return;
  if (c.trimmed) {
    const full = fullCalls[c.id];
    // Refetch if the summary moved on (for example the incident was linked after the call ended).
    if (!full || full.loading || full.status !== c.status || full.case_id !== c.case_id) {
      if (!full?.loading) loadFullCall(c.id);
      if (!full || full.loading) { const workspace = $('#callWorkspace'); if (workspace.dataset.callId !== c.id) { delete workspace.dataset.callId; delete workspace.dataset.layout; workspace.innerHTML = '<p class="help" role="status">● Loading the call…</p>'; } return; }
    }
    c = {...full, ...c, trimmed: false, transcript: full.transcript, events: full.events, knowledge_matches: full.knowledge_matches, handoff_brief: full.handoff_brief};
  }
  calling.pageCall = c;
  const own = c.technician_id === calling.user.id, canManage = own || calling.user.role === 'admin', chat = c.channel === 'chat';
  const ended = ['Completed', 'Failed', 'Callback requested'].includes(c.status), live = ['Connected', 'AI'].includes(c.status);
  const layout = chat && !ended ? 'chat' : 'call';
  const workspace = $('#callWorkspace'), sameCall = workspace.dataset.callId === c.id;
  // The queue's own readiness cards are only needed while this call is still ringing (to switch the microphone on).
  $('#view-calls').classList.toggle('calls--live', c.status !== 'Ringing');
  if (!sameCall || workspace.dataset.layout !== layout) {
    workspace.dataset.callId = c.id; workspace.dataset.layout = layout;
    const knowledge = size => `<section class="card cf-card ${size}" aria-labelledby="cfKbTitle"><h2 class="dock-label" id="cfKbTitle">Knowledge</h2>
        <input class="input" id="cfKbSearch" type="search" placeholder="Search articles, e.g. VPN, Outlook, printer" aria-label="Search knowledge articles" autocomplete="off"><p class="help cf-kb-hint" id="cfKbStatus" aria-live="polite"></p>
        <div id="cfKbList" aria-label="Knowledge articles"></div></section>`;
    const questions = `<section class="cf-question-panel" aria-labelledby="cfQuestionTitle"><div class="cf-question-panel__head"><h2 id="cfQuestionTitle">Questions to ask</h2><span class="cf-question-live"><i aria-hidden="true"></i>Live</span></div><p class="cf-question-panel__status" id="cfSuggestionStatus" aria-live="polite"></p><div id="cfSteps"></div></section>`;
    const summary = `<section class="cf-handoff-card" aria-labelledby="cfSummaryTitle"><div class="cf-handoff-card__head"><span class="cf-summary-icon" aria-hidden="true">↗</span><div><h2 id="cfSummaryTitle">AI Handover Brief</h2><p>What the customer and AI covered before handoff</p></div></div><div class="cf-handoff-card__body" id="cfSummary" aria-live="polite"></div></section>`;
    const pad = size => `<section class="card cf-card ${size}" id="cfPad"></section>`;
    const padSize = (c.status === 'Connected' || ended) && canManage ? 'cf-pad--main' : 'cf-pad--compact';
    workspace.innerHTML = `<header class="call-full__head" id="cfHead"></header><div class="stack" id="cfAlerts"></div>
      ${layout === 'chat'
        ? `${questions}<div class="cf-grid cf-grid--chat"><section class="card cf-card cf-chat" aria-labelledby="cfChatTitle"><div class="row row--between"><h2 class="dock-label" id="cfChatTitle">Chat with ${esc(c.caller)}</h2><span class="help cf-live" id="cfChatState"></span></div>
            <div class="chat-window" id="cfChat" tabindex="0" aria-live="polite" aria-relevant="additions" aria-label="Chat messages"></div>
            <form id="techReplyForm" class="chat-composer" novalidate><label class="sr" for="techReplyText">Reply to ${esc(c.caller)}</label><textarea class="input" id="techReplyText" name="text" rows="1" required maxlength="4000"></textarea><button type="submit" class="btn btn-primary">Send</button></form>
            <p class="form-status" id="techReplyMessage" role="status"></p><div class="cf-chat__actions" id="cfChatActions"></div></section>
            <div class="cf-col">${summary}${pad(padSize)}</div><div class="cf-col cf-col--side">${knowledge('cf-kb')}</div></div>`
        : `${questions}<div class="cf-grid cf-grid--call"><div class="cf-col">${summary}${pad(padSize)}<div class="callbar" id="cfBar"></div></div><div class="cf-col cf-col--side">${knowledge('cf-kb--tall')}</div></div>
            <div id="cfReply"></div>`}`;
    renderCallSearch();
  }
  const activeScratchpad = (c.status === 'Connected' || ended) && canManage;
  $('#cfPad').classList.toggle('cf-pad--main', activeScratchpad);
  $('#cfPad').classList.toggle('cf-pad--compact', !activeScratchpad);
  const ticket = ticketNumber(c), caseKey = c.case_id || c.live_case_id;
  patch($('#cfHead'), `<div><p class="kicker"><span class="mono">${esc(c.id)}</span></p><h2 class="call-full__title" tabindex="-1">${esc(c.caller)}</h2>
    <p class="sec">${esc(c.service || 'General')} · ${esc(c.priority || 'P3')} · ${esc(c.technician_name || 'No technician yet')}${ticket ? ` · Ticket <a class="mono" href="${window.Shell.home(state.user.role)}?ticket=${encodeURIComponent(caseKey)}" data-ticket-link="${esc(caseKey)}">${esc(ticket)}</a>` : ''}</p></div>${callBadge(c.status)}`);

  // One slim strip for the call's state, plus Accept / Decline while it's ringing.
  const strip = (title, text) => `<p class="cf-strip"><strong>${title}</strong><span class="sec">${text}</span></p>`;
  const isChat = c.channel === 'chat';
  const notice = c.status === 'Queued' ? strip('◆ Waiting for a technician.', isChat ? 'Choose Answer chat in the Chat card to join.' : 'Choose Answer in the Call card to join. Browser calls need the microphone switched on.')
    : c.status === 'Completed' && c.queued_at && !c.connected_at ? (isChat ? strip('○ This chat ended while waiting.', 'The customer left before a technician joined. The incident keeps the conversation.')
      : strip('○ This call ended while waiting.', 'Its audio room is closed and can’t be joined. Ask the customer to start another support call.'))
    : ended ? (isChat ? strip('○ This chat has ended.', 'It can’t be reopened. The incident keeps the whole conversation.')
      : strip('○ This call has ended.', 'It can’t be joined. The incident keeps everything that was said.')) : '';
  let ringing = '';
  if (c.status === 'Ringing' && own) {
    const phoneReady = c.origin !== 'browser' || calling.ready;
    ringing = `<div class="call-controls">${c.origin === 'browser' ? callMicButton(calling.ready, calling.ready ? 'Turn microphone off' : 'Turn microphone on to accept') : ''}<button type="button" class="call-btn call-btn--answer" data-call-action="accept" ${phoneReady ? '' : 'disabled aria-describedby="acceptHelp"'}><span class="call-btn__icon">${ICON_PHONE}</span>Accept</button><button type="button" class="call-btn call-btn--danger" data-call-action="decline"><span class="call-btn__icon">${ICON_X}</span>Decline</button>${phoneReady ? '' : '<p class="help" id="acceptHelp">Turn on the microphone to accept this browser call.</p>'}</div>`;
  }
  patch($('#cfAlerts'), `${c.last_error ? `<div class="alert" role="alert"><strong>✕ Call problem.</strong><span class="sec">${esc(c.last_error)}</span></div>` : ''}${notice}${ringing}`);

  // Show one narrative summary, never the raw transcript. The voice model refreshes this on each AI turn.
  const summary = c.summary && c.summary !== 'Understanding the customer issue'
    ? c.summary
    : c.handoff_brief?.issue && !c.handoff_brief.issue.startsWith('No customer issue was captured')
      ? `The customer contacted support about an issue that still needs technician investigation. ResolveAI transferred the call for further assistance.`
      : 'The customer was transferred to a technician, but the issue was not clear from the information captured before handoff.';
  patch($('#cfSummary'), `<p class="cf-handoff-narrative">${esc(summary)}</p>`);

  // Recheck unmatched KB details against both sides of the latest live transcript on every call refresh.
  renderCallSearch();
  const questions = technicianQuestions(c);
  const action = technicianAction(c);
  $('#cfSuggestionStatus').textContent = c.knowledge_status === 'searching'
    ? 'Refreshing articles from the live conversation…'
    : questions.length ? 'Based on the latest customer and technician turns' : 'Listening for details that could narrow the diagnosis';
  patch($('#cfSteps'), `${questions.length ? `<ol class="cf-question-list">${questions.map((item, index) => `<li class="cf-question-item" style="--question-order:${index}"><span class="cf-question-item__number" aria-hidden="true">${index + 1}</span><div class="cf-question-item__content"><p class="cf-question-item__text">${esc(item.question)}</p><a class="cf-question-item__source" href="#cfKbList" data-open-kb="${esc(item.id)}">${esc(item.title)}</a></div></li>`).join('')}</ol>`
    : '<p class="cf-question-empty">Listening for details that could narrow the diagnosis. New questions will appear as the conversation develops.</p>'}${action ? `<div class="cf-action-suggestion"><div><strong>Possible next step</strong><p>${esc(action.step)}</p></div><a class="cf-question-item__source" href="#cfKbList" data-open-kb="${esc(action.id)}">${esc(action.title)}</a></div>` : ''}`);

  // The pad stays editable after hangup; terminal-call edits autosave to its incident.
  const savedNotes = c.technician_notes || [];
  const savedScratch = savedNotes.find(note => note.id?.endsWith('-SCRATCH')) || savedNotes[savedNotes.length - 1];
  if (!$('#cfPad').contains(document.activeElement)) patch($('#cfPad'), (c.status === 'Connected' || ended) && canManage
    ? `<label class="dock-label" for="callNoteText">Scratch pad</label><textarea class="input cf-pad__text" id="callNoteText" data-call-id="${esc(c.id)}" maxlength="4000" aria-label="Scratch pad" placeholder="${ended ? 'Private notes for this call. Edits save to the incident automatically.' : `Private notes for this ${c.channel === 'chat' ? 'chat' : 'call'}. Saved to the incident when it ends.`}">${esc(calling.noteDrafts[c.id] ?? c.technician_note_draft ?? savedScratch?.text ?? '')}</textarea>`
    : `<h2 class="dock-label">Scratch pad</h2><p class="help">${ended ? `Notes were saved to the incident when the ${c.channel === 'chat' ? 'chat' : 'call'} ended.` : `Available while you’re connected to the ${c.channel === 'chat' ? 'chat' : 'call'}.`}</p>`);

  if (layout === 'chat') {
    // Live chat: the conversation with a reply box (enabled once you've accepted), Transfer and End inside the card.
    const canReply = c.status === 'Connected' && own, box = $('#techReplyText');
    renderChatWindow($('#cfChat'), c.transcript, {mine: 'Technician', name: turn => turn.speaker === 'Customer' ? c.caller : turn.speaker === 'AI Agent' ? 'ResolveAI assistant' : turn.speaker === 'Technician' ? 'You' : turn.speaker,
      typing: c.customer_typing ? c.caller : '', open: canReply,
      onEdit: async (turnId, text) => { const updated = await api(`/api/calling/${encodeURIComponent(c.id)}/messages/${encodeURIComponent(turnId)}`, {method: 'PATCH', body: JSON.stringify({text})}); await loadCalling(); return updated; }});
    box.disabled = !canReply; $('#techReplyForm button').disabled = !canReply;
    box.placeholder = canReply ? 'Write a reply. Enter sends, Shift+Enter adds a line.' : c.status === 'Ringing' ? 'Accept the chat to reply.' : 'This chat isn’t open for replies yet.';
    $('#cfChatState').textContent = c.status === 'Connected' ? '● Live' : '';
    patch($('#cfChatActions'), live && canManage ? `<button type="button" class="btn btn-soft btn-sm" data-call-action="transfer" data-call-id="${esc(c.id)}">Transfer to queue</button><button type="button" class="btn btn-danger btn-sm" data-call-action="finish" data-call-id="${esc(c.id)}">End chat</button>` : '');
    announceNewTurns(c, sameCall);
    return;
  }
  // Desk requests the AI is handling keep their reply form.
  if (!$('#cfReply').contains(document.activeElement)) patch($('#cfReply'), c.origin === 'desk' && !chat && c.status === 'AI' ? '<form id="callReplyForm" class="card call-full__card stack stack--sm" novalidate><div class="field field--inline"><label for="callReplyText">Customer reply</label><textarea class="input" id="callReplyText" name="text" rows="2" required maxlength="4000"></textarea></div><div class="row"><button type="submit" class="btn btn-primary btn-sm">Send reply</button><p class="form-status" id="callReplyMessage" role="status"></p></div></form>' : '');
  // Bottom bar for live calls: Mute (voice), Transfer to queue, End call.
  const inRoom = calling.room && calling.roomCallId === c.id, muted = inRoom && !calling.room.localParticipant.isMicrophoneEnabled;
  patch($('#cfBar'), live && canManage ? `${c.origin === 'browser' ? callMicButton(inRoom ? !muted : calling.ready, inRoom ? (muted ? 'Unmute microphone' : 'Mute microphone') : (calling.ready ? 'Turn microphone off' : 'Turn microphone on')) : ''}<button type="button" class="btn btn-soft btn-sm" data-call-action="transfer" data-call-id="${esc(c.id)}">Transfer to queue</button><button type="button" class="btn btn-danger btn-sm" data-call-action="finish" data-call-id="${esc(c.id)}">End ${chat ? 'chat' : 'call'}</button>` : '');
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
    room.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, speakers => {
      const speaking = speakers.includes(room.localParticipant) && room.localParticipant.isMicrophoneEnabled;
      $$('[data-call-mic-toggle]').forEach(button => button.classList.toggle('is-speaking', speaking));
    });
    room.on(LivekitClient.RoomEvent.Reconnecting, () => { calling.reconnecting = true; renderIndicators(); });
    room.on(LivekitClient.RoomEvent.Reconnected, () => { calling.reconnecting = false; renderIndicators(); });
    await api(`/api/calling/${id}/connected`, {method:'POST',body:'{}'});
    for(let i=0;i<40 && !room.localParticipant.permissions?.canPublish;i++) await new Promise(resolve=>setTimeout(resolve,50));
    if (!room.localParticipant.permissions?.canPublish) throw new Error('Microphone permission confirmation timed out. Please retry.');
    const capture = microphone ? await microphone : null;
    if (capture?.error) throw capture.error;
    if (capture?.track) await room.localParticipant.publishTrack(capture.track, {source: LivekitClient.Track.Source.Microphone});
    else await room.localParticipant.setMicrophoneEnabled(true);
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
    console.info('Call pickup duration (ms)', Math.round(performance.now() - started));
    await selectCall(id);
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
        const noun = calling.data?.calls.find(c => c.id === id)?.channel === 'chat' ? 'chat' : 'call';
        $('#callActionTitle').textContent = kind === 'transfer' ? `Transfer this ${noun}?` : `End this ${noun}?`;
        $('#callActionDescription').textContent = kind === 'transfer' ? `The ${noun} will return to the support queue for another technician.` : 'The conversation will stop for everyone.';
        $('#confirmCallAction').textContent = kind === 'transfer' ? `Transfer ${noun}` : `End ${noun}`;
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
    const remove = event.target.closest('[data-delete-user]');
    if (remove) {
      const dialog = $('#deleteUserDialog'); dialog.dataset.userId = remove.dataset.deleteUser; dialog.dataset.userName = remove.dataset.userName;
      $('#deleteUserDescription').textContent = `${remove.dataset.userName} will be signed out and can no longer log in. Their past tickets and calls stay as they are.`;
      $('#deleteUserError').hidden = true; $('#confirmDeleteUser').disabled = false;
      dialog.showModal();
    }
    if (event.target.closest('#confirmDeleteUser')) {
      const dialog = $('#deleteUserDialog'), button = $('#confirmDeleteUser');
      button.disabled = true;
      try {
        await api(`/api/users/${encodeURIComponent(dialog.dataset.userId)}`, {method: 'DELETE'});
        dialog.close(); window.toast?.(`${dialog.dataset.userName} was deleted.`);
        api("/api/users").then(users => { state.users = users; }).catch(() => {});
        await loadCalling();
      } catch (error) {
        $('#deleteUserError').textContent = `✕ ${error.message}`; $('#deleteUserError').hidden = false; button.disabled = false;
      }
    }
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
      await calling.room?.disconnect(); calling.ready = false; calling.user = null; window.Shell?.resetBack(); location.assign('/');
    }
  } catch(error) { showFeedback(error.message, true); loadCalling(); }
});

function saveCallNote(note) {
  const callId = note.dataset.callId, text = note.value;
  calling.noteDraftSaves[callId] = (calling.noteDraftSaves[callId] || Promise.resolve())
    .catch(() => {}).then(() => api(`/api/calling/${encodeURIComponent(callId)}/note-draft`, {method:'PUT', body:JSON.stringify({text})}));
  calling.noteDraftSaves[callId].catch(error => showFeedback(`Scratch pad could not be saved: ${error.message}`, true));
}
document.addEventListener('input', event => {
  const note = event.target.closest('#callNoteText, #dockCallNoteText');
  if (!note?.dataset.callId) return;
  const callId = note.dataset.callId;
  calling.noteDrafts[callId] = note.value;
  clearTimeout(calling.noteDraftTimers[callId]);
  calling.noteDraftTimers[callId] = setTimeout(() => saveCallNote(note), 350);
});
document.addEventListener('focusout', event => {
  const note = event.target.closest('#callNoteText, #dockCallNoteText');
  if (!note?.dataset.callId) return;
  clearTimeout(calling.noteDraftTimers[note.dataset.callId]);
  saveCallNote(note);
});

$('#presenceSelect').addEventListener('change', async event => {
  try { await api('/api/technicians/me/presence', {method:'PATCH',body:JSON.stringify({status:event.target.value})}); await heartbeat(); await loadCalling(); }
  catch(error) { showFeedback(error.message, true); }
});

// The switch flips the moment it's clicked and shows a spinner while the browser and server catch up; if that fails
// it flips back and says why. Permission, the saved setting and the LiveKit check run at the same time.
async function toggleMicrophone(button = $('#micSwitch')) {
  const stateButton = $('#micSwitch');
  if (calling.micBusy || stateButton.disabled) return;
  const turnOn = stateButton.getAttribute('aria-checked') !== 'true';
  calling.micBusy = true; stateButton.setAttribute('aria-checked', String(turnOn)); stateButton.setAttribute('aria-busy', 'true');
  $$('[data-call-mic-toggle]').forEach(control => { control.setAttribute('aria-checked', String(turnOn)); control.setAttribute('aria-busy', 'true'); });
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
    calling.micBusy = false; stateButton.removeAttribute('aria-busy');
    $$('[data-call-mic-toggle]').forEach(control => control.removeAttribute('aria-busy'));
    if (calling.data) renderIndicators();
    if (button?.isConnected && !button.hidden) button.focus();
    loadCalling();
  }
}
$('#micSwitch').addEventListener('click', event => toggleMicrophone(event.currentTarget));
document.addEventListener('click', event => {
  const control = event.target.closest('[data-call-mic-toggle]');
  if (control) toggleMicrophone(control);
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

// Refresh the calls feed: see the timings below.
let callTick = 0;
setInterval(() => {
  if (!calling.user || calling.user.role === 'customer') return;
  const selected = calling.data?.calls.find(call => call.id === calling.selected);
  const live = calling.user.current_call_id || ['AI', 'Ringing', 'Queued', 'Connected'].includes(selected?.status);
  // Every second during a live call, every 4 seconds on Calls & queue, every 8 seconds elsewhere (still soon enough
  // to raise new chat and call alerts) so other pages aren't competing with the queue.
  const onCalls = $('#view-calls').classList.contains('active') || $('#view-technicians').classList.contains('active');
  if (live || ++callTick % (onCalls ? 4 : 8) === 0) loadCalling();
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
