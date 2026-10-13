/* Browser voice support: one guided flow with an explicit state for every step and failure. */
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const embedded = new URLSearchParams(location.search).has('embed');
document.body.classList.toggle('support--embedded', embedded);
document.querySelectorAll('[data-standalone]').forEach(el => { el.hidden = embedded; });

let room, session, poll, busy = false, callStatus = '', transcriptSnapshot = '', voiceState = 'checking', configured = null;

// step: 0 microphone, 1 connect, 2 talk, 3 done. show: which controls are visible.
const STATES = {
  checking: {badge: ['badge--low', '○ Checking'], title: 'Checking your browser…', step: 0},
  unsupported: {badge: ['badge--err', '✕ Browser not supported'], title: 'This browser can’t make voice calls', text: 'Use a current version of Chrome, Edge, Firefox or Safari over a secure (https) connection, or report your issue in writing.', step: 0, show: ['report']},
  unavailable: {badge: ['badge--low', '○ Voice support unavailable'], title: 'Voice calls aren’t set up yet', text: 'Your support team hasn’t connected browser calling. Report your issue in writing instead.', step: 0, show: ['report', 'retry']},
  ready: {badge: ['badge--ok', '✓ Ready'], title: 'Ready when you are', step: 0, show: ['form']},
  requesting: {badge: ['badge--medium', '● Requesting microphone'], title: 'Allow microphone access', text: 'Choose Allow when your browser asks. The microphone is only used during this call.', step: 0},
  denied: {badge: ['badge--err', '✕ Microphone blocked'], title: 'Microphone access is blocked', text: 'Allow the microphone for this site from your browser’s address bar or settings, then try again.', step: 0, show: ['retry', 'report']},
  connecting: {badge: ['badge--medium', '● Connecting'], title: 'Connecting your call…', text: 'This usually takes a few seconds.', step: 1},
  active: {badge: ['badge--ok', '● Live'], title: 'Talking with the AI assistant', text: 'Describe what you see and follow the suggested steps. Ask for a technician at any time.', step: 2, show: ['call']},
  muted: {badge: ['badge--low', '○ Muted'], title: 'You’re muted', text: 'Support can’t hear you. Select Unmute to keep talking.', step: 2, show: ['call']},
  requested: {badge: ['badge--high', '◆ Technician requested'], title: 'Finding a technician', text: 'Stay on the call. The AI assistant can keep helping while you wait.', step: 2, show: ['call']},
  connected: {badge: ['badge--ok', '✓ Technician connected'], title: 'Connected to your technician', text: 'You can now speak with your technician.', step: 2, show: ['call']},
  reconnecting: {badge: ['badge--high', '◆ Reconnecting'], title: 'Reconnecting…', text: 'Your connection dropped. Hold on while we restore the audio.', step: 2, show: ['call']},
  ended: {badge: ['badge--ok', '✓ Call ended'], title: 'Call ended', text: 'Thanks for calling. If you described an issue, you’ll find the incident on My support.', step: 4, show: ['form']},
  error: {badge: ['badge--err', '✕ Call interrupted'], title: 'The call didn’t work', step: 1, show: ['retry', 'report']},
};

