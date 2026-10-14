const calling = { user: null, data: null, knowledgeData: null, knowledgeSearch: '', noteDrafts: {}, noteDraftTimers: {}, noteDraftSaves: {}, selected: null, room: null, roomCallId: null, ready: false, auth: null, loading: false, notice: null, answering: null };

function elapsed(at) {
  if(!at)return '—';
  const days=Math.max(0,Math.floor((Date.now()/1000-at)/86400));
  return days===0?'Less than 1 day':`${days} ${days===1?'day':'days'}`;
}
function callBadge(status) { return `<span class="call-status status-${esc(status.toLowerCase().replaceAll(' ', '-'))}">${esc(status)}</span>`; }

function handoffCard(call) {
  const tried = call.attempted_steps || [];
  const next = call.recommended_action || call.next_question || 'Review the transcript and confirm the customer’s impact.';
  return `<section class="handoff-card"><p class="eyebrow">TECHNICIAN HANDOFF</p><div><strong>Issue</strong><p>${esc(call.summary || 'Customer issue is still being understood.')}</p></div><div><strong>Already tried</strong>${tried.length ? `<ul>${tried.map(step => `<li>${esc(step)}</li>`).join('')}</ul>` : '<p class="helper">No troubleshooting steps reported yet.</p>'}</div><div><strong>Suggested next step</strong><p>${esc(next)}</p></div></section>`;
}

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
  if (calling.loading || calling.answering) return;
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
    if (!calling.knowledgeData) calling.knowledgeData = await api('/api/knowledge').catch(() => []);
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
  if(calling.answering)return;
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
  $('#sharedQueue').innerHTML = (calling.data.incoming_calls || []).map(call=>`<div class="incoming-handoff"><div class="panel-head"><div><strong>${esc(call.origin === 'browser' ? 'Incoming call' : 'Support request')}</strong><small>${esc(call.service)} · ${esc(call.priority)}${call.reserved_until ? ` · ${Math.max(0, Math.ceil(call.reserved_until - Date.now()/1000))} seconds to answer` : ''}</small></div><button class="primary small" data-pickup-call="${esc(call.id)}">Answer</button></div>${handoffCard(call)}</div>`).join('');
  const users = calling.data.users || technicians;
  $('#technicianRows').innerHTML = users.map(t => `<tr><td><strong>${esc(t.name)}</strong><br><small>${esc(t.role)} · ${esc(t.username)}</small></td><td>${t.role === 'customer' ? '—' : esc(t.skills.join(', '))}</td><td>${esc(t.languages.join(', '))}</td><td>${t.role === 'customer' ? '—' : callBadge(t.status)}</td><td>${t.role === 'customer' ? '—' : t.voice_ready ? 'Connected' : 'Not connected'}</td><td>${esc(t.current_call_id || '—')}</td></tr>`).join('');
  $('#techniciansEmpty').hidden = users.length > 0;
  const offer = calling.data.calls.find(c => c.technician_id === calling.user.id && c.status === 'Ringing');
  const onCallsPage = $('#view-calls').classList.contains('active');
  $('#incomingCallBanner').hidden = !offer || onCallsPage;
  if (offer) {
    $('#incomingCallBanner').innerHTML = `<div><strong>Incoming ${offer.origin === 'browser' ? 'call' : 'support request'} · ${esc(offer.caller)}</strong><small>${esc(offer.service)} · ${Math.max(0, Math.ceil(offer.reserved_until - Date.now()/1000))} seconds to answer</small></div><button class="primary small" data-call-select="${esc(offer.id)}">View request</button>`;
    if (calling.notice !== offer.dispatch_id) { calling.notice = offer.dispatch_id; calling.selected = offer.id; toast('A support request has been assigned to you.'); }
  }
  if (calling.selected) renderCallDetail();
  renderActiveCallDock();
}

function dynamicCallSuggestion(call) {
  const customerTurns = (call.transcript || []).filter(turn => turn.speaker === 'Customer' && turn.text?.trim());
  const latest = customerTurns.at(-1)?.text || '';
  const lower = customerTurns.map(turn => turn.text).join(' ').toLowerCase();
  const article = call.knowledge_matches?.[0];
  const generic = /review (the )?customer conversation|confirm the customer.s impact/i;
  let question;
  let source = 'Based on the latest customer update';
  if (!latest) question = 'Ask the customer what they were trying to do when the problem started.';
  else if (/error|failed|failure|message|code/i.test(latest) && !/error (is|was|says)|code is|message says/i.test(latest)) question = 'Ask for the exact error message or code they see.';
  else if (!/only me|just me|only (one|a few)|everyone|whole team|multiple users|other users|all users/i.test(lower)) question = 'Ask whether this affects only them or other people too.';
  else if (article?.steps?.length) {
    const step = article.steps.find(item => item && !lower.includes(item.toLowerCase().slice(0, 32)));
    if (step) { question = `The related guide suggests: “${step}” Ask whether they have tried this and what happened.`; source = `Suggested from ${article.title}`; }
  }
  if (!question && call.next_question && !generic.test(call.next_question)) question = call.next_question;
  if (!question) question = 'Ask when the issue last worked and what changed just before it began.';
  return {question, source};
}

