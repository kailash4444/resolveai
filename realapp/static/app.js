const state = { user: null, users: [], config: null, cases: [], knowledge: [], current: null, mediaRecorder: null, audioChunks: [], audioStream: null };
let knowledgeDraftSources = [], knowledgeGeneration;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));

async function api(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = isFormData ? { ...(options.headers || {}) } : { "Content-Type": "application/json", ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const detail = (await response.json()).detail;
      if (typeof detail === "string") message = detail;
      else if (Array.isArray(detail)) message = detail.map(item => {
        const field = Array.isArray(item.loc) ? item.loc.filter(part => part !== "body").join(" → ") : "";
        return [field, item.msg || "Invalid value"].filter(Boolean).join(": ");
      }).join("; ") || message;
      else if (detail && typeof detail === "object") message = detail.message || JSON.stringify(detail);
    } catch (_) {}
    throw new Error(message);
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
function showView(name) {
  if (state.user && name !== 'transcript-detail' && new URLSearchParams(location.search).has('transcript')) { const url = new URL(location.href); url.searchParams.delete('transcript'); url.searchParams.set('view', name); history.pushState({}, '', url); }
  if (name === 'call-analytics') {name = 'analytics'; reportTabs.analytics = 'calls';}
  if (!state.user) name = 'signin';
  else if (state.user.role === 'customer' && !['customer-home','customer-create','tickets','ticket-detail','knowledge','transcripts','transcript-detail'].includes(name)) name = 'customer-home';
  else if (state.user.role === 'technician' && name === 'technicians') name = 'calls';
  $$(".view").forEach(el => el.classList.toggle("active", el.id === `view-${name}`));
  $$(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.view === (name === 'transcript-detail' ? 'transcripts' : name)));
  const titles = { overview: "Operations overview", case: "New support case", tickets: "Tickets", "ticket-detail": "Ticket details", "time-machine": "Incident Time Machine", analytics: "Analytics", "resolution-radar": "Resolution Debt Radar", knowledge: "Knowledge management", qa: "Quality audit", calls: "Calls & queue", technicians: "Technicians" };
  document.title = ({"transcripts":"Transcripts","call-analytics":"Call analytics","customer-home":"My support","customer-create":"Create an incident","signin":"Welcome","technicians":"User management"})[name] || titles[name] || "ResolveAI";

  state.currentView = name;
  if (name === "customer-home") loadCustomerCalls();
  if (name === "tickets") loadCases();
  if (name === "knowledge") loadKnowledge();
  if (name === "analytics") selectReportTab("analytics", reportTabs.analytics);
  if (name === "transcripts") window.loadTranscripts?.();
  if (name === "resolution-radar") window.loadResolutionRadar?.();
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
  $("#caseResult").hidden = true;
  $("#caseResult").innerHTML = "";
  $("#analysisMessage").className = "form-message";
  $("#analysisMessage").textContent = state.config?.configured ? `Analysis: ${state.config.model} · Transcription: ${state.config.transcription_model}` : "The administrator needs to configure the shared AI connection.";
  showView("case");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toast(message) {
  const box = $("#toast"); box.textContent = message; box.hidden = false;
  setTimeout(() => box.hidden = true, 3200);
}

async function loadConfig() {
  state.config = await api("/api/config");
  const ready = state.config.configured;
  const provider = state.config.provider === 'openai' ? 'OpenAI' : state.config.provider === 'mock' ? 'Test AI' : 'Gemini';
  $('#keyModalTitle').textContent = `Connect ${provider}`;
  $('#apiKeyLabel').textContent = `${provider} API key`;
  $('#analyzeButton').innerHTML = `Analyze with ${provider} <span>→</span>`;
  $("#statusDot").classList.toggle("ready", ready);
  $("#systemStatus").textContent = ready ? `${provider} configured` : `${provider} setup required`;
  $("#modelLabel").textContent = `${state.config.model} · ${state.config.data_backend}`;
  $("#connectionBadge").textContent = ready ? `${provider} configured` : "Configuration required";
  $("#connectionBadge").classList.toggle("ready", ready);
  $("#openKeyPanel").hidden = !state.config.runtime_key_supported;
  $("#analysisMessage").textContent = ready ? `Analysis: ${state.config.model} · Transcription: ${state.config.transcription_model}` : "The administrator needs to configure the shared AI connection.";
}

async function loadOverview() {
  if (state.user?.role === "customer") return;
  const data = await api("/api/overview");
  $("#metricTotal").textContent = data.total_cases;
  $("#metricOpen").textContent = data.open_cases;
  $("#metricAI").textContent = data.ai_handled;
  $("#metricQA").textContent = `${data.average_quality}%`;
  $("#recentCases").innerHTML = data.recent_cases.length ? data.recent_cases.map(item => `<div class="case-row" data-case-id="${esc(item.id)}"><div><strong>${esc(item.issue_title)}</strong><small>${esc(item.ticket.id)} · ${esc(item.ticket.state)} · ${esc(item.routing.handler)} handling</small></div><span class="score">${item.quality_score == null ? "QA pending" : `${item.quality_score}%`}</span></div>`).join("") : "No cases yet. Start with a real support conversation.";
  const maximum = Math.max(1, ...data.themes.map(item => item.count));
  $("#themeList").innerHTML = data.themes.length ? data.themes.map(item => `<div class="theme"><div class="theme-label"><span>${esc(item.name)}</span><b>${item.count}</b></div><div class="bar"><i style="width:${Math.round(item.count / maximum * 100)}%"></i></div></div>`).join("") : "Themes appear as conversations are analyzed.";
}

async function analyzeConversation() {
  const transcript = $("#transcriptInput").value.trim();
  const message = $("#analysisMessage");
  if (transcript.length < 20) { message.className = "form-message error"; message.textContent = "Add at least a few lines of the customer conversation."; return; }
  const mediaFiles = [...$("#caseMediaFiles").files];
  if (mediaFiles.length > 10 || mediaFiles.reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024) {
    message.className = "form-message error"; message.textContent = "Choose up to 10 files with 20 MB total size or less."; return;
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
    <article class="result-card"><p class="eyebrow">TICKET QUALITY</p><h3><span class="route">${item.quality_score == null ? "Pending" : `${item.quality_score}%`}</span></h3><p class="helper">AI QA becomes available after the incident is resolved and checks the final ticket against the conversation.</p>${item.ticket.state === "Resolved" ? '<button class="secondary" data-open-qa>Review audit</button>' : ""}</article>
    <article class="result-card full"><div class="panel-head"><div><p class="eyebrow">INCIDENT</p><h3>${esc(item.ticket.id)}</h3></div><span class="tag">${esc(item.ticket.state)}</span></div>${renderAttachments(item.ticket.attachments)}${ticketForm(item)}${followupPanels(item)}</article>
  </div>`;
  $("#caseResult").scrollIntoView({ behavior: "smooth", block: "start" });
}

function ticketForm(item) {
  const ticket = item.ticket;
  const states = ticket.state === "Resolved" ? ["New","In Progress","On Hold","Resolved"] : ["New","In Progress","On Hold"];
  return `<form class="ticket-form" id="ticketForm">
    <label class="wide">Short description<input name="short_description" value="${esc(ticket.short_description)}" required></label>
    <label class="wide">Description<textarea name="description" rows="4">${esc(ticket.description)}</textarea></label>
    <label>Category<input name="category" value="${esc(ticket.category)}"></label><label>Subcategory<input name="subcategory" value="${esc(ticket.subcategory)}"></label>
    <label>Service<input name="service" value="${esc(ticket.service)}"></label><label>Assignment group<input name="assignment_group" value="${esc(ticket.assignment_group)}"></label>
    <label class="wide">Assigned to${state.user?.role === 'admin' ? `<select name="assigned_user_id"><option value="">Unassigned</option>${state.users.filter(user=>user.role!=='customer').map(user=>`<option value="${esc(user.id)}" ${ticket.assigned_user_id===user.id?'selected':''}>${esc(user.name)} (${esc(user.username)})</option>`).join('')}</select>` : `<input value="${esc(ticket.assigned_to || '')}" readonly>`}</label>
    <label>Priority<select name="priority">${["P1","P2","P3","P4"].map(value => `<option ${value === ticket.priority ? "selected" : ""}>${value}</option>`).join("")}</select></label>
    <label>State<select name="state">${states.map(value => `<option ${value === ticket.state ? "selected" : ""}>${value}</option>`).join("")}</select></label>
    <div class="wide action-row ticket-save-row"><button class="primary" type="submit">Save ticket</button></div>
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
  return `<section class="activity-panel"><div class="panel-head"><div><p class="eyebrow">ACTIVITY</p></div></div><div class="activity-list">${notes}</div><form id="workNoteForm" class="activity-form"><label>Comment<textarea name="text" rows="3" required ${enabled ? "" : "disabled"} placeholder="Add progress, troubleshooting details, or customer feedback"></textarea></label><div class="action-row"><span class="helper">${enabled ? "Technicians and customers can add activity while work is underway." : "Save the ticket as In Progress before adding activity."}</span><button class="secondary" type="submit" ${enabled ? "" : "disabled"}>Add activity</button></div><p class="form-message" data-activity-message></p></form></section>`;
}

function transcriptPanel(item) {
  if (!item.transcript.length) return '';
  return `<details class="incident-transcript"><summary>Call conversation · ${esc(item.ticket.call_id || 'Recorded intake')}</summary><p class="helper">Technician: ${esc(item.ticket.assigned_to || 'Not assigned')} · Customer: ${esc(item.caller)}</p><div class="live-transcript">${item.transcript.map(turn=>`<div class="transcript-turn"><b>${esc(turn.speaker)}${turn.speaker_name ? ` · ${esc(turn.speaker_name)}` : ''}</b><small>${turn.timestamp ? esc(new Date(turn.timestamp).toLocaleTimeString()) : ''}</small><p>${esc(turn.text)}</p></div>`).join('')}</div></details>`;
}

function resolutionPanel(item) {
  const resolved = item.ticket.state === "Resolved";
  return `<section class="resolution-panel"><p class="eyebrow">RESOLUTION</p><form id="resolutionForm"><label>Resolution details<textarea name="resolution" rows="8" required placeholder="Describe the fix, validation performed, and customer confirmation">${esc(item.ticket.resolution)}</textarea></label>${resolved ? "" : '<p class="helper">Submitting these notes resolves the ticket and runs AI QA automatically.</p>'}<button class="primary full" type="submit">${resolved ? "Save resolution notes" : "Resolve ticket"}</button><p class="form-message" data-resolution-message></p></form></section>`;
}

async function saveTicket(form) {
  const editingTicketDetails = $("#view-ticket-detail").classList.contains("active");
  const values = Object.fromEntries(new FormData(form).entries());
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
  catch (error) { toast(error.message); }
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
  ++ticketQaRequest;
  $("#ticketQaPagination").hidden = true;
  if (state.user?.role !== 'admin' && item.ticket.assigned_user_id !== state.user?.id) {
    toast('You can review audits for tickets assigned to you.'); showView('qa'); return;
  }
  selectReportTab("qa", "tickets", false);
  refreshBulkQA();
  state.current = item;
  $$(".view").forEach(el => el.classList.toggle("active", el.id === "view-qa"));
  $$(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.view === "qa"));
  document.title = "Quality audit";
  const heading = `<div class="qa-head"><div><div class="qa-identifiers"><span>Ticket number: <b>${esc(item.ticket.id)}</b></span><span>Call ID: <b>${esc(item.ticket.call_id || 'Not linked')}</b></span></div><h3>${esc(item.issue_title)}</h3></div><strong>${item.quality_score == null ? 'Pending' : `${item.quality_score}%`}</strong></div>`;
  if (item.ticket.state !== "Resolved") {
    $("#qaWorkspace").className = "panel empty-list";
    $("#qaWorkspace").innerHTML = `${heading}<h3>QA pending</h3><p>Resolve ${esc(item.ticket.id)} before running AI QA. This keeps the audit focused on the completed incident record.</p>`;
    return;
  }
  if (item.quality_score == null) {
    $("#qaWorkspace").className = "panel empty-list";
    $("#qaWorkspace").innerHTML = `${heading}<h3>QA pending</h3><p>AI QA is running in the background for ${esc(item.ticket.id)}. Return to the audit list shortly to see the completed score.</p><button class="secondary" data-view="qa">← Back to audits</button>`;
    return;
  }
  const audit = visibleAuditChecks(item.qa_checks);
  const lines = value => esc(value).replace(/\n/g, '<br>');
  const checks = audit.checks.map(check => `<div class="qa-check"><b class="${esc(check.result)}">${esc(check.result)}</b><strong>${esc(check.field)}</strong><span><b>Observed:</b> ${lines(check.observed)}<br><b>Recommended:</b> ${lines(check.recommended)}<br><small>Evidence: ${lines(check.evidence)}</small></span></div>`).join("");
  $("#qaWorkspace").className = "panel";
  $("#qaWorkspace").innerHTML = `<button class="text-button qa-back" data-view="qa">← Back to audits</button>${heading}${audit.legacy ? '<p class="helper">This saved score used the earlier audit format. Rerun QA to update it.</p>' : ''}<div>${checks || "No checks returned."}</div><div class="action-row"><span class="helper">The audit compares the resolved ticket with the source conversation.</span><button class="primary" id="rerunQa">Rerun AI QA</button></div>`;
}

let ticketQaCases = [], ticketQaRequest = 0;
const ticketQaPager = {page:1, key:null};
async function loadQA() {
  const request = ++ticketQaRequest;
  const userId = state.user?.id, cases = await api('/api/reporting/tickets');
  if (state.user?.id !== userId || request !== ticketQaRequest) return;
  const resolved = cases.filter(item => item.ticket.state === "Resolved");
  state.qaResolvedCount = resolved.length;
  refreshBulkQA();
  ticketQaCases = resolved;
  renderTicketQAList();
}
function renderTicketQAList() {
  const resolved = ticketQaCases;
  const page = paginateItems(resolved, ticketQaPager, state.user?.id, '#ticketQaPagination');
  $("#qaWorkspace").className = resolved.length ? "panel table-wrap" : "panel empty-list";
  $("#qaWorkspace").innerHTML = resolved.length ? `<table><thead><tr><th>Ticket</th><th>Issue</th><th>Service</th><th>Priority</th><th>QA status</th></tr></thead><tbody>${page.map(item => `<tr data-qa-case-id="${esc(item.id)}"><td><strong>${esc(item.ticket.id)}</strong></td><td>${esc(item.ticket.short_description)}</td><td>${esc(item.ticket.service)}</td><td><span class="tag">${esc(item.ticket.priority)}</span></td><td><b>${item.quality_score == null ? "Pending" : `${item.quality_score}%`}</b></td></tr>`).join("")}</tbody></table>` : "No resolved tickets yet. Resolved tickets appear here immediately while AI QA runs in the background.";
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

let ticketPage = 1, ticketFilterKey = null;
const PAGE_SIZE = 10;
function updatePagination(id, page, total) {
  const count = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const host = $(id);
  host.hidden = total === 0;
  host.innerHTML = `<button type="button" class="secondary small" data-page-step="-1" ${page === 1 ? "disabled" : ""}>Previous</button><span role="status" aria-live="polite">Page ${page} of ${count} · ${total ? (page-1)*PAGE_SIZE+1 : 0}–${Math.min(page*PAGE_SIZE,total)} of ${total}</span><button type="button" class="secondary small" data-page-step="1" ${page === count ? "disabled" : ""}>Next</button>`;
}

function paginateItems(items, pager, key, target) {
  if(pager.key !== key) {pager.page=1;pager.key=key;}
  pager.page=Math.max(1,Math.min(pager.page,Math.max(1,Math.ceil(items.length/PAGE_SIZE))));
  updatePagination(target,pager.page,items.length);
  return items.slice((pager.page-1)*PAGE_SIZE,pager.page*PAGE_SIZE);
}
function bindPagination(target,pager,render) {
  $(target).addEventListener('click',event=>{
    const button=event.target.closest('[data-page-step]');
    if(button && !button.disabled){pager.page+=Number(button.dataset.pageStep);render();}
  });
}
bindPagination('#ticketQaPagination',ticketQaPager,renderTicketQAList);

async function loadCases() {
  const userId = state.user?.id;
  const cases = await api('/api/cases');
  if (state.user?.id !== userId) return;
  state.cases = cases;
  const select = $('#ticketAssignee'), selected = select.value;
  const names = [...new Set(cases.map(item => item.ticket.assigned_to).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  select.innerHTML = '<option value="">All assigned names</option><option value="__unassigned__">Unassigned</option>' + names.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');
  select.value = [...select.options].some(option=>option.value===selected) ? selected : '';
  renderTickets();
}

function renderTickets() {
  const number = $('#ticketSearch').value.trim().toLowerCase(), assignee = $('#ticketAssignee').value;
  const status = $('#ticketStateFilter').value, priority = $('#ticketPriorityFilter').value;
  const key = JSON.stringify([state.user?.id, number, assignee, status, priority]);
  if (key !== ticketFilterKey) { ticketPage = 1; ticketFilterKey = key; }
  const cases = state.cases.filter(item => item.ticket.id.toLowerCase().includes(number) &&
    (!status || item.ticket.state === status) && (!priority || item.ticket.priority === priority) &&
    (!assignee || (assignee === '__unassigned__' ? !item.ticket.assigned_to : item.ticket.assigned_to === assignee)));
  $('#ticketResultCount').textContent = `${cases.length} of ${state.cases.length} tickets`;
  $('#ticketsEmpty').hidden = cases.length > 0;
  $('#ticketsEmpty').textContent = state.cases.length ? 'No tickets match these filters.' : 'No tickets yet.';
  ticketPage = Math.min(ticketPage, Math.max(1, Math.ceil(cases.length / PAGE_SIZE)));
  updatePagination('#ticketPagination', ticketPage, cases.length);
  $('#ticketRows').innerHTML = cases.slice((ticketPage-1)*PAGE_SIZE, ticketPage*PAGE_SIZE).map(item => `<tr data-case-id="${esc(item.id)}"><td><strong>${esc(item.ticket.id)}</strong></td><td>${esc(item.ticket.short_description)}</td><td>${esc(item.ticket.service)}</td><td><span class="tag">${esc(item.ticket.priority)}</span></td><td>${esc(item.ticket.assigned_to || 'Unassigned')}</td><td>${esc(item.ticket.state)}</td></tr>`).join('');
}
$('#ticketPagination').addEventListener('click', event => { const button=event.target.closest('[data-page-step]'); if(button && !button.disabled) { ticketPage+=Number(button.dataset.pageStep); renderTickets(); } });
$('#ticketSearch').addEventListener('input', renderTickets);
$('#ticketAssignee').addEventListener('change', renderTickets);
$('#ticketStateFilter').addEventListener('change', renderTickets);
$('#ticketPriorityFilter').addEventListener('change', renderTickets);
$('#clearTicketFilters').addEventListener('click', () => {
  ['ticketSearch','ticketAssignee','ticketStateFilter','ticketPriorityFilter'].forEach(id => $('#'+id).value='');
  renderTickets();
});

async function openTicketDetails(caseId) {
  if (state.user?.role === 'admin') state.users = await api('/api/users');
  state.current = await api(`/api/cases/${caseId}`);
  showView("ticket-detail");
  const detail = $("#ticketDetailPage"); detail.className = "panel ticket-detail-panel";
  detail.innerHTML = `<div class="panel-head"><div><p class="eyebrow">INCIDENT</p><h2>${esc(state.current.ticket.id)}</h2><p class="helper">${state.user?.role === "customer" ? "Track progress and add comments." : "Edit the incident fields and save your changes."}</p></div><div class="tm-ticket-actions">${state.user?.role === "customer" ? "" : `<button class="primary small" data-enter-time-machine="${esc(state.current.id)}">Enter Time Machine →</button>`}<span class="tag">${esc(state.current.ticket.state)}</span></div></div>${state.user?.role === "customer" ? customerTicketDetails(state.current) : renderAttachments(state.current.ticket.attachments) + ticketForm(state.current) + followupPanels(state.current)}${transcriptPanel(state.current)}`;
  $('#ticketDurability').hidden = state.user?.role === 'customer';
  if (state.user?.role !== 'customer') window.loadCaseResolutionRadar?.(state.current.id);
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

const knowledgePager = {page:1,key:null};
bindPagination('#knowledgePagination',knowledgePager,()=>renderKnowledge($("#knowledgeSearch").value));
function renderKnowledge(query = "") {
  const term = query.trim().toLowerCase();
  const articles = state.knowledge.filter(article => !term || [article.id, article.title, article.product, article.symptoms, article.tags.join(" "), article.steps.join(" ")].join(" ").toLowerCase().includes(term));
  const page = paginateItems(articles, knowledgePager, JSON.stringify([state.user?.id,term]), '#knowledgePagination');
  $("#knowledgeList").innerHTML = articles.length ? page.map(article => `<article class="article-card"><h4>${esc(article.id)} · ${esc(article.title)}</h4><p><b>${esc(article.product)}</b> · ${esc(article.tags.join(", "))}</p><p>${esc(article.symptoms)}</p><details><summary>Resolution steps</summary><ol>${article.steps.map(step => `<li>${esc(step)}</li>`).join("")}</ol><p><b>Expected outcome:</b> ${esc(article.resolution)}</p>${article.source_ticket_ids?.length ? `<p class="helper">Source incidents: ${article.source_ticket_ids.map(number => `<button type="button" class="text-button" data-source-ticket="${esc(number)}">${esc(number)}</button>`).join(", ")}</p>` : ""}</details></article>`).join("") : `<div class="empty-list">No knowledge articles match “${esc(query)}”.</div>`;
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
  } catch (error) {toast(error.message);}
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
  if (!file) { toast("Choose an audio file first."); return; }
  const form = new FormData(); form.append("file", file, file.name || "recording.webm");
  const message = $("#analysisMessage"); message.className = "form-message"; message.textContent = `Transcribing with ${state.config?.transcription_model || "the configured model"}…`;
  try {
    const result = await api("/api/transcribe", { method: "POST", body: form });
    $("#transcriptInput").value = result.text; message.textContent = `Transcription complete with ${result.model}. Review the text, add speaker labels if needed, then analyze.`;
  } catch (error) { message.className = "form-message error"; message.textContent = error.message; }
}

async function toggleRecording() {
  if (state.mediaRecorder?.state === "recording") { state.mediaRecorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("Audio recording is not supported by this browser. Upload a recording instead."); return; }
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
  } catch (error) { toast(`Microphone unavailable: ${error.message}`); }
}

document.addEventListener("click", event => {
  const followupTab = event.target.closest("[data-followup-tab]");
  if (followupTab) {
    const container = followupTab.closest(".ticket-followup"); const selected = followupTab.dataset.followupTab;
    container.querySelectorAll("[data-followup-tab]").forEach(button => button.classList.toggle("active", button.dataset.followupTab === selected));
    container.querySelectorAll("[data-followup-pane]").forEach(pane => pane.hidden = pane.dataset.followupPane !== selected);
  }
  const nav = event.target.closest("[data-view]"); if (nav) nav.dataset.view === "case" ? startNewCase() : showView(nav.dataset.view);
  if (event.target.closest("[data-open-case]")) startNewCase();
  const direct = event.target.closest("[data-view-target]"); if (direct) showView(direct.dataset.viewTarget);
  const caseRow = event.target.closest("[data-case-id]"); if (caseRow) caseRow.tagName === "TR" ? openTicketDetails(caseRow.dataset.caseId) : openCase(caseRow.dataset.caseId, "case");
  const timeMachine = event.target.closest('[data-enter-time-machine]'); if (timeMachine) window.enterIncidentTimeMachine?.(timeMachine.dataset.enterTimeMachine);
  const qaRow = event.target.closest("[data-qa-case-id]"); if (qaRow) openCase(qaRow.dataset.qaCaseId, "qa");
  if (event.target.closest("[data-open-qa]") && state.current) renderQA(state.current);
  if (event.target.closest("#rerunQa")) rerunQA();
  if (event.target.closest("#openKeyPanel")) $("#keyModal").hidden = false;
  if (event.target.closest("#closeKeyPanel") || event.target === $("#keyModal")) $("#keyModal").hidden = true;
  if (event.target.closest("#openKnowledgePanel")) openKnowledgeEditor();
  if (event.target.closest("#closeKnowledgePanel") || event.target === $("#knowledgeModal")) $("#knowledgeModal").hidden = true;
  if (event.target.closest('#openIncidentKnowledgePanel')) {$('#incidentKnowledgeModal').hidden=false; $('#incidentKnowledgeMessage').textContent=''; $('#incidentKnowledgeForm textarea').focus();}
  if (event.target.closest('#closeIncidentKnowledgePanel') || event.target === $('#incidentKnowledgeModal')) {$('#incidentKnowledgeModal').hidden=true; knowledgeGeneration?.abort();}
  const source = event.target.closest('[data-source-ticket]'); if (source) openKnowledgeSource(source.dataset.sourceTicket);
});
document.addEventListener("submit", event => {
  if (event.target.id === "ticketForm") { event.preventDefault(); saveTicket(event.target).catch(error => toast(error.message)); }
  if (event.target.id === "workNoteForm") { event.preventDefault(); addWorkNote(event.target).catch(error => toast(error.message)); }
  if (event.target.id === "resolutionForm") { event.preventDefault(); saveResolution(event.target); }
});
$("#keyForm").addEventListener("submit", saveAIKey);
$("#analyzeButton").addEventListener("click", analyzeConversation);
$("#captureButton").addEventListener("click", toggleRecording);
$("#transcribeFileButton").addEventListener("click", () => transcribeAudio($("#audioFile").files[0]));
$("#caseMediaFiles").addEventListener("change", event => {
  const files = [...event.target.files];
  $("#caseMediaSelection").textContent = files.length ? files.map(file => `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`).join(" · ") : "";
});
$("#knowledgeForm").addEventListener("submit", addKnowledge);
$('#incidentKnowledgeForm').addEventListener('submit', generateIncidentKnowledge);
$("#knowledgeSearch").addEventListener("input", event => renderKnowledge(event.target.value));

window.applyAccountRole = user => {
  if (state.user?.id !== user?.id) {
    state.cases = []; state.users = []; state.current = null;
    $('#transcriptDetail').innerHTML = ''; $('#transcriptDetail').hidden = true;
    $('#ticketPagination').hidden = $('#transcriptPagination').hidden = true;
    ['knowledgePagination','ticketQaPagination','callQaPagination','radarPagination'].forEach(id=>$('#'+id).hidden=true);
    ticketQaCases=[]; ++ticketQaRequest;
    $('#ticketRows').innerHTML = ''; $('#ticketDetailPage').innerHTML = '';
    $('#ticketDurability').hidden = true; $('#ticketDurability').innerHTML = '';
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
  $$('.nav-item').forEach(nav => {nav.hidden = !user || (customer ? !['customer-home','tickets','knowledge','transcripts'].includes(nav.dataset.view) : nav.dataset.view === 'customer-home' || nav.dataset.view === 'technicians' && !admin);});
  $('#accountIdentity').textContent = user ? `${user.name} · ${user.role === 'admin' ? 'Admin' : customer ? 'Customer' : 'Technician'}` : '';
  $('#accountSignOut').hidden = !user;
  $('#sidebarAccount').hidden = !user;
  if (!user || customer) {
    $('#presenceControl').hidden = $('#enablePhoneButton').hidden = true;
    $('#incomingCallBanner').hidden = true;
  }
  $('.system-card').hidden = !user;
  $('#openKeyPanel').hidden = !admin || state.config?.runtime_key_supported === false;
  $('#openKnowledgePanel').hidden = $('#openIncidentKnowledgePanel').hidden = !user || customer;
};

function customerTicketDetails(item) {
  return `<div class="customer-ticket"><h3>${esc(item.ticket.short_description)}</h3><p style="white-space:pre-wrap">${esc(item.ticket.description)}</p><p><b>State:</b> ${esc(item.ticket.state)} · <b>Service:</b> ${esc(item.ticket.service)} · <b>Assigned to:</b> ${esc(item.ticket.assigned_to || 'Awaiting assignment')}</p>${renderAttachments(item.ticket.attachments)}${item.ticket.resolution ? `<h4>Resolution</h4><p>${esc(item.ticket.resolution)}</p>` : ''}</div>${activityPanel(item)}`;
}

function renderAttachments(attachments = []) {
  if (!attachments.length) return '';
  return `<section class="incident-attachments"><h4>Attachments</h4><div class="attachment-grid">${attachments.map(att => {
    const url = `/api/attachments/${encodeURIComponent(att.id)}`;
    const preview = att.content_type.startsWith('image/')
      ? `<img class="attachment-preview" src="${url}" alt="${esc(att.filename)}" loading="lazy">`
      : att.content_type.startsWith('video/')
        ? `<video class="attachment-preview" controls preload="metadata"><source src="${url}" type="${esc(att.content_type)}">Your browser cannot play this video.</video>`
        : '';
    return `<article class="attachment-card">${preview}<a href="${url}" target="_blank" rel="noopener">${esc(att.filename)}</a><small>${(att.size_bytes / 1024 / 1024).toFixed(1)} MB</small></article>`;
  }).join('')}</div></section>`;
}

async function loadCustomerCalls() {
  const calls = await api('/api/customer/calls');
  $('#customerCalls').innerHTML = calls.length ? calls.map(call=>`<div class="case-row"><div><strong>${esc(call.id)}</strong><small>${new Date(call.created_at*1000).toLocaleString()} · ${esc(call.status)}</small></div>${call.case_id ? `<button class="text-button" data-customer-ticket="${esc(call.case_id)}">View incident</button>` : ''}</div>`).join('') : 'No calls yet.';
}

$('#customerIncidentForm').addEventListener('submit', async event => {
  event.preventDefault(); const form=event.target,button=form.querySelector('button'),message=$('#customerIncidentMessage');
  button.disabled=true;message.textContent='Creating your incident…';
  try {const item=await api('/api/customer/incidents',{method:'POST',body:new FormData(form)});form.reset();$('#attachmentSelection').textContent='';message.textContent='';await openTicketDetails(item.id);}
  catch(error){message.textContent=error.message;}finally{button.disabled=false;}
});
$('#customerIncidentForm [name="attachments"]').addEventListener('change', event => {
  const files = [...event.target.files];
  $('#attachmentSelection').textContent = files.length ? files.map(file => `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`).join(' · ') : '';
});
document.addEventListener('click',event=>{const source=event.target.closest('[data-customer-ticket]');if(source)openTicketDetails(source.dataset.customerTicket);});
$('#accountSignIn').addEventListener('click',()=>window.openTechnicianAuth?.());


window.loadApplication = async () => {
  try {
    const auth=await api('/api/auth/status');applyAccountRole(auth.user);
    if(!auth.user){showView('signin');return;}
    await Promise.all([loadConfig(),loadKnowledge(),auth.user.role==='customer'?Promise.resolve():loadOverview()]);
    if(auth.user.role==='admin')state.users=await api('/api/users');
    const params=new URLSearchParams(location.search);
    if(params.get('next')==='support'){location.href='/support';return;}
    if(params.get('transcript'))return window.openTranscript(params.get('transcript'), false);
    if(params.get('ticket'))return openTicketDetails(params.get('ticket'));
    if(params.get('case'))return openTicketDetails(params.get('case'));
    showView(params.get('view') || (auth.user.role==='customer'?'customer-home':auth.user.role==='technician'?'calls':'overview'));
  } catch(error){toast(error.message);}
};
applyAccountRole(null);
window.loadApplication();