function setState(name, overrides = {}) {
  voiceState = name;
  const spec = {...STATES[name], ...overrides}, show = new Set(spec.show || []);
  $('#voiceBadge').className = `badge ${spec.badge[0]}`; $('#voiceBadge').textContent = spec.badge[1];
  $('#callState').textContent = spec.title;
  $('#callExplanation').textContent = spec.text || ''; $('#callExplanation').hidden = !spec.text;
  $('#supportForm').hidden = !show.has('form');
  $('#startSupportCall').textContent = name === 'ended' ? 'Start another call' : 'Start voice call';
  $('#activeCall').hidden = !show.has('call');
  $('#retrySupport').hidden = !show.has('retry'); $('#reportInstead').hidden = !show.has('report');
  $('#supportRecovery').hidden = !show.has('retry') && !show.has('report');
  [...$('#voiceSteps').children].forEach((item, index) => {
    const label = item.textContent.replace(/^[✓●○]\s*/, '');
    const done = index < spec.step || spec.step === 4, current = index === Math.min(spec.step, 3) && spec.step !== 4;
    item.textContent = `${done ? '✓' : current ? '●' : '○'} ${label}`;
    if (current) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
  $('#askTechnician').hidden = !['active', 'muted'].includes(name) || !['Triage', 'AI', ''].includes(callStatus);
}

function updateListeningIndicator() {
  const connected = !!session && room?.state === 'connected';
  const microphoneOn = connected && room.localParticipant.isMicrophoneEnabled;
  const assistantSpeaking = connected && [...room.remoteParticipants.values()].some(p => p.identity.startsWith('agent:') && p.isSpeaking);
  $('#listeningStatus').textContent = !connected ? 'Connecting audio…' : !microphoneOn ? 'Microphone muted' : assistantSpeaking ? 'AI assistant speaking…' : ['Triage', 'AI', 'Connected'].includes(callStatus) ? 'Listening…' : 'Waiting for a technician';
  $('#muteSupportCall').textContent = microphoneOn || !connected ? 'Mute' : 'Unmute';
  $('#muteSupportCall').setAttribute('aria-pressed', String(connected && !microphoneOn));
}

async function request(path, options = {}) {
  const response = await fetch(path, {...options, headers: {'Content-Type': 'application/json', ...(session ? {'X-Support-Token': session.access_token} : {}), ...options.headers}});
  let result = {};
  try { result = await response.json(); } catch (_) {}
  if (!response.ok) {
    if (response.status === 401 && !session) { location.href = '/?next=support'; }
    throw new Error(typeof result.detail === 'string' ? result.detail : 'The call could not be started. Please try again.');
  }
  return result;
}

async function finish(state = 'ended', overrides = {}, send = true) {
  clearInterval(poll);
  const previous = session; session = null; callStatus = '';
  const previousRoom = room; room = null;
  if (previousRoom) await previousRoom.disconnect();
  if (send && previous) fetch(`/api/support/calls/${previous.call_id}/end`, {method: 'POST', headers: {'X-Support-Token': previous.access_token}, keepalive: true}).catch(() => {});
  transcriptSnapshot = '';
  $('#startSupportCall').disabled = false; $('#resumeAudioButton').hidden = true;
  setState(state, overrides);
}

function renderTranscript(turns) {
  const snapshot = JSON.stringify(turns), box = $('#supportTranscript');
  if (snapshot === transcriptSnapshot) return;
  const followTail = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
  transcriptSnapshot = snapshot;
  box.innerHTML = turns.length ? turns.map(turn => `<div class="turn"><span class="turn__who">${escapeHTML(turn.speaker)}</span><p>${escapeHTML(turn.text)}</p></div>`).join('') : '<p class="help">Your conversation appears here once transcription starts.</p>';
  if (followTail) box.scrollTop = box.scrollHeight;
}

async function refresh() {
  if (!session || busy) return;
  busy = true;
  try {
    const call = await request(`/api/support/calls/${session.call_id}`);
    callStatus = call.status;
    renderTranscript(call.transcript || []);
    if (call.status === 'Completed') return await finish('ended', {}, false);
    if (call.status === 'Callback requested') return await finish('ended', {title: 'No technician was available', text: 'Nobody could take the call right now. Please try again later, or report the issue in writing.', badge: ['badge--high', '◆ No technician available'], show: ['form', 'report']}, false);
    if (call.status === 'Failed') return await finish('error', {text: call.last_error || 'The call was interrupted. Start another call to continue.'}, false);
    if (voiceState !== 'reconnecting') {
      const muted = room && !room.localParticipant.isMicrophoneEnabled;
      if (call.status === 'Connected') setState(muted ? 'muted' : 'connected', muted ? {} : {title: `Connected to ${call.technician_name || 'your technician'}`});
      else if (['Queued', 'Ringing'].includes(call.status)) setState('requested', call.status === 'Ringing' ? {title: 'Contacting a technician', text: 'Your call is being offered to a technician. Please stay on the call.'} : {});
      else setState(muted ? 'muted' : 'active');
    }
    updateListeningIndicator();
  } catch (error) {
    setState('error', {text: error.message, show: ['call', 'retry']});
  } finally { busy = false; }
}

function supportError(error) {
  if (['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(error?.name)) return ['denied', {}];
  if (error?.name === 'NotFoundError') return ['error', {title: 'No microphone found', text: 'Connect a microphone or headset, then try again.'}];
  if (error?.name === 'NotReadableError') return ['error', {title: 'Your microphone is busy', text: 'Another app may be using it. Close that app, then try again.'}];
  return ['error', {text: error?.message || 'Something went wrong while connecting.'}];
}

$('#supportForm').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('#customerName');
  if (name.value.trim().length < 2) {
    $('#customerNameError').textContent = '✕ Enter your name (at least 2 characters).'; $('#customerNameError').hidden = false;
    name.setAttribute('aria-invalid', 'true'); name.focus(); return;
  }
  $('#customerNameError').hidden = true; name.removeAttribute('aria-invalid');
  $('#startSupportCall').disabled = true;
  try {
    setState('requesting');
    await ResolveAIVoice.microphonePermission();
    setState('connecting');
    session = await request('/api/support/calls', {method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target)))});
    room = await ResolveAIVoice.connect(session, () => { if (session) finish('error', {text: 'The voice connection ended. Start another call to continue.'}); });
    callStatus = 'Triage';
    const events = LivekitClient.RoomEvent;
    for (const name of [events.ActiveSpeakersChanged, events.TrackMuted, events.TrackUnmuted, events.ConnectionStateChanged]) room.on(name, updateListeningIndicator);
    room.on(events.Reconnecting, () => setState('reconnecting'));
    room.on(events.Reconnected, () => { voiceState = 'active'; refresh(); });
    await ResolveAIVoice.microphonePanel(room);
    setState('active'); updateListeningIndicator();
    await refresh(); poll = setInterval(refresh, 2000);
  } catch (error) {
    const [state, overrides] = supportError(error);
    await finish(state, overrides);
  }
});