function renderActiveCallDock() {
  const dock = $('#activeCallDock');
  const currentId = calling.roomCallId || calling.user?.current_call_id || calling.selected;
  const call = calling.data?.calls.find(item => item.id === currentId);
  const active = call && (call.status === 'Connected' || calling.roomCallId === call.id);
  const onFullCallPage = $('#view-active-call').classList.contains('active');
  dock.hidden = !active || onFullCallPage;
  document.body.classList.toggle('has-active-call', !!active && !onFullCallPage);
  if (!active) return;
  const guidance = dynamicCallSuggestion(call);
  $('#activeCallIdentity').innerHTML = `<span class="call-status status-connected">LIVE CALL</span><strong>${esc(call.caller)}</strong><span>${esc(call.service)} · ${esc(call.id)}</span>`;
  $('#activeCallQuestion').textContent = guidance.question;
  $('#activeCallQuestionSource').textContent = guidance.source;
  const canManage = call.technician_id === calling.user?.id || calling.user?.role === 'admin';
  $('#activeDockNoteEntry').hidden = call.status !== 'Connected' || !canManage;
  $('#activeDockNoteText').dataset.callId = call.id;
  if (document.activeElement !== $('#activeDockNoteText')) $('#activeDockNoteText').value = calling.noteDrafts[call.id] || '';
  $('#activeCallOpen').dataset.openCall = call.id;
  $('#activeCallFinish').dataset.finishCall = call.id;
  $('#activeCallMute').hidden = !calling.room || calling.roomCallId !== call.id;
  if (calling.room && calling.roomCallId === call.id) $('#activeCallMute').textContent = calling.room.localParticipant.isMicrophoneEnabled ? 'Mute' : 'Unmute';
}

