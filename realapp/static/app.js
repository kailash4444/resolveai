const state = { user: null, users: [], config: null, cases: [], knowledge: [], current: null, mediaRecorder: null, audioChunks: [], audioStream: null };
let knowledgeDraftSources = [], knowledgeGeneration;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
function priorityBadge(value) {
  const tones = {P1:['▲','Critical · P1','badge--critical'],P2:['◆','High · P2','badge--high'],P3:['●','Medium · P3','badge--medium'],P4:['○','Low · P4','badge--low']};
  const [icon,label,tone] = tones[value] || ['○','Unrated','badge--low'];
  return `<span class="badge ${tone}">${icon} ${label}</span>`;
}
function stateBadge(value) {
  const states = {Resolved:['✓','badge--ok'],'In Progress':['◆','badge--high'],'On Hold':['○','badge--low'],New:['●','badge--medium'],Closed:['✓','badge--ok']};
  const [icon,tone] = states[value] || ['○','badge--low'];
  return `<span class="badge ${tone}">${icon} ${esc(value || 'Unknown')}</span>`;
}

async function api(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = isFormData ? { ...(options.headers || {}) } : { "Content-Type": "application/json", ...(options.headers || {}) };
  window.Shell?.requestStarted();
  let response;
  try { response = await fetch(path, { ...options, headers }); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error("We couldn’t reach ResolveAI. Check your connection and try again.");
  }
  finally { window.Shell?.requestFinished(); }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const detail = (await response.json()).detail; if (typeof detail === 'string') message = detail; } catch (_) {}
    if (response.status === 401 && state.user && !path.startsWith('/api/auth/')) window.Shell?.sessionExpired();
    const error = new Error(message); error.status = response.status;
    throw error;
  }
  return response.json();
}