$('#endSupportCall').addEventListener('click', () => $('#endCallDialog').showModal());
$('#confirmEndCall').addEventListener('click', () => { $('#endCallDialog').close(); finish('ended'); });
$('#retrySupport').addEventListener('click', async () => { if (session) { await refresh(); return; } await checkReady(); });
$('#muteSupportCall').addEventListener('click', async () => {
  if (!room) return;
  const enable = !room.localParticipant.isMicrophoneEnabled;
  try { await room.localParticipant.setMicrophoneEnabled(enable); setState(enable ? (callStatus === 'Connected' ? 'connected' : ['Queued', 'Ringing'].includes(callStatus) ? 'requested' : 'active') : 'muted'); updateListeningIndicator(); }
  catch (error) { setState('error', {text: `Couldn’t change the microphone: ${error.message}`, show: ['call', 'retry']}); }
});
$('#askTechnician').addEventListener('click', async () => {
  if (!session) return;
  const button = $('#askTechnician'); button.disabled = true; button.setAttribute('aria-busy', 'true');
  try { await request(`/api/support/calls/${session.call_id}/technician`, {method: 'POST'}); callStatus = 'Queued'; setState('requested'); await refresh(); }
  catch (error) { setState('error', {text: error.message, show: ['call', 'retry']}); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); }
});
$('#resumeAudioButton').addEventListener('click', async () => { await room?.startAudio(); $('#resumeAudioButton').hidden = true; });
window.addEventListener('pagehide', () => { if (session) fetch(`/api/support/calls/${session.call_id}/end`, {method: 'POST', headers: {'X-Support-Token': session.access_token}, keepalive: true}).catch(() => {}); });

async function checkReady() {
  setState('checking');
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) { setState('unsupported'); return; }
  if (!window.LivekitClient?.Room) { setState('error', {title: 'Calling couldn’t load', text: 'The calling component didn’t load. Refresh the page to try again.', show: ['retry', 'report']}); return; }
  try {
    const status = await request('/api/support/status');
    configured = !!status.configured;
    setState(configured ? 'ready' : 'unavailable');
  } catch (error) {
    setState('error', {title: 'Can’t reach support', text: 'We couldn’t reach the support server. Check your connection and try again.', step: 0, show: ['retry', 'report']});
  }
}

// Embedded in the portal: report height so the iframe never scrolls on its own.
if (embedded && window.parent !== window) {
  const report = () => window.parent.postMessage({type: 'resolveai-support-height', height: Math.ceil(document.documentElement.scrollHeight)}, location.origin);
  new ResizeObserver(report).observe(document.body); report();
}

request('/api/auth/status').then(auth => {
  if (!auth.user) { location.href = '/?next=support'; return; }
  $('#customerName').value = auth.user.name;
  $('#nameField').hidden = true;
  $('#callingAs').textContent = `Calling as ${auth.user.name}`; $('#callingAs').hidden = false;
}).catch(() => {});
checkReady();