async function selectCall(id) {
  calling.selected = id;
  showView('active-call');
  renderActiveCallDock();
  $('#incomingCallBanner').hidden = true;
  renderCallDetail();
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function renderCallDetail() {
  if ($('#callReplyForm')?.contains(document.activeElement) || $('#callNoteText')?.contains(document.activeElement) || $('#activeCallKbSearch')?.contains(document.activeElement)) return;
  const c = calling.data?.calls.find(c => c.id === calling.selected);
  if (!c) {$('#activeCallWorkspace').innerHTML='<p class="helper">Choose an active call to open its workspace.</p>';return;}
  const openKnowledge = new Set([...document.querySelectorAll('#activeCallKnowledge details[open]')].map(item=>item.dataset.kb));
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
  const brief = c.handoff_brief;
  const customerTurns = c.transcript.filter(t => t.speaker === 'Customer' && t.text?.trim());
  const handoffBoilerplate = ['welcome to resolveai','this call is transcribed','please describe the issue','i am connecting you','i’m connecting you','i will connect you','a technician will help','please stay on the call'];
  const briefIssue = customerTurns[0]?.text || (customerTurns.length ? brief?.issue : 'No customer issue was captured before the call transferred.');
  const actualGuidance = (brief?.tried || []).filter(item => !handoffBoilerplate.some(phrase => item.toLowerCase().includes(phrase)));
  const latestCustomerUpdate = customerTurns.at(-1)?.text || brief?.outcome || '';
  const briefPanel = brief ? `<section class="handoff-brief"><div class="panel-head"><h4>Live call brief</h4><span class="tag">Updates with call</span></div><p><strong>Issue:</strong> ${esc(briefIssue)}</p>${brief.impact ? `<p><strong>Impact:</strong> ${esc(brief.impact)}</p>` : ''}${actualGuidance.length ? `<p><strong>AI guidance shared:</strong></p><ul>${actualGuidance.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}${latestCustomerUpdate ? `<p><strong>Latest customer update:</strong> ${esc(latestCustomerUpdate)}</p>` : ''}<p><strong>Why transferred:</strong> ${esc(brief.handoff_reason)}</p><p><strong>Suggested next step:</strong> ${esc(brief.next_step)}</p></section>` : '';
  const joinHint = c.status === 'Queued' ? '<p class="queue-guidance">Waiting for a technician. Choose <strong>Answer</strong> in Incoming calls to join. Browser calls require calls enabled and microphone access.</p>' : '';
  const suggestion = dynamicCallSuggestion(c);
  $('#activeCallWorkspace').innerHTML = `<div class="panel-head"><div><p class="eyebrow">${esc(c.id)}</p><h3>${esc(c.caller)}</h3></div>${callBadge(c.status)}</div>${c.status === 'Connected' && canManage ? `<section class="call-note-entry"><label for="callNoteText">Technician scratchpad</label><textarea id="callNoteText" data-call-id="${esc(c.id)}" rows="3" maxlength="4000" placeholder="Jot down a note; it will be attached to the incident when the call ends…">${esc(calling.noteDrafts[c.id] || '')}</textarea><small>Your scratchpad note will be added to the incident when you end the call.</small></section>` : ''}<p>${esc(c.summary)}</p><div class="call-context"><span>${esc(c.service)} · ${esc(c.priority)}</span><span>${esc(c.technician_name || 'Not assigned')}</span></div><p class="helper">${esc(c.reason)}</p>${c.status === 'Ringing' && !brief ? handoffCard(c) : ''}${c.last_error ? `<p class="form-message error">${esc(c.last_error)}</p>` : ''}${joinHint}${briefPanel}<section class="call-ai-suggestion"><p class="eyebrow">SUGGESTED QUESTION · UPDATES WITH THE CONVERSATION</p><p>${esc(suggestion.question)}</p><small>${esc(suggestion.source)}</small></section><div class="call-actions">${controls.join('')}</div>`;
  if (c.origin === 'desk' && c.status === 'AI') $('#activeCallWorkspace').insertAdjacentHTML('beforeend', '<form id="callReplyForm"><label>Customer reply<textarea name="text" rows="2" required maxlength="4000"></textarea></label><button class="primary small">Send reply</button><p class="form-message" id="callReplyMessage"></p></form>');
  renderCallKnowledge(c, openKnowledge);
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
    panel.innerHTML = `<h3>Incident</h3><p class="helper">${['Completed','Failed','Callback requested'].includes(call.status) ? (call.transcript.some(t=>t.speaker==='Customer') ? 'Creating the incident from the conversation…' : 'No incident created because the customer did not describe an issue.') : 'An incident will be created from the conversation when the call ends.'}</p>`;
    return;
  }
  try {
    const item = await api(`/api/cases/${call.case_id}`);
    if (calling.selected !== call.id) return;
    const t = item.ticket;
    panel.innerHTML = `<div class="panel-head"><div><p class="eyebrow">INCIDENT</p><h3>${esc(t.id)}</h3></div><button class="secondary" data-call-ticket="${esc(item.id)}">Edit incident</button></div><h4>${esc(t.short_description)}</h4><div class="call-ticket-fields">${[['State',t.state],['Priority',t.priority],['Service',t.service],['Assigned to',t.assigned_to || 'Unassigned'],['Category',t.category],['Subcategory',t.subcategory]].map(([label,value])=>`<div><span class="helper">${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div><h4>Description</h4><p class="call-ticket-description">${esc(t.description)}</p>${t.resolution ? `<h4>Resolution notes</h4><p class="call-ticket-description">${esc(t.resolution)}</p>` : ''}${t.work_notes?.length ? `<h4>Ticket comments & history</h4><div class="call-note-list">${t.work_notes.slice(-8).map(note=>`<article><strong>${esc(note.author)}</strong><small>${esc(note.author_type)}</small><p>${esc(note.text)}</p></article>`).join('')}</div>` : ''}`;
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

async function acceptBrowserCall(id, connection, microphone) {
  let room;
  try {
    room = await ResolveAIVoice.connect(connection, () => {
      if (calling.room === room) {calling.room = null;calling.roomCallId = null;}
      loadCalling();
    }, false);
    calling.room = room; calling.roomCallId = id;
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
    await room?.disconnect(); calling.room=null;calling.roomCallId=null;
    try {await api(`/api/calling/${id}/transfer`,{method:'POST',body:'{}'});} catch(_) {}
    throw error;
  }
}

async function answerCall(id) {
  if(calling.answering || calling.roomCallId)return;
  calling.answering=id;calling.selected=id;
  const started=performance.now();
  const call=[...(calling.data?.calls || []),...(calling.data?.incoming_calls || [])].find(c=>c.id===id);
  const buttons=[...document.querySelectorAll('[data-pickup-call], [data-call-action="accept"]')];
  buttons.forEach(button=>{button.dataset.idleLabel=button.textContent;button.disabled=true;button.setAttribute('aria-busy','true');button.textContent='Connecting…';});
  $('#callAnswerStatus').textContent='Connecting your call…';
  const microphone=call?.origin==='browser' ? Promise.resolve().then(()=>LivekitClient.createLocalAudioTrack({echoCancellation:true,noiseSuppression:true,autoGainControl:true})).then(track=>({track}),error=>({error})) : null;
  try {
    const result=await api(`/api/calling/${id}/accept`,{method:'POST',body:'{}'});
    if(result.token)await acceptBrowserCall(id,result,microphone);
    $('#callAnswerStatus').textContent='Call connected.';
    console.info('Call pickup duration (ms)',Math.round(performance.now()-started));
    showView('active-call');
  } catch(error) {
    $('#callAnswerStatus').textContent=`Could not connect: ${error.message}`;
    throw error;
  } finally {
    microphone?.then(capture=>{if(capture?.track && calling.roomCallId!==id)capture.track.stop();});
    calling.answering=null;
    buttons.forEach(button=>{button.disabled=false;button.removeAttribute('aria-busy');button.textContent=button.dataset.idleLabel;delete button.dataset.idleLabel;});
    await loadCalling();
  }
}

document.addEventListener('click', async event => {
  try {
    if (event.target.closest('[data-view="calls"]')) $('#incomingCallBanner').hidden = true;
    if (event.target.closest('[data-view]')) renderActiveCallDock();
    const close = event.target.closest('[data-close-call-modal]');
    if (close) $(`#${close.dataset.closeCallModal}`).hidden = true;
    if (close?.dataset.closeCallModal === 'livekitModal') $('#livekitForm [name=api_secret]').value = '';
    const select = event.target.closest('[data-call-select]');
    if (select) await selectCall(select.dataset.callSelect);
    const knowledge = event.target.closest('[data-call-knowledge]');
    if (knowledge) {
      $('#knowledgeSearch').value = `${knowledge.dataset.callKnowledge} ${knowledge.dataset.callKnowledgeTitle || ''}`.trim();
      showView('knowledge');
    }
    const ticket = event.target.closest('[data-call-ticket]');
    if (ticket) await openTicketDetails(ticket.dataset.callTicket);
    const pickup = event.target.closest('[data-pickup-call]');
    if (pickup) { await answerCall(pickup.dataset.pickupCall); }
    const action = event.target.closest('[data-call-action]');
    if (action) {
      const id = calling.selected, kind = action.dataset.callAction;
      if(kind==='accept') {await answerCall(id);return;}
      action.disabled = true;
      const comment = kind === 'finish' ? (calling.noteDrafts[id] ?? $('#callNoteText')?.value ?? '') : '';
      const result = await api(`/api/calling/${id}/${kind}`, {method:'POST',body:JSON.stringify({technician_comment:comment})});
      if (kind === 'finish') delete calling.noteDrafts[id];
      if (kind === 'accept' && result.token) await acceptBrowserCall(id, result);
      if (['decline','finish','transfer'].includes(kind) && calling.roomCallId === id) {
        const room=calling.room; calling.room=null;calling.roomCallId=null;await room?.disconnect();
      }
      await loadCalling();
    }
    if (event.target.closest('#muteCallButton') && calling.room) {await calling.room.localParticipant.setMicrophoneEnabled(!calling.room.localParticipant.isMicrophoneEnabled);renderCallDetail();}
    if (event.target.closest('#activeCallMute') && calling.room) {await calling.room.localParticipant.setMicrophoneEnabled(!calling.room.localParticipant.isMicrophoneEnabled);renderActiveCallDock();renderCallDetail();}
    const openActiveCall = event.target.closest('[data-open-call]');
    if (openActiveCall) await selectCall(openActiveCall.dataset.openCall);
    const finishActiveCall = event.target.closest('[data-finish-call]');
    if (finishActiveCall) {
      const id = finishActiveCall.dataset.finishCall;
      finishActiveCall.disabled = true;
      const comment = calling.noteDrafts[id] ?? $('#activeDockNoteText')?.value ?? '';
      await api(`/api/calling/${id}/finish`, {method:'POST',body:JSON.stringify({technician_comment:comment})});
      delete calling.noteDrafts[id];
      if (calling.roomCallId === id) { const room=calling.room;calling.room=null;calling.roomCallId=null;await room?.disconnect(); }
      await loadCalling();
    }
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
document.addEventListener('input', event => {
  const note = event.target.closest('#activeDockNoteText, #callNoteText');
  if (!note?.dataset.callId) return;
  const callId = note.dataset.callId;
  const text = note.value;
  calling.noteDrafts[callId] = text;
  clearTimeout(calling.noteDraftTimers[callId]);
  calling.noteDraftTimers[callId] = setTimeout(() => {
    calling.noteDraftSaves[callId] = (calling.noteDraftSaves[callId] || Promise.resolve())
      .catch(() => {}).then(() => api(`/api/calling/${callId}/note-draft`, {method:'PUT', body:JSON.stringify({text})}));
  }, 350);
});
$('#activeCallKbSearch').addEventListener('input', event => {
  calling.knowledgeSearch = event.target.value;
  const call = calling.data?.calls.find(item => item.id === calling.selected);
  if (call) renderCallKnowledge(call, new Set([...document.querySelectorAll('#activeCallKnowledge details[open]')].map(item => item.dataset.kb)));
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