const reportTabs = {analytics: 'tickets', qa: 'tickets'};
function selectReportTab(group, tab, load = true) {
  if (!['analytics','qa'].includes(group) || !['tickets','calls'].includes(tab)) return;
  reportTabs[group] = tab;
  $$(`[data-report="${group}"]`).forEach(button => {
    const selected = button.dataset.reportTab === tab;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    $(`#${group}-${button.dataset.reportTab}-panel`).hidden = !selected;
  });
  if (!load) return;
  if (group === 'analytics') tab === 'tickets' ? loadAnalytics() : window.loadCallAnalytics?.();
  else tab === 'tickets' ? loadQA() : window.loadCallQA?.();
}
document.addEventListener('click', event => {
  const tab = event.target.closest('[data-report]');
  if (tab) selectReportTab(tab.dataset.report, tab.dataset.reportTab);
});
document.addEventListener('keydown', event => {
  const tab = event.target.closest('[data-report]');
  if (!tab || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const target = event.key === 'Home' ? 'tickets' : event.key === 'End' ? 'calls' : tab.dataset.reportTab === 'tickets' ? 'calls' : 'tickets';
  selectReportTab(tab.dataset.report, target); $(`#${tab.dataset.report}-${target}-tab`).focus();
});
const VIEW_ACCESS = {
  customer: ['customer-home','customer-create','tickets','ticket-detail','knowledge','transcripts'],
  technician: ['overview','case','tickets','ticket-detail','calls','transcripts','analytics','knowledge','qa'],
};
VIEW_ACCESS.admin = [...VIEW_ACCESS.technician, 'technicians', 'configuration'];
const VIEW_TITLES = {signin: 'ResolveAI · Less firefighting. More resolution.', 'customer-home': 'My support', 'customer-create': 'Report an issue', overview: 'Overview', case: 'Conversation intake', tickets: 'Tickets', 'ticket-detail': 'Ticket details', calls: 'Calls & queue', transcripts: 'Transcripts', analytics: 'Analytics', knowledge: 'Knowledge', qa: 'Quality audit', technicians: 'Users', configuration: 'Configuration', denied: 'No access', notfound: 'Not found'};
function homeView(user = state.user) { return !user ? 'signin' : user.role === 'customer' ? 'customer-home' : user.role === 'technician' ? 'calls' : 'overview'; }
function showView(name) {
  if (name === 'call-analytics') {name = 'analytics'; reportTabs.analytics = 'calls';}
  if (!state.user) name = 'signin';
  else if (!$(`#view-${name}`)) name = 'notfound';
  else if (!['denied','notfound'].includes(name) && !VIEW_ACCESS[state.user.role]?.includes(name)) name = name === 'signin' ? homeView() : 'denied';
  $$(".view").forEach(el => el.classList.toggle("active", el.id === `view-${name}`));
  window.Shell?.setCurrent(name);
  if (state.user && name !== state.currentView) {
    const knowledgeLabel = state.user.role === 'customer' && name === 'knowledge' ? 'Help articles' : null;
    document.title = `${knowledgeLabel || VIEW_TITLES[name] || 'ResolveAI'} · ResolveAI`;
    if (state.currentView) $('#mainContent').focus({preventScroll: true});
  } else if (!state.user) document.title = VIEW_TITLES.signin;
  state.currentView = name;

  if (name === "customer-home") { loadCustomerCalls(); loadCustomerIncidents(); }
  if (name === "tickets") loadCases();
  if (name === "knowledge") loadKnowledge();
  if (name === "analytics") selectReportTab("analytics", reportTabs.analytics);
  if (name === "transcripts") window.loadTranscripts?.();
  if (name === "overview") loadOverview();
  if (name === "qa") selectReportTab("qa", reportTabs.qa);
  if (name === "calls" || name === "technicians") window.loadCalling?.();
}

function startNewCase() {
  if (state.user?.role === "customer") {showView("customer-create"); return;}
  state.current = null;
  $("#transcriptInput").value = "";
  $("#callerInput").value = "Customer";
  $("#channelInput").value = "Voice";
  $("#audioFile").value = "";
  $("#caseMediaFiles").value = "";
  $("#caseMediaSelection").textContent = "";
  $("#caseMediaSelection").className = "media-selection";
  $("#caseResult").hidden = true;
  $("#caseResult").innerHTML = "";
  $("#analysisMessage").className = "form-message";
  $("#analysisMessage").textContent = state.config?.configured ? `Analysis: ${state.config.model} · Transcription: ${state.config.transcription_model}` : "The administrator needs to configure the shared AI connection.";
  showView("case");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Success only. Errors stay inline, next to what failed.
function toast(message) {
  const item = document.createElement('div');
  item.className = 'toast'; item.textContent = `✓ ${message.replace(/^✓\s*/, '')}`;
  $('#toastHost').append(item); setTimeout(() => item.remove(), 5000);
}
function showFeedback(message, error = false) {
  const box = $('#globalFeedback'); if (!box) return;
  $('#globalFeedbackMessage').textContent = `${error ? '✕' : '○'} ${message}`;
  box.classList.toggle('alert--info', !error);
  box.setAttribute('role', error ? 'alert' : 'status');
  box.setAttribute('aria-live', error ? 'assertive' : 'polite');
  box.hidden = false;
}

async function loadConfig() {
  state.config = await api("/api/config");
  const configAiStatus = $('#configurationAiStatus');
  if (configAiStatus) configAiStatus.textContent = state.config.configured ? 'Configured' : state.config.runtime_key_supported === false ? 'Managed by deployment environment' : 'Not configured';
  const configAiButton = $('#configurationAiButton');
  if (configAiButton) configAiButton.hidden = state.user?.role !== 'admin' || state.config.runtime_key_supported === false;
  const ready = state.config.configured;
  const provider = state.config.provider === 'openai' ? 'OpenAI' : state.config.provider === 'mock' ? 'Test AI' : 'Gemini';
  $('#keyModalTitle').textContent = `Connect ${provider}`;
  $('#apiKeyLabel').textContent = `${provider} API key`;
  $('#analyzeButton').innerHTML = `Analyze with ${provider} <span aria-hidden="true">→</span>`;
  const status = $("#systemStatus");
  status.className = `badge ${ready ? 'badge--ok' : 'badge--high'}`;
  status.textContent = ready ? `✓ ${provider} configured` : `◆ ${provider} not configured`;
  $("#modelLabel").textContent = `Model ${state.config.model} · data ${state.config.data_backend}`;
  const connection = $("#connectionBadge");
  if (connection) { connection.className = `badge ${ready ? 'badge--ok' : 'badge--high'}`; connection.textContent = ready ? `✓ ${provider} configured` : '◆ AI provider not configured'; }
  $("#openKeyPanel").hidden = state.user?.role !== 'admin' || !state.config.runtime_key_supported;
  $("#analysisMessage").textContent = ready ? `Analysis: ${state.config.model} · Transcription: ${state.config.transcription_model}` : "The administrator needs to configure the shared AI connection.";
}

async function loadOverview() {
  if (state.user?.role === 'customer') return;
  $('#overviewLoading').hidden = false; $('#overviewError').hidden = true; $('#overviewContent').hidden = true;
  try {
    const data = await api('/api/overview');
    $('#metricTotal').textContent = data.total_cases;
    $('#metricOpen').textContent = data.open_cases;
    $('#metricAI').textContent = data.ai_handled;
    $('#metricQA').textContent = `${data.average_quality}%`;
    const rank = {P1:0,P2:1,P3:2,P4:3};
    const queue = [...data.recent_cases].filter(item => !['Resolved','Closed'].includes(item.ticket.state)).sort((a,b) => (rank[a.ticket.priority] ?? 4) - (rank[b.ticket.priority] ?? 4));
    $('#recentCases').innerHTML = queue.length ? queue.map(item => `<a class="case-row" data-ticket-link="${esc(item.id)}" href="/console?ticket=${encodeURIComponent(item.id)}"><div><strong>${esc(item.issue_title || item.ticket.short_description)}</strong><small>${esc(item.ticket.id)} · ${stateBadge(item.ticket.state)} · ${esc(item.routing.handler)} handling</small></div>${priorityBadge(item.ticket.priority)}</a>`).join('') : '<p class="empty">No open incidents right now. New work will appear here when reported.</p>';
    const maximum = Math.max(1, ...data.themes.map(item => item.count));
    $('#themeList').innerHTML = data.themes.length ? data.themes.map(item => `<div class="theme"><div class="theme-label"><span>${esc(item.name)}</span><b>${item.count}</b></div><div class="bar"><i style="width:${Math.round(item.count / maximum * 100)}%"></i></div></div>`).join('') : '<p class="empty">Themes appear after conversations are analyzed.</p>';
    $('#overviewContent').hidden = false;
  } catch (error) {
    $('#overviewErrorMessage').textContent = error.message;
    $('#overviewError').hidden = false;
  } finally { $('#overviewLoading').hidden = true; }
}
$('#retryOverview').addEventListener('click', loadOverview);

async function analyzeConversation() {
  const transcript = $("#transcriptInput").value.trim();
  const message = $("#analysisMessage");
  if (transcript.length < 20) { message.className = "form-message error"; message.textContent = "Add at least a few lines of the customer conversation."; return; }
  const mediaFiles = [...$("#caseMediaFiles").files];
  if (mediaFiles.length > 3 || mediaFiles.reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024) {
    message.className = "form-message error"; message.textContent = "Choose up to 3 images with 20 MB total size or less."; return;
  }
  const button = $("#analyzeButton"); button.disabled = true; button.textContent = "Analyzing the conversation…";
  message.className = "form-message"; message.textContent = "Retrieving knowledge and drafting a new incident. QA will run after it is resolved.";
  try {
    state.current = await api("/api/analyze", { method: "POST", body: JSON.stringify({ transcript, caller: $("#callerInput").value || "Customer", channel: $("#channelInput").value }) });
    if (mediaFiles.length) {
      const media = new FormData();
      for (const file of mediaFiles) media.append("attachments", file);
      try {
        state.current = await api(`/api/cases/${encodeURIComponent(state.current.id)}/attachments`, { method: "POST", body: media });
      } catch (error) {
        renderCase(state.current);
        message.className = "form-message error";
        message.textContent = `Incident ${state.current.ticket.id} was created, but the media upload failed: ${error.message}`;
        await loadOverview();
        return;
      }
      $("#caseMediaFiles").value = ""; $("#caseMediaSelection").textContent = "";
    }
    renderCase(state.current); message.textContent = "Analysis complete. Review and edit the ticket before using it operationally.";
    await loadOverview();
  } catch (error) { message.className = "form-message error"; message.textContent = error.message; }
  finally { button.disabled = false; button.innerHTML = "Analyze conversation <span>→</span>"; }
}

function renderCase(item) {
  const matches = item.knowledge_matches.map(match => `<div class="knowledge-hit"><span class="match-score">${Math.round(match.score * 100)}%</span><strong>${esc(match.id)} · ${esc(match.title)}</strong><p>${esc(match.excerpt)}</p></div>`).join("") || "<p class='helper'>No knowledge articles matched.</p>";
  $("#caseResult").hidden = false;
  $("#caseResult").innerHTML = `<div class="result-grid">
    <article class="result-card"><p class="eyebrow">UNDERSTANDING</p><h3>${esc(item.issue_title)}</h3><p class="helper">${esc(item.understanding.summary)}</p><div class="detail-list"><div><span>Intent</span><strong>${esc(item.understanding.intent)}</strong></div><div><span>Product</span><strong>${esc(item.understanding.product)}</strong></div><div><span>Urgency</span><strong>${esc(item.understanding.urgency)}</strong></div><div><span>Sentiment</span><strong>${esc(item.understanding.sentiment)}</strong></div></div></article>
    <article class="result-card"><p class="eyebrow">ROUTING DECISION</p><div class="route">${esc(item.routing.handler)} handling</div><p>${Math.round(item.routing.confidence * 100)}% confidence · ${esc(item.routing.risk)} risk</p><p class="helper">${esc(item.routing.rationale)}</p><hr><small>Recommended next question</small><p><strong>${esc(item.next_question)}</strong></p></article>
    <article class="result-card"><p class="eyebrow">RETRIEVED KNOWLEDGE</p><h3>Relevant guidance</h3>${matches}</article>
    <article class="result-card"><p class="eyebrow">TICKET QUALITY</p><h3><span class="route">${item.quality_score == null ? "Pending" : `${item.quality_score}%`}</span></h3><p class="helper">AI QA becomes available after the incident is resolved and checks the final ticket against the conversation.</p>${item.ticket.state === "Resolved" ? '<button class="ghost" data-open-qa>Review audit</button>' : ""}</article>
    <article class="result-card full card"><div class="panel-head"><div><p class="eyebrow">INCIDENT</p><h3>${esc(item.ticket.id)}</h3></div>${stateBadge(item.ticket.state)}</div>${renderAttachments(item.ticket.attachments)}${renderVisualAnalysis(item.ticket)}${ticketForm(item)}${followupPanels(item)}</article>
  </div>`;
  $("#caseResult").scrollIntoView({ behavior: "smooth", block: "start" });
}

function taxonomyField(label, name, current, choices) {
  const matched = choices.includes(current);
  const options = choices.map(value => `<option value="${esc(value)}" ${matched && value === current ? "selected" : ""}>${esc(value)}</option>`).join("");
  return `<label>${label}<select name="${name}" data-taxonomy-select>${options}<option value="Other" ${matched ? "" : "selected"}>Other (specify)</option></select><input class="taxonomy-custom" name="${name}_other" aria-label="Custom ${label.toLowerCase()}" placeholder="Enter a ${label.toLowerCase()}" value="${matched ? "" : esc(current)}" ${matched ? "hidden disabled" : "required"}></label>`;
}

function ticketForm(item) {
  const ticket = item.ticket;
  const states = ticket.state === "Resolved" ? ["New","In Progress","On Hold","Resolved"] : ["New","In Progress","On Hold"];
  return `<form class="ticket-form" id="ticketForm">
    <label class="wide">Short description<input name="short_description" value="${esc(ticket.short_description)}" required></label>
    <label class="wide">Description<textarea name="description" rows="4">${esc(ticket.description)}</textarea></label>
    <p class="helper wide taxonomy-help">Choose a standard value, or select <b>Other (specify)</b> to enter a custom value.</p>
    ${taxonomyField("Category", "category", ticket.category, ["Access", "Hardware", "Incident", "Network", "Security", "Software", "Workplace"])}
    ${taxonomyField("Subcategory", "subcategory", ticket.subcategory, ["Account", "Account lockout", "Application crash", "Connectivity", "Display", "Investigation", "Password reset", "Permissions", "Triage", "Unclassified"])}
    ${taxonomyField("Service", "service", ticket.service, ["Business Application", "Corporate VPN", "Enterprise IT", "General", "General IT", "Google Workspace", "Identity", "Identity and Access Management", "Microsoft 365", "Outlook", "Reporting Portal", "Windows", "Workstation Display"])}
    ${taxonomyField("Assignment group", "assignment_group", ticket.assignment_group, ["Application Support", "Endpoint Support", "Identity Service Desk", "Network Operations", "Security Operations", "Service Desk"])}
    <label class="wide">Assigned to${state.user?.role === 'admin' ? `<select name="assigned_user_id"><option value="">Unassigned</option>${state.users.filter(user=>user.role!=='customer').map(user=>`<option value="${esc(user.id)}" ${ticket.assigned_user_id===user.id?'selected':''}>${esc(user.name)} (${esc(user.username)})</option>`).join('')}</select>` : `<input value="${esc(ticket.assigned_to || '')}" readonly>`}</label>
    <label>Priority<select name="priority">${["P1","P2","P3","P4"].map(value => `<option ${value === ticket.priority ? "selected" : ""}>${value}</option>`).join("")}</select></label>
    <label>State<select name="state">${states.map(value => `<option ${value === ticket.state ? "selected" : ""}>${value}</option>`).join("")}</select></label>
    <div class="wide action-row ticket-save-row"><button class="pop" type="submit">Save ticket</button></div>
  </form>`;
}

function followupPanels(item) {
  return `<div class="ticket-followup"><div class="followup-tabs" role="tablist"><button type="button" class="followup-tab active" data-followup-tab="activity">Activity</button><button type="button" class="followup-tab" data-followup-tab="resolution">Resolution notes</button></div><div class="followup-pane" data-followup-pane="activity">${activityPanel(item)}</div><div class="followup-pane" data-followup-pane="resolution" hidden>${resolutionPanel(item)}</div></div>`;
}

function formatActivityFields(text) {
  const fields = /^(Short description|Description|Category|Subcategory|Service|Priority|Assignment group|Assigned to|State|Resolution notes|Resolution)(\s*:.*)$/i;
  return text.split('\n').map(line => { const match=line.match(fields); return match ? `<strong class="activity-field-name">${esc(match[1])}</strong>${esc(match[2])}` : esc(line); }).join('\n');
}

function activityPanel(item) {
  const enabled = item.ticket.state !== "New";
  const notes = item.ticket.work_notes.slice().sort((left, right) => new Date(right.created_at) - new Date(left.created_at)).map(note => `<div class="activity-item activity-${esc(note.author_type.toLowerCase())}"><div><strong>${esc(note.author)}</strong><span class="tag">${esc(note.author_type)}</span></div><small>${new Date(note.created_at).toLocaleString()}</small><p>${note.author_type === "System" ? formatActivityFields(note.text) : esc(note.text)}</p></div>`).join("") || `<p class="helper">No activity yet.</p>`;
  return `<section class="activity-panel"><div class="panel-head"><div><p class="eyebrow">ACTIVITY</p></div></div><div class="activity-list">${notes}</div><form id="workNoteForm" class="activity-form"><label>Comment<textarea name="text" rows="3" required ${enabled ? "" : "disabled"} placeholder="Add progress, troubleshooting details, or customer feedback"></textarea></label><div class="action-row"><span class="helper">${enabled ? "Technicians and customers can add activity while work is underway." : "Save the ticket as In Progress before adding activity."}</span><button class="ghost" type="submit" ${enabled ? "" : "disabled"}>Add activity</button></div><p class="form-message" data-activity-message></p></form></section>`;
}

function transcriptPanel(item) {
  if (!item.transcript.length) return '';
  return `<details class="incident-transcript"><summary>Call conversation · ${esc(item.ticket.call_id || 'Recorded intake')}</summary><p class="helper">Technician: ${esc(item.ticket.assigned_to || 'Not assigned')} · Customer: ${esc(item.caller)}</p><div class="live-transcript">${item.transcript.map(turn=>`<div class="transcript-turn"><b>${esc(turn.speaker)}${turn.speaker_name ? ` · ${esc(turn.speaker_name)}` : ''}</b><small>${turn.timestamp ? esc(new Date(turn.timestamp).toLocaleTimeString()) : ''}</small><p>${esc(turn.text)}</p></div>`).join('')}</div></details>`;
}

function resolutionPanel(item) {
  const resolved = item.ticket.state === "Resolved";
  return `<section class="resolution-panel"><p class="eyebrow">RESOLUTION</p><form id="resolutionForm"><label>Resolution details<textarea name="resolution" rows="8" required placeholder="Describe the fix, validation performed, and customer confirmation">${esc(item.ticket.resolution)}</textarea></label>${resolved ? "" : '<p class="helper">Submitting these notes resolves the ticket and runs AI QA automatically.</p>'}<button class="pop full" type="submit">${resolved ? "Save resolution notes" : "Resolve ticket"}</button><p class="form-message" data-resolution-message></p></form></section>`;
}

async function saveTicket(form) {
  const editingTicketDetails = $("#view-ticket-detail").classList.contains("active");
  const values = Object.fromEntries(new FormData(form).entries());
  for (const field of ["category", "subcategory", "service", "assignment_group"]) {
    const customField = `${field}_other`;
    if (values[field] === "Other") values[field] = (values[customField] || "").trim();
    delete values[customField];
  }
  if (values.state !== "Resolved") values.resolution = "";
  state.current = await api(`/api/cases/${state.current.id}/ticket`, { method: "PATCH", body: JSON.stringify(values) });
  if (editingTicketDetails) { await loadCases(); await openTicketDetails(state.current.id); }
  else renderCase(state.current);
  await loadOverview(); toast("Ticket saved.");
}

async function addWorkNote(form) {
  const editingTicketDetails = $("#view-ticket-detail").classList.contains("active");
  const values = Object.fromEntries(new FormData(form).entries());
  const message = form.querySelector("[data-activity-message]"); message.className = "form-message"; message.textContent = "Adding activity…";
  try {
    state.current = await api(`/api/cases/${state.current.id}/work-notes`, { method: "POST", body: JSON.stringify(values) });
    if (editingTicketDetails) await openTicketDetails(state.current.id); else renderCase(state.current);
    toast("Activity added.");
  } catch (error) { message.className = "form-message error"; message.textContent = error.message; }
}

async function saveResolution(form) {
  const message = form.querySelector("[data-resolution-message]");
  const resolution = new FormData(form).get("resolution").trim();
  if (!resolution) { message.className = "form-message error"; message.textContent = "Add the resolution details before resolving the ticket."; return; }
  message.className = "form-message"; message.textContent = "Resolving ticket…";
  try {
    state.current = await api(`/api/cases/${state.current.id}/ticket`, { method: "PATCH", body: JSON.stringify({ state: "Resolved", resolution }) });
    if ($("#view-ticket-detail").classList.contains("active")) { await loadCases(); await openTicketDetails(state.current.id); }
    else renderCase(state.current);
    await loadOverview(); toast("Ticket resolved.");
  } catch (error) { message.className = "form-message error"; message.textContent = error.message; }
}

async function rerunQA() {
  if (!state.current) return;
  const button = $("#rerunQa"); if (button) { button.disabled = true; button.textContent = "Auditing…"; }
  try { state.current = await api(`/api/cases/${state.current.id}/qa`, { method: "POST", body: "{}" }); renderQA(state.current); toast("AI QA audit completed."); }
  catch (error) { showFeedback(error.message, true); }
}

function visibleAuditChecks(checks) {
  const excluded = new Set(['state','status','incidentstate','ticketstate','id','if','ticketid','ticketnumber','incidentid','incidentnumber','caseid','callid','assignedto','assignee','assignedtechnician']);
  const classification = new Set(['category','subcategory','categorysubcategory','categoryandsubcategory','classification']);
  const visible = [], grouped = [];
  let legacy = false, groupIndex = -1;
  for (const check of checks) {
    const key = check.field.toLowerCase().replace(/^ticket[._]/, '').replace(/[^a-z]/g, '');
    if (excluded.has(key)) {legacy = true; continue;}
    if (classification.has(key)) {
      if (groupIndex < 0) groupIndex = visible.length;
      grouped.push(check);
      if (check.field !== 'Category / Subcategory') legacy = true;
    } else visible.push(check);
  }
  if (grouped.length) {
    const join = field => grouped.length === 1 ? grouped[0][field] : grouped.map(check => `${check.field}: ${check[field]}`).join('\n');
    visible.splice(groupIndex, 0, {field:'Category / Subcategory', result:grouped.some(check=>check.result==='FAIL')?'FAIL':grouped.some(check=>check.result==='WARN')?'WARN':'PASS', observed:join('observed'), recommended:join('recommended'), evidence:join('evidence')});
    legacy ||= grouped.length > 1;
  }
  return {checks:visible, legacy};
}

function renderQA(item) {
  if (state.user?.role !== 'admin' && item.ticket.assigned_user_id !== state.user?.id) {
    showFeedback('You can review audits for tickets assigned to you.'); showView('qa'); return;
  }
  selectReportTab("qa", "tickets", false);
  refreshBulkQA();
  state.current = item;
  $$(".view").forEach(el => el.classList.toggle("active", el.id === "view-qa"));
  $$(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.view === "qa"));
  document.title = "Quality audit";
  const heading = `<div class="qa-head"><div><div class="qa-identifiers"><span>Ticket number: <b>${esc(item.ticket.id)}</b></span><span>Call ID: <b>${esc(item.ticket.call_id || 'Not linked')}</b></span></div><h3>${esc(item.issue_title)}</h3></div><strong>${item.quality_score == null ? 'Pending' : `${item.quality_score}%`}</strong></div>`;
  if (item.ticket.state !== "Resolved") {
    $("#qaWorkspace").className = "panel card empty-list";
    $("#qaWorkspace").innerHTML = `${heading}<h3>QA pending</h3><p>Resolve ${esc(item.ticket.id)} before running AI QA. This keeps the audit focused on the completed incident record.</p>`;
    return;
  }
  if (item.quality_score == null) {
    $("#qaWorkspace").className = "panel card empty-list";
    $("#qaWorkspace").innerHTML = `${heading}<h3>QA pending</h3><p>AI QA is running in the background for ${esc(item.ticket.id)}. Return to the audit list shortly to see the completed score.</p><button class="ghost" data-view="qa">← Back to audits</button>`;
    return;
  }
  const audit = visibleAuditChecks(item.qa_checks);
  const lines = value => esc(value).replace(/\n/g, '<br>');
  const checks = audit.checks.map(check => `<div class="qa-check"><b class="${esc(check.result)}">${esc(check.result)}</b><strong>${esc(check.field)}</strong><span><b>Observed:</b> ${lines(check.observed)}<br><b>Recommended:</b> ${lines(check.recommended)}<br><small>Evidence: ${lines(check.evidence)}</small></span></div>`).join("");
  $("#qaWorkspace").className = "panel card";
  $("#qaWorkspace").innerHTML = `<button class="ghost pop--sm qa-back" data-view="qa">← Back to audits</button>${heading}${audit.legacy ? '<p class="helper">This saved score used the earlier audit format. Rerun QA to update it.</p>' : ''}<div>${checks || "No checks returned."}</div><div class="action-row"><span class="helper">The audit compares the resolved ticket with the source conversation.</span><button class="pop" id="rerunQa">Rerun AI QA</button></div>`;
}

async function loadQA() {
  const userId = state.user?.id, cases = await api('/api/reporting/tickets');
  if (state.user?.id !== userId) return;
  const resolved = cases.filter(item => item.ticket.state === "Resolved");
  state.qaResolvedCount = resolved.length;
  refreshBulkQA();
  $("#qaWorkspace").className = resolved.length ? "panel card table-wrap" : "panel card empty-list";
  $("#qaWorkspace").innerHTML = resolved.length ? `<table><thead><tr><th>Ticket</th><th>Issue</th><th>Service</th><th>Priority</th><th>QA status</th></tr></thead><tbody>${resolved.map(item => `<tr data-qa-case-id="${esc(item.id)}"><td><strong>${esc(item.ticket.id)}</strong></td><td>${esc(item.ticket.short_description)}</td><td>${esc(item.ticket.service)}</td><td>${priorityBadge(item.ticket.priority)}</td><td><span class="badge ${item.quality_score == null ? 'badge--low' : item.quality_score >= 80 ? 'badge--ok' : 'badge--high'}">${item.quality_score == null ? "○ Pending" : `${item.quality_score >= 80 ? '✓' : '◆'} ${item.quality_score}%`}</span></td></tr>`).join("")}</tbody></table>` : "No resolved tickets yet. Resolved tickets appear here immediately while AI QA runs in the background.";
}


let bulkQaTimer, lastBulkQaStatus;
async function refreshBulkQA() {
  clearTimeout(bulkQaTimer);
  if (!state.user || state.user.role === 'customer') return;
  const userId = state.user.id;
  try {
    const job = await api('/api/qa/rerun-all');
    if (state.user?.id !== userId) return;
    const running = job.status === 'running';
    $('#rerunAllQa').disabled = running || state.qaResolvedCount === 0;
    $('#rerunAllQa').textContent = running ? 'Audits running…' : 'Rerun all audits';
    $('#bulkQaStatus').textContent = job.status === 'idle' ? 'Rerun AI QA for all resolved tickets.' :
      `${running ? 'Auditing' : 'Finished'}: ${job.completed} completed, ${job.failed} failed, ${job.skipped} skipped · ${job.total} resolved tickets.${job.skipped ? ' Skipped tickets changed during the audit or are no longer resolved.' : ''}${job.failed ? ' Check the AI connection and rerun to retry.' : ''}`;
    const finished = lastBulkQaStatus === 'running' && !running;
    lastBulkQaStatus = job.status;
    if (running && $('#view-qa').classList.contains('active')) bulkQaTimer = setTimeout(refreshBulkQA, 2000);
    if (finished && $('#view-qa').classList.contains('active')) await loadQA();
  } catch (error) { $('#bulkQaStatus').textContent = error.message; $('#rerunAllQa').disabled = false; }
}
$('#rerunAllQa').addEventListener('click', async () => {
  const button = $('#rerunAllQa'); button.disabled = true;
  try {
    await api('/api/qa/rerun-all', {method:'POST', body:'{}'});
    lastBulkQaStatus = 'running';
    await refreshBulkQA();
  } catch(error) { $('#bulkQaStatus').textContent = error.message; button.disabled = false; }
});

async function loadCases() {
  const userId = state.user?.id;
  $('#ticketsLoadError').hidden = true;
  $('#ticketsLoading').hidden = false;
  try {
    const cases = await api('/api/cases');
    if (state.user?.id !== userId) return;
    state.cases = cases;
  const select = $('#ticketAssignee'), selected = select.value;
  const names = [...new Set(cases.map(item => item.ticket.assigned_to).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  select.innerHTML = '<option value="">All assigned names</option><option value="__unassigned__">Unassigned</option>' + names.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');
    select.value = [...select.options].some(option=>option.value===selected) ? selected : '';
    renderTickets();
  } catch (error) {
    $('#ticketsLoadErrorMessage').textContent = error.message;
    $('#ticketsLoadError').hidden = false;
  } finally { $('#ticketsLoading').hidden = true; }
}
$('#retryTickets').addEventListener('click', loadCases);

function renderTickets() {
  const number = $('#ticketSearch').value.trim().toLowerCase(), assignee = $('#ticketAssignee').value;
  const status = $('#ticketStateFilter').value, priority = $('#ticketPriorityFilter').value;
  document.querySelectorAll('[data-ticket-priority]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.ticketPriority === priority)));
  const cases = state.cases.filter(item => item.ticket.id.toLowerCase().includes(number) &&
    (!status || item.ticket.state === status) && (!priority || item.ticket.priority === priority) &&
    (!assignee || (assignee === '__unassigned__' ? !item.ticket.assigned_to : item.ticket.assigned_to === assignee)));
  $('#ticketResultCount').textContent = `${cases.length} of ${state.cases.length} tickets`;
  $('#ticketsEmpty').hidden = cases.length > 0;
  $('#ticketsEmpty').textContent = state.cases.length ? 'No tickets match these filters.' : 'No tickets yet.';
  $('#ticketRows').innerHTML = cases.map(item => `<tr data-case-id="${esc(item.id)}"><td><a href="${state.user?.role === 'customer' ? '/portal' : '/console'}?ticket=${encodeURIComponent(item.id)}" data-ticket-link="${esc(item.id)}">${esc(item.ticket.id)}</a></td><td>${esc(item.ticket.short_description)}</td><td>${esc(item.ticket.service)}</td><td>${priorityBadge(item.ticket.priority)}</td><td>${esc(item.ticket.assigned_to || 'Unassigned')}</td><td>${stateBadge(item.ticket.state)}</td></tr>`).join('');
}
$('#ticketSearch').addEventListener('input', renderTickets);
$('#ticketAssignee').addEventListener('change', renderTickets);
$('#ticketStateFilter').addEventListener('change', renderTickets);
$('#ticketPriorityFilter').addEventListener('change', renderTickets);
document.addEventListener('click', event => {
  const filter = event.target.closest('[data-ticket-priority]');
  if (!filter) return;
  $('#ticketPriorityFilter').value = filter.dataset.ticketPriority;
  renderTickets();
});
$('#clearTicketFilters').addEventListener('click', () => {
  ['ticketSearch','ticketAssignee','ticketStateFilter','ticketPriorityFilter'].forEach(id => $('#'+id).value='');
  renderTickets();
});

async function openTicketDetails(caseId) {
  if (state.user?.role === 'admin') state.users = await api('/api/users');
  state.current = await api(`/api/cases/${caseId}`);
  showView("ticket-detail");
  const detail = $("#ticketDetailPage"); detail.className = "panel card ticket-detail-panel";
  detail.innerHTML = `<div class="panel-head"><div><p class="eyebrow">INCIDENT</p><h2>${esc(state.current.ticket.id)}</h2><p class="helper">${state.user?.role === "customer" ? "Track progress and add comments." : "Edit the incident fields and save your changes."}</p></div>${stateBadge(state.current.ticket.state)}</div>${state.user?.role === "customer" ? customerTicketDetails(state.current) : renderAttachments(state.current.ticket.attachments) + renderVisualAnalysis(state.current.ticket) + ticketForm(state.current) + followupPanels(state.current)}${transcriptPanel(state.current)}`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function openCase(caseId, target = "case") {
  state.current = await api(`/api/cases/${caseId}`);
  if (target === "qa") renderQA(state.current); else { showView("case"); renderCase(state.current); }
}

async function loadKnowledge() {
  state.knowledge = await api("/api/knowledge"); $("#knowledgeCount").textContent = state.knowledge.length;
  renderKnowledge($("#knowledgeSearch")?.value || "");
}

function groupedCounts(values) {
  return values.reduce((counts, value) => { const key = value || "Unspecified"; counts[key] = (counts[key] || 0) + 1; return counts; }, {});
}

function renderAnalyticsBars(target, counts, total) {
  const entries = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  $(target).className = entries.length ? "analytics-bars" : "empty-list";
  $(target).innerHTML = entries.length ? entries.map(([label, count]) => `<div class="analytics-bar"><div><span>${esc(label)}</span><b>${count}</b></div><div class="bar"><i style="width:${Math.round(count / Math.max(1, total) * 100)}%"></i></div></div>`).join("") : "No incident data yet.";
}

function analyticsOptions(selector, values, label) {
  const select=$(selector), selected=select.value;
  select.innerHTML=`<option value="">${esc(label)}</option>`+[...new Set(values)].sort().map(value=>`<option value="${esc(value)}">${esc(value)}</option>`).join('');
  select.value=[...select.options].some(option=>option.value===selected)?selected:'';
}
let analyticsCases=[];
async function loadAnalytics() {
  const userId=state.user?.id, cases=await api('/api/reporting/tickets');
  if(state.user?.id!==userId) return;
  analyticsCases=cases;
  analyticsOptions('#ticketAnalyticsTechnicianFilter',cases.map(item=>item.ticket.assigned_to || 'Unassigned'),'All technicians');
  analyticsOptions('#ticketAnalyticsServiceFilter',cases.map(item=>item.ticket.service || 'Unspecified'),'All services');
  renderTicketAnalytics();
}
function renderTicketAnalytics() {
  const number=$('#ticketAnalyticsIdFilter').value.trim().toLowerCase(), technician=$('#ticketAnalyticsTechnicianFilter').value, service=$('#ticketAnalyticsServiceFilter').value;
  const cases=analyticsCases.filter(item=>(!number || item.ticket.id.toLowerCase().includes(number)) && (!technician || (item.ticket.assigned_to || 'Unassigned')===technician) && (!service || (item.ticket.service || 'Unspecified')===service));
  $('#ticketAnalyticsFilterCount').textContent=`${cases.length} of ${analyticsCases.length} tickets`;
  const resolved = cases.filter(item => item.ticket.state === "Resolved");
  const scored = resolved.map(item => item.quality_score).filter(value => value != null);
  const serviceCounts = groupedCounts(cases.map(item => item.ticket.service));
  $("#analyticsTotal").textContent = cases.length;
  $("#analyticsServices").textContent = Object.keys(serviceCounts).length;
  $("#analyticsResolved").textContent = cases.length ? `${Math.round(resolved.length / cases.length * 100)}%` : "0%";
  $("#analyticsQA").textContent = scored.length ? `${Math.round(scored.reduce((sum, value) => sum + value, 0) / scored.length)}%` : "—";
  renderAnalyticsBars("#serviceVolume", serviceCounts, cases.length);
  renderAnalyticsBars("#stateDistribution", groupedCounts(cases.map(item => item.ticket.state)), cases.length);
  renderAnalyticsBars("#priorityDistribution", groupedCounts(cases.map(item => item.ticket.priority)), cases.length);
  renderAnalyticsBars("#routingDistribution", groupedCounts(cases.map(item => `${item.routing.handler} handled`)), cases.length);
  const services = Object.keys(serviceCounts).sort((left, right) => serviceCounts[right] - serviceCounts[left]);
  $("#serviceAnalyticsEmpty").hidden = services.length > 0;
  $("#serviceAnalyticsEmpty").textContent = "No tickets match these filters.";
  $("#serviceAnalyticsRows").innerHTML = services.map(service => {
    const items = cases.filter(item => (item.ticket.service || "Unspecified") === service); const serviceResolved = items.filter(item => item.ticket.state === "Resolved"); const serviceScores = serviceResolved.map(item => item.quality_score).filter(value => value != null);
    return `<tr><td><strong>${esc(service)}</strong></td><td>${items.length}</td><td>${items.length - serviceResolved.length}</td><td>${serviceResolved.length}</td><td>${items.filter(item => item.routing.handler === "AI").length}</td><td>${serviceScores.length ? `${Math.round(serviceScores.reduce((sum, value) => sum + value, 0) / serviceScores.length)}%` : "—"}</td></tr>`;
  }).join("");
}

['Id','Technician','Service'].forEach(field=>$('#ticketAnalytics'+field+'Filter').addEventListener(field==='Id'?'input':'change',renderTicketAnalytics));
$('#ticketAnalyticsResetFilters').addEventListener('click',()=>{['Id','Technician','Service'].forEach(field=>$('#ticketAnalytics'+field+'Filter').value='');renderTicketAnalytics();});

function renderKnowledge(query = "") {
  const term = query.trim().toLowerCase();
  const articles = state.knowledge.filter(article => !term || [article.id, article.title, article.product, article.symptoms, article.tags.join(" "), article.steps.join(" ")].join(" ").toLowerCase().includes(term));
  $("#knowledgeList").innerHTML = articles.length ? articles.map(article => `<article class="article-card"><h4>${esc(article.id)} · ${esc(article.title)}</h4><p><b>${esc(article.product)}</b> · ${esc(article.tags.join(", "))}</p><p>${esc(article.symptoms)}</p><details><summary>Resolution steps</summary><ol>${article.steps.map(step => `<li>${esc(step)}</li>`).join("")}</ol><p><b>Expected outcome:</b> ${esc(article.resolution)}</p>${article.source_ticket_ids?.length ? `<p class="helper">Source incidents: ${article.source_ticket_ids.map(number => `<button type="button" class="ghost pop--sm" data-source-ticket="${esc(number)}">${esc(number)}</button>`).join(", ")}</p>` : ""}</details></article>`).join("") : `<div class="empty-list">No knowledge articles match “${esc(query)}”.</div>`;
}

async function addKnowledge(event) {
  event.preventDefault(); const form = event.target; const values = Object.fromEntries(new FormData(form).entries());
  values.steps = values.steps.split("\n").map(value => value.trim()).filter(Boolean); values.tags = values.tags.split(",").map(value => value.trim()).filter(Boolean);
  values.source_ticket_ids = knowledgeDraftSources.slice();
  const message = $("#knowledgeMessage");
  try { const article = await api("/api/knowledge", { method: "POST", body: JSON.stringify(values) }); form.reset(); message.className = "form-message"; message.textContent = `${article.id} added. It will be embedded during the next analysis.`; await loadKnowledge(); setTimeout(() => { $("#knowledgeModal").hidden = true; message.textContent = ""; }, 700); }
  catch (error) { message.className = "form-message error"; message.textContent = error.message; }
}

function openKnowledgeEditor(article, warnings = []) {
  const form = $('#knowledgeForm'); form.reset();
  knowledgeDraftSources = article?.source_ticket_ids || [];
  for (const field of ['title','product','symptoms','resolution']) form.elements[field].value = article?.[field] || '';
  form.elements.steps.value = article?.steps.join('\n') || '';
  form.elements.tags.value = article?.tags.join(', ') || '';
  $('#knowledgeModalTitle').textContent = article ? 'Review your knowledge draft' : 'Make guidance searchable';
  $('#knowledgeSources').textContent = knowledgeDraftSources.length ? `Source incidents: ${knowledgeDraftSources.join(', ')}` : '';
  $('#knowledgeSources').hidden = !knowledgeDraftSources.length;
  $('#knowledgeMessage').className = 'form-message';
  $('#knowledgeMessage').textContent = warnings.join(' ');
  $('#knowledgeModal').hidden = false;
  form.elements.title.focus();
}

async function generateIncidentKnowledge(event) {
  event.preventDefault();
  const numbers = [...new Set(event.target.elements.ticket_numbers.value.toUpperCase().split(/[\s,;]+/).filter(Boolean))];
  const message = $('#incidentKnowledgeMessage'), button = $('#generateIncidentKnowledge');
  message.className = 'form-message';
  if (!numbers.length || numbers.length > 20) {message.textContent = 'Enter between 1 and 20 incident numbers.'; return;}
  const controller = new AbortController(); knowledgeGeneration = controller;
  button.disabled = true; button.textContent = 'Generating…';
  message.textContent = 'Reading the incidents and their source conversations…';
  try {
    const result = await api('/api/knowledge/from-incidents', {method:'POST', signal:controller.signal, body:JSON.stringify({ticket_numbers:numbers})});
    if (controller.signal.aborted) return;
    $('#incidentKnowledgeModal').hidden = true;
    openKnowledgeEditor(result.article, result.warnings);
  } catch (error) {
    if (error.name !== 'AbortError') {message.className = 'form-message error'; message.textContent = error.message;}
  } finally {
    if (knowledgeGeneration === controller) {knowledgeGeneration = null; button.disabled = false; button.textContent = 'Generate draft';}
  }
}

async function openKnowledgeSource(number) {
  try {
    const cases = await api('/api/cases');
    const source = cases.find(item => item.ticket.id === number);
    if (!source) throw new Error('Source incident is no longer available.');
    await openTicketDetails(source.id);
  } catch (error) {showFeedback(error.message, true);}
}

async function saveAIKey(event) {
  event.preventDefault();
  const input = $("#aiKeyInput"); const message = $("#keyMessage");
  message.className = "form-message"; message.textContent = "Connecting…";
  try {
    await api(state.config.provider === "google_ai" ? "/api/config/gemini-key" : "/api/config/openai-key", { method: "POST", body: JSON.stringify({ api_key: input.value }) });
    input.value = ""; message.textContent = "Key protected in your local profile."; await loadConfig();
    setTimeout(() => { $("#keyModal").hidden = true; message.textContent = ""; }, 700);
  } catch (error) { message.className = "form-message error"; message.textContent = error.message; }
}

async function transcribeAudio(file) {
  if (!file) { showFeedback("Choose an audio file first."); return; }
  const form = new FormData(); form.append("file", file, file.name || "recording.webm");
  const message = $("#analysisMessage"); message.className = "form-message"; message.textContent = `Transcribing with ${state.config?.transcription_model || "the configured model"}…`;
  try {
    const result = await api("/api/transcribe", { method: "POST", body: form });
    $("#transcriptInput").value = result.text; message.textContent = `Transcription complete with ${result.model}. Review the text, add speaker labels if needed, then analyze.`;
  } catch (error) { message.className = "form-message error"; message.textContent = error.message; }
}

async function toggleRecording() {
  if (state.mediaRecorder?.state === "recording") { state.mediaRecorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { showFeedback("Audio recording is not supported by this browser. Upload a recording instead."); return; }
  try {
    state.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true }); state.audioChunks = [];
    state.mediaRecorder = new MediaRecorder(state.audioStream);
    state.mediaRecorder.ondataavailable = event => { if (event.data.size) state.audioChunks.push(event.data); };
    state.mediaRecorder.onstop = async () => {
      const type = state.mediaRecorder.mimeType || "audio/webm";
      const blob = new Blob(state.audioChunks, { type }); const file = new File([blob], "resolveai-call.webm", { type });
      state.audioStream.getTracks().forEach(track => track.stop()); state.audioStream = null; state.mediaRecorder = null;
      $("#captureButton").textContent = "● Record call"; await transcribeAudio(file);
    };
    state.mediaRecorder.start(); $("#captureButton").textContent = "■ Stop and transcribe";
  } catch (error) { showFeedback(`Microphone unavailable: ${error.message}`, true); }
}

document.addEventListener("click", event => {
  const followupTab = event.target.closest("[data-followup-tab]");
  if (followupTab) {
    const container = followupTab.closest(".ticket-followup"); const selected = followupTab.dataset.followupTab;
    container.querySelectorAll("[data-followup-tab]").forEach(button => button.classList.toggle("active", button.dataset.followupTab === selected));
    container.querySelectorAll("[data-followup-pane]").forEach(pane => pane.hidden = pane.dataset.followupPane !== selected);
  }
  const ticketLink = event.target.closest('[data-ticket-link]'); if (ticketLink) { event.preventDefault(); openTicketDetails(ticketLink.dataset.ticketLink).catch(error => showFeedback(error.message, true)); return; }
  const nav = event.target.closest("[data-view]");
  if (nav) {
    if (nav.tagName === 'A' && (event.metaKey || event.ctrlKey || event.shiftKey || event.button)) return;
    event.preventDefault();
    if (window.confirmLeave && !window.confirmLeave(() => nav.click())) return;
    if (nav.tagName === 'A') history.pushState({view: nav.dataset.view}, '', nav.getAttribute('href'));
    nav.dataset.view === "case" ? startNewCase() : showView(nav.dataset.view);
  }
  if (event.target.closest('[data-go-home]')) showView(homeView());
  if (event.target.closest('#retryConfig')) loadConfig().catch(error => { $('#systemStatus').className = 'badge badge--err'; $('#systemStatus').textContent = `✕ Check failed: ${error.message}`; });
  const customerRetry = event.target.closest('[data-customer-retry]');
  if (customerRetry) customerRetry.dataset.customerRetry === 'calls' ? loadCustomerCalls() : loadCustomerIncidents();
  if (event.target.closest("[data-open-case]")) startNewCase();
  const direct = event.target.closest("[data-view-target]"); if (direct) showView(direct.dataset.viewTarget);
  const caseRow = event.target.closest("[data-case-id]"); if (caseRow) caseRow.tagName === "TR" ? openTicketDetails(caseRow.dataset.caseId) : openCase(caseRow.dataset.caseId, "case");
  const qaRow = event.target.closest("[data-qa-case-id]"); if (qaRow) openCase(qaRow.dataset.qaCaseId, "qa");
  if (event.target.closest("[data-open-qa]") && state.current) renderQA(state.current);
  if (event.target.closest("#rerunQa")) rerunQA();
  if (event.target.closest("#openKeyPanel, #configurationAiButton")) { $("#keyModal").hidden = false; $('#aiKeyInput').focus(); }
  if (event.target.closest('#dismissGlobalFeedback')) $('#globalFeedback').hidden = true;
  if (event.target.closest("#closeKeyPanel") || event.target === $("#keyModal")) $("#keyModal").hidden = true;
  if (event.target.closest("#openKnowledgePanel")) openKnowledgeEditor();
  if (event.target.closest("#closeKnowledgePanel") || event.target === $("#knowledgeModal")) $("#knowledgeModal").hidden = true;
  if (event.target.closest('#openIncidentKnowledgePanel')) {$('#incidentKnowledgeModal').hidden=false; $('#incidentKnowledgeMessage').textContent=''; $('#incidentKnowledgeForm textarea').focus();}
  if (event.target.closest('#closeIncidentKnowledgePanel') || event.target === $('#incidentKnowledgeModal')) {$('#incidentKnowledgeModal').hidden=true; knowledgeGeneration?.abort();}
  const source = event.target.closest('[data-source-ticket]'); if (source) openKnowledgeSource(source.dataset.sourceTicket);
});
document.addEventListener("submit", event => {
  if (event.target.id === "ticketForm") { event.preventDefault(); saveTicket(event.target).catch(error => showFeedback(error.message, true)); }
  if (event.target.id === "workNoteForm") { event.preventDefault(); addWorkNote(event.target).catch(error => showFeedback(error.message, true)); }
  if (event.target.id === "resolutionForm") { event.preventDefault(); saveResolution(event.target); }
});
document.addEventListener("change", event => {
  const select = event.target.closest("[data-taxonomy-select]");
  if (!select) return;
  const custom = select.parentElement.querySelector(".taxonomy-custom");
  const isCustom = select.value === "Other";
  custom.hidden = !isCustom;
  custom.disabled = !isCustom;
  custom.required = isCustom;
});
$("#keyForm").addEventListener("submit", saveAIKey);
$("#analyzeButton").addEventListener("click", analyzeConversation);
$("#captureButton").addEventListener("click", toggleRecording);
$("#transcribeFileButton").addEventListener("click", () => transcribeAudio($("#audioFile").files[0]));
$("#caseMediaFiles").addEventListener("change", event => {
  const files = [...event.target.files];
  const status = $("#caseMediaSelection");
  const unsupported = files.some(file => !/\.(png|jpe?g|webp|gif|heic)$/i.test(file.name));
  if (unsupported || files.length > 3 || files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) {
    event.target.value = ""; status.textContent = unsupported ? "Only image files (PNG, JPEG, WebP, GIF, HEIC) are supported." : "Choose up to 3 images with 20 MB total size or less."; status.className = "media-selection form-message error"; return;
  }
  status.className = "media-selection";
  status.textContent = files.length ? files.map(file => `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`).join(" · ") : "";
});
$("#knowledgeForm").addEventListener("submit", addKnowledge);
$('#incidentKnowledgeForm').addEventListener('submit', generateIncidentKnowledge);
$("#knowledgeSearch").addEventListener("input", event => renderKnowledge(event.target.value));

window.applyAccountRole = user => {
  if (state.user?.id !== user?.id) {
    state.cases = []; state.users = []; state.current = null;
    $('#ticketRows').innerHTML = ''; $('#ticketDetailPage').innerHTML = '';
    $('#ticketSearch').value = ''; $('#ticketAssignee').innerHTML = '<option value="">All assigned names</option>';
    $('#ticketStateFilter').value = ''; $('#ticketPriorityFilter').value = '';
    analyticsCases = []; lastBulkQaStatus = null; clearTimeout(bulkQaTimer);
    ['ticketAnalytics','callAnalytics'].forEach(prefix => ['Id','Technician','Service'].forEach(field => $('#'+prefix+field+'Filter').value=''));
    $('#qaWorkspace').innerHTML = ''; $('#callQaList').innerHTML = ''; $('#callQaDetail').hidden = true;
  }
  state.user = user;
  document.body.dataset.role = user?.role || 'guest';
  const customer = user?.role === 'customer', admin = user?.role === 'admin';
  ['ticketAnalytics','callAnalytics'].forEach(prefix => {
    const select = $('#'+prefix+'TechnicianFilter');
    select.closest('label').hidden = !admin;
    if (!admin) select.value = '';
  });
  window.Shell?.render(user);
  if (!user || customer) {
    $('#presenceControl').hidden = $('#enablePhoneButton').hidden = true;
    $('#incomingCallBanner').hidden = true;
  }
  $('#openKeyPanel').hidden = !admin || state.config?.runtime_key_supported === false;
  const configAiButton = $('#configurationAiButton'); if (configAiButton) configAiButton.hidden = !admin || state.config?.runtime_key_supported === false;
  const configAiStatus = $('#configurationAiStatus'); if (configAiStatus) configAiStatus.textContent = state.config?.configured ? 'Configured' : state.config?.runtime_key_supported === false ? 'Managed by deployment environment' : 'Not configured';
  $('#openKnowledgePanel').hidden = $('#openIncidentKnowledgePanel').hidden = !user || customer;
};

function renderVisualAnalysis(ticket) {
  if (!ticket) return '';
  const va = ticket.visual_analysis;
  const mediaNote = !va ? ticket.work_notes?.find(note => /media analysis/i.test(note.text)) : null;
  if (!va && !mediaNote) return '';

  if (va) {
    const priority = (va.suggested_priority || 'P3').toUpperCase();
    return `<section class="visual-analysis-card spotlight-card">
      <div class="panel-head">
        <div>
          <p class="eyebrow">AI MULTIMODAL VISION</p>
          <h4>Extracted Image Intelligence</h4>
        </div>
        <span class="status-pill" data-tone="ai">${esc(va.analysis_source || 'AI Multimodal Vision')}</span>
      </div>
      <div class="visual-meta-tags">
        <span class="visual-meta-tag"><strong>Suggested Service:</strong> ${esc(va.suggested_service)}</span>
        <span class="visual-meta-tag"><strong>Priority:</strong> ${priorityBadge(priority)}</span>
        <span class="visual-meta-tag"><strong>Category:</strong> ${esc(va.suggested_category)} · ${esc(va.suggested_subcategory)}</span>
      </div>
      <div class="visual-detail-block">
        <h5>Visual Observations & Detected Text</h5>
        <p class="visual-text">${esc(va.visual_observations)}</p>
      </div>
      <div class="visual-detail-block">
        <h5>Technical Assessment & Root Cause</h5>
        <p class="visual-text">${esc(va.technical_diagnosis)}</p>
      </div>
      <div class="visual-detail-block recommended-action-block">
        <h5>Recommended Remediation</h5>
        <p class="visual-text">${esc(va.recommended_action)}</p>
      </div>
      <small class="helper">Automated visual extraction synthesized from submitted images. Technicians verify findings prior to resolution.</small>
    </section>`;
  }

  return `<section class="visual-analysis-card spotlight-card">
    <div class="panel-head">
      <div>
        <p class="eyebrow">AI MULTIMODAL VISION</p>
        <h4>Visual media analysis</h4>
      </div>
      <span class="status-pill" data-tone="ai">AI assisted</span>
    </div>
    <div class="visual-detail-block">
      <p class="visual-text" style="white-space:pre-wrap">${esc(mediaNote.text)}</p>
    </div>
    <small class="helper">Recommendations are for technician review. The service team confirms the cause and resolution.</small>
  </section>`;
}

function customerTicketDetails(item) {
  const state = item.ticket.state, labels = ['Received', 'Assigned', 'In progress', 'Resolved'];
  const active = state === 'Resolved' || state === 'Closed' ? 3 : state === 'In Progress' || state === 'On Hold' ? 2 : item.ticket.assigned_to ? 1 : 0;
  const timeline = `<ol class="steps customer-ticket-steps" aria-label="Incident progress">${labels.map((label,index) => `<li ${index === active ? 'aria-current="step"' : ''}><span aria-hidden="true">${index < active ? '✓' : index === active ? '●' : '○'}</span> ${label}</li>`).join('')}</ol>`;
  return `<div class="customer-ticket"><h3>${esc(item.ticket.short_description)}</h3>${timeline}<p style="white-space:pre-wrap">${esc(item.ticket.description)}</p><p><b>State:</b> ${stateBadge(state)} · <b>Service:</b> ${esc(item.ticket.service)} · <b>Assigned to:</b> ${esc(item.ticket.assigned_to || 'Awaiting assignment')}</p>${renderAttachments(item.ticket.attachments)}${renderVisualAnalysis(item.ticket)}${item.ticket.resolution ? `<h4>Resolution</h4><p>${esc(item.ticket.resolution)}</p>` : ''}</div>${activityPanel(item)}`;
}

function renderAttachments(attachments = []) {
  if (!attachments.length) return '';
  return `<section class="incident-attachments"><h4>Attachments</h4><div class="attachment-grid">${attachments.map(att => {
    const url = `/api/attachments/${encodeURIComponent(att.id)}`;
    const preview = att.content_type.startsWith('image/')
      ? `<button type="button" class="image-preview-button" data-image-preview="${url}" data-image-alt="${esc(att.filename)}" aria-label="Inspect ${esc(att.filename)} at full size"><img class="attachment-preview" src="${url}" alt="" loading="lazy"></button>`
      : att.content_type.startsWith('video/')
        ? `<video class="attachment-preview" controls preload="metadata"><source src="${url}" type="${esc(att.content_type)}">Your browser cannot play this video.</video>`
        : '';
    return `<article class="attachment-card">${preview}<a href="${url}" target="_blank" rel="noopener">${esc(att.filename)}</a><small>${(att.size_bytes / 1024 / 1024).toFixed(1)} MB</small></article>`;
  }).join('')}</div></section>`;
}

document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-image-preview]');
  if (!trigger) return;
  const dialog = $('#mediaPreviewDialog');
  $('#mediaPreviewImage').src = trigger.dataset.imagePreview;
  $('#mediaPreviewImage').alt = trigger.dataset.imageAlt || 'Incident attachment';
  $('#mediaPreviewCaption').textContent = trigger.dataset.imageAlt || '';
  dialog.showModal();
  $('#closeMediaPreview').focus();
});
$('#closeMediaPreview').addEventListener('click', () => $('#mediaPreviewDialog').close());
$('#mediaPreviewDialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });

async function loadCustomerCalls() {
  const target = $('#customerCalls');
  if (!target) return;
  target.setAttribute('aria-busy', 'true');
  try {
    const calls = await api('/api/customer/calls');
    target.innerHTML = calls.length ? calls.map(call=>`<div class="case-row"><div><strong>${esc(call.id)}</strong><small>${new Date(call.created_at*1000).toLocaleString()} · <span class="badge ${call.status === 'Completed' ? 'badge--ok' : call.status === 'Failed' ? 'badge--critical' : 'badge--medium'}">${call.status === 'Completed' ? '✓' : call.status === 'Failed' ? '✕' : '●'} ${esc(call.status)}</span></small></div>${call.case_id ? `<button class="ghost pop--sm" data-customer-ticket="${esc(call.case_id)}">View incident</button>` : ''}</div>`).join('') : '<p class="empty-list">No calls yet. Your support calls will appear here.</p>';
  } catch (error) {
    target.innerHTML = `<div class="empty-state inline-error" role="alert"><p>We couldn’t load your calls. ${esc(error.message)}</p><button class="ghost pop--sm" data-customer-retry="calls">Try again</button></div>`;
  } finally { target.removeAttribute('aria-busy'); }
}

async function loadCustomerIncidents() {
  const target = $('#customerIncidents');
  if (!target) return;
  target.setAttribute('aria-busy', 'true');
  let items;
  try { items = await api('/api/cases'); }
  catch (error) {
    target.innerHTML = `<div class="empty-state inline-error" role="alert"><p>We couldn’t load your incidents. ${esc(error.message)}</p><button class="ghost pop--sm" data-customer-retry="incidents">Try again</button></div>`;
    target.removeAttribute('aria-busy');
    return;
  }
  if (!items.length) {
    target.innerHTML = '<p class="empty-list">No incidents yet. Your submitted incidents will appear here.</p>';
    target.removeAttribute('aria-busy');
    return;
  }
  target.innerHTML = items.map(item => {
    const ticket = item.ticket;
    const state = ticket.state;
    const step = state === 'Resolved' ? 3 : state === 'In Progress' ? 2 : ticket.assigned_to ? 1 : 0;
    const labels = ['Received', 'Assigned', 'In progress', 'Resolved'];
    const stateIcon = state === 'Resolved' ? '✓' : state === 'In Progress' ? '◆' : '●';
    const badgeTone = state === 'Resolved' ? 'badge--ok' : state === 'In Progress' ? 'badge--high' : 'badge--medium';
    return `<article class="customer-incident-card spotlight-card card">
      <div class="customer-incident-heading"><div><p class="eyebrow">${esc(ticket.id)}</p>${priorityBadge(ticket.priority)}<h3>${esc(ticket.short_description)}</h3></div><span class="badge ${badgeTone}" data-status="${esc(state)}">${stateIcon} ${esc(state)}</span></div>
      <p class="helper">${esc(ticket.service)} · ${esc(ticket.assigned_to || 'Awaiting assignment')}</p>
      <ol class="incident-stepper" aria-label="Incident progress">${labels.map((label, index) => `<li class="${index < step ? 'complete' : ''} ${index === step ? 'current' : ''}"><span>${index < step ? '✓' : String(index + 1).padStart(2, '0')}</span><small>${label}</small></li>`).join('')}</ol>
      <button class="ghost pop--sm" data-customer-ticket="${esc(item.id)}">View incident details →</button>
    </article>`;
  }).join('');
  target.removeAttribute('aria-busy');
}

$('#customerIncidentForm').addEventListener('submit', async event => {
  event.preventDefault(); const form=event.target,button=form.querySelector('button'),message=$('#customerIncidentMessage');
  button.disabled=true;message.textContent='Creating your incident…';
  try {const item=await api('/api/customer/incidents',{method:'POST',body:new FormData(form)});form.reset();$('#attachmentSelection').textContent='';$('#attachmentSelection').className='media-selection';message.textContent='';await openTicketDetails(item.id);}
  catch(error){message.textContent=error.message;}finally{button.disabled=false;}
});
$('#customerIncidentForm [name="attachments"]').addEventListener('change', event => {
  const files = [...event.target.files];
  const status = $('#attachmentSelection');
  const unsupported = files.some(file => !/\.(png|jpe?g|webp|gif|heic)$/i.test(file.name));
  if (unsupported || files.length > 3 || files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) {
    event.target.value = ''; status.textContent = unsupported ? 'Only image files (PNG, JPEG, WebP, GIF, HEIC) are supported.' : 'Choose up to 3 images with 20 MB total size or less.'; status.className = 'media-selection form-message error'; return;
  }
  status.className = 'media-selection';
  status.textContent = files.length ? files.map(file => `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`).join(' · ') : '';
});
document.addEventListener('click',event=>{const source=event.target.closest('[data-customer-ticket]');if(source)openTicketDetails(source.dataset.customerTicket);});
window.loadApplication = async () => {
  try {
    const auth=await api('/api/auth/status');applyAccountRole(auth.user);
    if(!auth.user){showView('signin');await window.Auth.showPublic(auth);return;}
    if(['/login','/signup'].includes(location.pathname) && new URLSearchParams(location.search).get('next')!=='support'){history.replaceState(null,'',window.Shell.home(auth.user.role));}
    await Promise.all([loadConfig(),loadKnowledge()]);
    if(auth.user.role==='admin')state.users=await api('/api/users');
    const params=new URLSearchParams(location.search);
    if(params.get('next')==='support'){location.href='/support';return;}
    if(params.get('ticket'))return openTicketDetails(params.get('ticket'));
    if(params.get('case'))return openTicketDetails(params.get('case'));
    const path = location.pathname;
    if (path === '/portal' && auth.user.role !== 'customer') { location.replace(auth.user.role === 'admin' || auth.user.role === 'technician' ? '/console' : '/'); return; }
    if (path === '/console' && auth.user.role === 'customer') { location.replace('/portal'); return; }
    if (path === '/admin' && auth.user.role !== 'admin') { location.replace(auth.user.role === 'customer' ? '/portal' : '/console'); return; }
    document.body.dataset.entry = path;
    if (path === '/admin') $('#view-overview .overview-heading h1').textContent = 'Admin Command';
    const routeView = path === '/portal' ? 'customer-home' : path === '/console' ? 'calls' : path === '/admin' ? 'overview' : null;
    showView(params.get('view') || routeView || (auth.user.role==='customer'?'customer-home':auth.user.role==='technician'?'calls':'overview'));
  } catch(error){showFeedback(error.message, true);}
};
window.addEventListener('popstate', () => {
  if (!state.user) return;
  const view = new URLSearchParams(location.search).get('view');
  showView(view || homeView());
});
applyAccountRole(null);
window.loadApplication();
