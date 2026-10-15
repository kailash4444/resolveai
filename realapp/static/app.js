const state = { user: null, users: [], config: null, cases: [], knowledge: [], current: null, mediaRecorder: null, audioChunks: [], audioStream: null };
let knowledgeDraftSources = [], knowledgeGeneration;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
function priorityBadge(value) {
  const tones = {P1:['▲','Critical · P1','badge--critical'],P2:['◆','High · P2','badge--high'],P3:['●','Medium · P3','badge--medium'],P4:['▽','Low · P4','badge--low']};
  const [icon,label,tone] = tones[value] || ['○','Unrated','badge--muted'];
  return `<span class="badge ${tone}">${icon} ${label}</span>`;
}
function stateBadge(value) {
  const states = {Resolved:['✓','badge--ok'],'In Progress':['◆','badge--high'],'On Hold':['○','badge--muted'],New:['●','badge--new'],Closed:['✓','badge--ok']};
  const [icon,tone] = states[value] || ['○','badge--muted'];
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
    try { const detail = (await response.json()).detail; if (typeof detail === 'string') message = detail; else if (Array.isArray(detail) && detail.length) message = detail.map(item => {
        const field = Array.isArray(item.loc) ? item.loc.filter(part => part !== 'body').join(' → ') : '';
        return [field, (item.msg || 'Invalid value').replace(/^Value error, /, '')].filter(Boolean).join(': ');
      }).join('; ');
      else if (detail && typeof detail === 'object') message = detail.message || JSON.stringify(detail);
    } catch (_) {}
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
  // Arrow keys are handled by the component script; this adds Home / End.
  if (!tab || !['Home','End'].includes(event.key)) return;
  event.preventDefault();
  const target = event.key === 'Home' ? 'tickets' : 'calls';
  selectReportTab(tab.dataset.report, target); $(`#${tab.dataset.report}-${target}-tab`).focus();
});
const VIEW_ACCESS = {
  customer: ['customer-home','customer-create','tickets','ticket-detail','knowledge','transcripts'],
  technician: ['overview','case','tickets','ticket-detail','time-machine','calls','transcripts','analytics','resolution-radar','knowledge','qa'],
};
VIEW_ACCESS.admin = [...VIEW_ACCESS.technician, 'technicians'];
const VIEW_TITLES = {signin: 'ResolveAI · Less firefighting. More resolution.', 'customer-home': 'My support', 'customer-create': 'Report an issue', overview: 'Overview', case: 'Conversation intake', tickets: 'Tickets', 'ticket-detail': 'Ticket details', 'time-machine': 'Incident Time Machine', 'resolution-radar': 'Resolution debt', calls: 'Calls & queue', transcripts: 'Transcripts', analytics: 'Analytics', knowledge: 'Knowledge', qa: 'Quality audit', technicians: 'Users', denied: 'No access', notfound: 'Not found'};
function homeView(user = state.user) { return !user ? 'signin' : user.role === 'customer' ? 'customer-home' : user.role === 'technician' ? 'calls' : 'overview'; }
function showView(name) {
  if (name === 'configuration') name = homeView();
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

  if (name === "customer-home") {
    // The voice frame only loads when a signed-in customer starts a call (see support-hub.js).
    if (state.user?.role === 'customer') window.SupportHub?.open();
    loadCustomerCalls(); loadCustomerIncidents();
  }
  if (name === "tickets") loadCases();
  if (name === "knowledge") loadKnowledge();
  if (name === "analytics") selectReportTab("analytics", reportTabs.analytics);
  if (name === "transcripts") window.loadTranscripts?.();
  if (name === "resolution-radar") window.loadResolutionRadar?.();
  if (name === "overview") loadOverview();
  if (name === "qa") { state.qaDetail = null; selectReportTab("qa", reportTabs.qa); }
  if (["calls", "technicians"].includes(name)) window.loadCalling?.();
}

const caseUploader = ResolveUploader.create({drop: $('#caseDrop'), list: $('#caseMediaSelection'), errors: $('#caseMediaErrors')});
const providerName = () => state.config?.provider === 'openai' ? 'OpenAI' : state.config?.provider === 'mock' ? 'Test AI' : 'Gemini';
const exampleTag = item => item?.demo_dataset ? ' <span class="badge badge--muted">○ Example data</span>' : '';
function providerLine() {
  return state.config?.configured ? `Uses ${providerName()} · analysis ${state.config.model} · transcription ${state.config.transcription_model}` : 'The AI provider isn’t configured, so transcription and analysis are unavailable.';
}
function setCaseStatus(text, error = false) { const box = $('#analysisMessage'); box.className = `form-status${error ? ' err' : ''}`; box.textContent = text; }

function startNewCase() {
  if (state.user?.role === "customer") { showView("customer-create"); return; }
  state.current = null;
  $("#caseForm").reset(); $("#callerInput").value = "Customer";
  caseUploader.clear();
  $("#caseResult").hidden = true; $("#caseResult").innerHTML = "";
  $('#transcriptError').hidden = true; $('#transcriptInput').removeAttribute('aria-invalid');
  setCaseStatus(providerLine(), !state.config?.configured);
  showView("case");
  window.scrollTo({ top: 0 });
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
  const ready = state.config.configured, provider = providerName();
  $('#keyModalTitle').textContent = `Connect ${provider}`;
  $('#apiKeyLabel').textContent = `${provider} API key`;
  $('#analyzeButton').innerHTML = `Analyze with ${provider} <span aria-hidden="true">→</span>`;
  ['#analyzeButton', '#transcribeFileButton', '#captureButton'].forEach(id => { $(id).disabled = !ready; });
  $('#caseProviderNotice').hidden = ready;
  const connection = $("#connectionBadge");
  connection.className = `badge ${ready ? 'badge--ok' : 'badge--high'}`; connection.textContent = ready ? `✓ ${provider} ready` : '◆ AI provider not configured';
  if (!state.current) setCaseStatus(providerLine(), !ready);
}

const PRIORITY_RANK = {P1: 0, P2: 1, P3: 2, P4: 3};
function age(value) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value)) / 60000));
  return minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
}
function incidentLink(item) { return `<a class="mono" href="${window.Shell.home(state.user.role)}?ticket=${encodeURIComponent(item.id)}" data-ticket-link="${esc(item.id)}">${esc(item.ticket.id)}</a>`; }

// Bar chart with a text alternative and a data table equivalent. Bars are decorative; numbers live in text.
function barChart(counts, {caption, unit = 'incidents', id}) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<p class="sec">No data for this selection yet.</p>';
  const total = entries.reduce((sum, [, n]) => sum + n, 0), max = Math.max(...entries.map(([, n]) => n));
  const share = n => `${Math.round(n / Math.max(1, total) * 100)}%`;
  return `<figure class="chart" aria-label="${esc(caption)}"><figcaption class="help">${total} ${unit} in total · bars are relative to the largest</figcaption>
    <div class="bars" aria-hidden="true">${entries.map(([label, n]) => `<div class="bars__row"><span class="bars__label">${esc(label)}</span><span class="bars__track"><span class="bars__fill" style="width:${Math.max(2, Math.round(n / max * 100))}%"></span></span><span class="bars__value">${n} · ${share(n)}</span></div>`).join('')}</div>
    <p class="sr">${esc(caption)}: ${entries.map(([label, n]) => `${esc(label)} ${n} ${unit} (${share(n)})`).join('; ')}.</p>
    <details class="chart__table"><summary>Show as table</summary><div class="tbl-wrap"><table class="tbl"><caption class="sr">${esc(caption)}</caption><thead><tr><th scope="col">Category</th><th scope="col">Count (${unit})</th><th scope="col">Share</th></tr></thead><tbody>${entries.map(([label, n]) => `<tr><th scope="row">${esc(label)}</th><td>${n}</td><td>${share(n)}</td></tr>`).join('')}</tbody></table></div></details></figure>`;
}

async function loadOverview() {
  if (state.user?.role === 'customer') return;
  const admin = state.user?.role === 'admin';
  $('#overviewKicker').textContent = admin ? 'Admin workspace' : 'Technician workspace';
  $('#metricsScope').textContent = admin ? 'Scope: every incident in this workspace' : 'Scope: incidents visible to you';
  $('#overviewLoading').hidden = !$('#overviewContent').hidden; $('#overviewError').hidden = true;
  try {
    const [data, cases] = await Promise.all([api('/api/overview'), api('/api/cases')]);
    const queue = cases.filter(item => !['Resolved','Closed'].includes(item.ticket.state))
      .sort((a, b) => (PRIORITY_RANK[a.ticket.priority] ?? 4) - (PRIORITY_RANK[b.ticket.priority] ?? 4) || new Date(a.created_at) - new Date(b.created_at));
    $('#queueCount').textContent = `${queue.length} open`;
    $('#recentCases').innerHTML = queue.length ? `<div class="tbl-wrap" role="region" aria-label="Work queue" tabindex="0"><table class="tbl"><caption class="sr">Open incidents by priority</caption><thead><tr><th scope="col">Incident</th><th scope="col">Issue</th><th scope="col">Priority</th><th scope="col">State</th><th scope="col" class="col-opt">Assigned to</th><th scope="col" class="col-opt">Waiting</th></tr></thead><tbody>${queue.slice(0, 8).map(item => `<tr><td>${incidentLink(item)}</td><td>${esc(item.issue_title || item.ticket.short_description)}${exampleTag(item)}</td><td>${priorityBadge(item.ticket.priority)}</td><td>${stateBadge(item.ticket.state)}</td><td class="col-opt">${esc(item.ticket.assigned_to || 'Unassigned')}</td><td class="col-opt">${age(item.created_at)}</td></tr>`).join('')}</tbody></table></div>${queue.length > 8 ? `<p class="help">Showing the 8 most urgent of ${queue.length}.</p>` : ''}` : '<div class="empty"><h3>No open incidents</h3><p class="sec">New reports and calls appear here.</p></div>';
    $('#metricTotal').textContent = data.total_cases;
    $('#metricOpen').textContent = data.open_cases;
    $('#metricAI').textContent = data.ai_handled;
    $('#metricQA').textContent = data.average_quality ? `${data.average_quality}%` : '—';
    $('#metricQAHelp').textContent = data.average_quality ? 'Percent · mean of audited, resolved tickets' : 'No audited tickets yet';
    $('#recentIncidents').innerHTML = data.recent_cases.length ? `<div class="tbl-wrap" role="region" aria-label="Recent incidents" tabindex="0"><table class="tbl"><caption class="sr">Recent incidents</caption><thead><tr><th scope="col">Incident</th><th scope="col">Issue</th><th scope="col">State</th><th scope="col" class="col-opt">Handling</th></tr></thead><tbody>${data.recent_cases.map(item => `<tr><td>${incidentLink(item)}</td><td>${esc(item.issue_title || item.ticket.short_description)}${exampleTag(item)}</td><td>${stateBadge(item.ticket.state)}</td><td class="col-opt">${esc(item.routing.handler)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="sec">No incidents yet.</p>';
    $('#themeList').innerHTML = barChart(Object.fromEntries(data.themes.map(item => [item.name, item.count])), {caption: 'Incidents by category', id: 'themes'});
    $('#overviewContent').hidden = false;
  } catch (error) {
    $('#overviewErrorMessage').textContent = error.message;
    $('#overviewError').hidden = false;
  } finally { $('#overviewLoading').hidden = true; }
}
$('#retryOverview').addEventListener('click', loadOverview);

async function uploadCaseMedia(files) {
  const media = new FormData();
  files.forEach(file => media.append("attachments", file, file.name));
  caseUploader.setStatus('uploading');
  state.current = await api(`/api/cases/${encodeURIComponent(state.current.id)}/attachments`, { method: "POST", body: media });
  caseUploader.clear();
}

async function analyzeConversation(event) {
  event?.preventDefault();
  const transcript = $("#transcriptInput").value.trim();
  if (transcript.length < 20) {
    $('#transcriptError').textContent = '✕ Add at least a few lines of the conversation (20 characters or more).'; $('#transcriptError').hidden = false;
    $('#transcriptInput').setAttribute('aria-invalid', 'true'); $('#transcriptInput').focus(); return;
  }
  $('#transcriptError').hidden = true; $('#transcriptInput').removeAttribute('aria-invalid');
  if (caseUploader.hasErrors()) { setCaseStatus('✕ Remove the photos marked ✕ before analyzing.', true); return; }
  const files = caseUploader.files();
  const button = $("#analyzeButton"); button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = "Analyzing…";
  setCaseStatus(`● Analyzing with ${providerName()}: matching knowledge and drafting an incident.`);
  try {
    state.current = await api("/api/analyze", { method: "POST", body: JSON.stringify({ transcript, caller: $("#callerInput").value || "Customer", channel: $("#channelInput").value }) });
    let attachmentError = '';
    if (files.length) {
      setCaseStatus(`● Incident ${state.current.ticket.id} drafted. Uploading ${files.length} photo${files.length === 1 ? '' : 's'}…`);
      try { await uploadCaseMedia(files); } catch (error) { caseUploader.setStatus('failed'); attachmentError = error.message; }
    }
    renderCase(state.current, {attachmentError});
    setCaseStatus(attachmentError ? `◆ Incident ${state.current.ticket.id} created; photos weren’t attached.` : `✓ Draft ready. Review it below.`, !!attachmentError);
  } catch (error) { setCaseStatus(`✕ Analysis failed: ${error.message}`, true); }
  finally { button.disabled = !state.config?.configured; button.removeAttribute('aria-busy'); button.innerHTML = `Analyze with ${providerName()} <span aria-hidden="true">→</span>`; }
}

state.reviewed = new Set();
function renderCase(item, {attachmentError = ''} = {}) {
  $('#ticketDetailPage').innerHTML = '';
  const reviewed = state.reviewed.has(item.id), model = state.config?.model;
  const matches = item.knowledge_matches.map(match => `<li class="source"><div class="row row--between"><strong><span class="mono">${esc(match.id)}</span> · ${esc(match.title)}</strong><span class="badge badge--low">${Math.round(match.score * 100)}% match</span></div><p class="help">${esc(match.excerpt)}</p></li>`).join("");
  $("#caseResult").hidden = false;
  $("#caseResult").innerHTML = `<section class="card stack" aria-labelledby="caseResultTitle">
    <div class="section-head section-head--tight"><div><p class="kicker">${reviewed ? 'Reviewed incident' : 'AI draft'}</p><h2 id="caseResultTitle" tabindex="-1"><span class="mono">${esc(item.ticket.id)}</span> · ${esc(item.issue_title)}</h2></div>${reviewed ? '<span class="badge badge--ok">✓ Saved by you</span>' : '<span class="badge badge--high">◆ Draft · needs review</span>'}</div>
    <p class="help">Drafted by ${providerName()}${model ? ` (${esc(model)})` : ''} from the conversation above${item.knowledge_matches.length ? ` and ${item.knowledge_matches.length} knowledge article${item.knowledge_matches.length === 1 ? '' : 's'}` : ''}. The incident exists as New; nobody acts on it until a technician picks it up.</p>
    ${attachmentError ? `<div class="alert" role="alert"><strong>✕ Photos not attached.</strong><span class="sec">${esc(item.ticket.id)} was created, but the upload failed: ${esc(attachmentError)} Your photos are still selected above.</span><button type="button" class="btn btn-soft btn-sm" id="retryCaseMedia">Retry upload</button></div>` : ''}
    ${reviewed ? '' : '<div class="row" role="group" aria-label="Review the AI draft"><button type="button" class="btn btn-primary" id="acceptDraft">Accept draft</button><button type="button" class="btn btn-soft" id="editDraft">Edit fields</button><button type="button" class="btn btn-danger" id="rejectDraft">Reject draft</button></div>'}
    <div class="grid">
      <article class="panel-block stack stack--sm"><h3 class="h4">Understanding</h3><p class="sec">${esc(item.understanding.summary)}</p><dl class="kv"><div><dt>Intent</dt><dd>${esc(item.understanding.intent)}</dd></div><div><dt>Product</dt><dd>${esc(item.understanding.product)}</dd></div><div><dt>Urgency</dt><dd>${esc(item.understanding.urgency)}</dd></div><div><dt>Sentiment</dt><dd>${esc(item.understanding.sentiment)}</dd></div></dl></article>
      <article class="panel-block stack stack--sm"><h3 class="h4">Routing suggestion</h3><p><strong>${esc(item.routing.handler)} handling</strong></p><p class="help">${Math.round(item.routing.confidence * 100)}% confidence · ${esc(item.routing.risk)} risk</p><p class="sec" data-detail>${esc(item.routing.rationale)}</p><p class="small"><strong>Ask next:</strong> ${esc(item.next_question)}</p></article>
      <article class="panel-block stack stack--sm"><h3 class="h4">Knowledge sources</h3>${matches ? `<ul class="sources">${matches}</ul>` : '<p class="sec">No knowledge articles matched.</p>'}</article>
    </div>
    ${renderAttachments(item.ticket.attachments, false, item.ticket)}${renderVisualAnalysis(item.ticket, item.id)}
    <section class="stack" id="draftEditor" aria-labelledby="draftEditorTitle" ${reviewed ? '' : 'hidden'}><h3 class="h3" id="draftEditorTitle">Ticket fields</h3>${ticketForm(item)}</section>
  </section>`;
  $('#caseResultTitle').focus({preventScroll: true});
  $("#caseResult").scrollIntoView({ block: "start" });
}

function taxonomyField(label, name, current, choices) {
  const matched = choices.includes(current), id = `tf-${name}`;
  const options = choices.map(value => `<option value="${esc(value)}" ${matched && value === current ? "selected" : ""}>${esc(value)}</option>`).join("");
  return `<div class="field"><label for="${id}">${label}</label><select class="input" id="${id}" name="${name}" data-taxonomy-select>${options}<option value="Other" ${matched ? "" : "selected"}>Other (specify)</option></select><input class="input taxonomy-custom" name="${name}_other" aria-label="Custom ${label.toLowerCase()}" placeholder="Enter a ${label.toLowerCase()}" value="${matched ? "" : esc(current)}" ${matched ? "hidden disabled" : "required"}></div>`;
}

function toggleTimeSort(button, label) {
  button.dataset.direction = button.dataset.direction === 'oldest' ? 'newest' : 'oldest';
  const newest = button.dataset.direction === 'newest';
  button.querySelector('.sort-arrow').textContent = newest ? '↓' : '↑';
  button.setAttribute('aria-label', `${label}: ${newest ? 'newest' : 'oldest'} first. Sort ${newest ? 'oldest' : 'newest'} first`);
  button.closest('th')?.setAttribute('aria-sort',newest ? 'descending' : 'ascending');
}
function ticketForm(item) {
  const ticket = item.ticket, admin = state.user?.role === 'admin';
  const states = ticket.state === "Resolved" ? ["New","In Progress","On Hold","Resolved"] : ["New","In Progress","On Hold"];
  const priorities = {P1: '▲ Critical · P1', P2: '◆ High · P2', P3: '● Medium · P3', P4: '▽ Low · P4'};
  return `<form class="stack" id="ticketForm" novalidate>
    <div class="fields">
      <div class="field"><label for="tf-caller">Customer name</label><input class="input" id="tf-caller" value="${esc(item.caller)}" readonly></div>
      <div class="field"><label for="tf-channel">Channel</label><input class="input" id="tf-channel" value="${esc(item.channel)}" readonly></div>
      <div class="field"><label for="tf-reported">Reported time</label><input class="input" id="tf-reported" value="${esc(when(item.created_at))}" readonly></div>
      <div class="field field--wide"><label for="tf-short">Short description</label><input class="input" id="tf-short" name="short_description" value="${esc(ticket.short_description)}" required maxlength="200"></div>
      <div class="field field--wide"><label for="tf-desc">Description</label><textarea class="input" id="tf-desc" name="description" rows="4">${esc(ticket.description)}</textarea></div>
      ${taxonomyField("Category", "category", ticket.category, ["Access", "Hardware", "Incident", "Network", "Security", "Software", "Workplace"])}
      ${taxonomyField("Subcategory", "subcategory", ticket.subcategory, ["Account", "Account lockout", "Application crash", "Connectivity", "Display", "Investigation", "Password reset", "Permissions", "Triage", "Unclassified"])}
      ${taxonomyField("Service", "service", ticket.service, ["Business Application", "Corporate VPN", "Enterprise IT", "General", "General IT", "Google Workspace", "Identity", "Identity and Access Management", "Microsoft 365", "Outlook", "Reporting Portal", "Windows", "Workstation Display"])}
      ${taxonomyField("Assignment group", "assignment_group", ticket.assignment_group, ["Application Support", "Endpoint Support", "Identity Service Desk", "Network Operations", "Security Operations", "Service Desk"])}
      <div class="field"><label for="tf-assigned">Assigned to</label>${admin ? `<select class="input" id="tf-assigned" name="assigned_user_id"><option value="">Unassigned</option>${state.users.filter(user=>user.role!=='customer').map(user=>`<option value="${esc(user.id)}" ${ticket.assigned_user_id===user.id?'selected':''}>${esc(user.name)} (${esc(user.username)})</option>`).join('')}</select>` : `<input class="input" id="tf-assigned" value="${esc(ticket.assigned_to || 'Unassigned')}" readonly aria-describedby="tf-assigned-help"><p class="help" id="tf-assigned-help">Read-only: only administrators can change who a ticket is assigned to.</p>`}</div>
      <div class="field"><label for="tf-priority">Priority</label><select class="input" id="tf-priority" name="priority">${Object.entries(priorities).map(([value, label]) => `<option value="${value}" ${value === ticket.priority ? "selected" : ""}>${label}</option>`).join("")}</select></div>
      <div class="field"><label for="tf-state">State</label><select class="input" id="tf-state" name="state" aria-describedby="tf-state-help">${states.map(value => `<option ${value === ticket.state ? "selected" : ""}>${value}</option>`).join("")}</select><p class="help" id="tf-state-help">To resolve, use the Resolution tab.</p></div>
    </div>
    <div class="row"><button class="btn btn-primary" type="submit">Save ticket</button><span class="badge badge--high" id="ticketDirtyNote" hidden>◆ Unsaved changes</span><p class="form-status" id="ticketFormStatus" role="status"></p></div>
  </form>`;
}

function followupPanels(item) {
  return `<section class="stack" aria-label="Follow-up"><div class="tabs" role="tablist" aria-label="Follow-up"><button type="button" role="tab" id="fu-activity-tab" aria-controls="fu-activity" aria-selected="true">Work notes</button><button type="button" role="tab" id="fu-resolution-tab" aria-controls="fu-resolution" aria-selected="false" tabindex="-1">Resolution</button></div><div id="fu-activity" role="tabpanel" aria-labelledby="fu-activity-tab">${activityPanel(item)}</div><div id="fu-resolution" role="tabpanel" aria-labelledby="fu-resolution-tab" hidden>${resolutionPanel(item)}</div></section>`;
}

function formatActivityFields(text) {
  const fields = /^(Short description|Description|Category|Subcategory|Service|Priority|Assignment group|Assigned to|State|Resolution notes|Resolution)(\s*:.*)$/i;
  return text.split('\n').map(line => { const match=line.match(fields); return match ? `<strong class="activity-field-name">${esc(match[1])}</strong>${esc(match[2])}` : esc(line); }).join('\n');
}

function activityPanel(item) {
  const customer = state.user?.role === 'customer';
  const tone = {Customer: 'badge--medium', Technician: 'badge--ok', System: 'badge--low'};
  // Customers see the conversation with their technician; system logs and AI analysis notes are for staff.
  const notes = item.ticket.work_notes.filter(note => !customer || note.author_type !== 'System').slice().sort((left, right) => new Date(right.created_at) - new Date(left.created_at)).map(note => `<li class="note"><div class="note__head"><strong>${esc(note.author)}</strong><span class="badge ${tone[note.author_type] || 'badge--low'}">${esc(note.author_type)}</span><time class="help" datetime="${esc(note.created_at)}">${esc(when(note.created_at))}</time></div><p class="pre">${note.author_type === "System" ? formatActivityFields(note.text) : esc(note.text)}</p></li>`).join("");
  const title = customer ? 'Comments' : 'Activity and work notes';
  return `<section class="card stack" aria-labelledby="activityTitle"><h2 class="h3" id="activityTitle">${title}</h2>
    <form id="workNoteForm" class="stack stack--sm" novalidate><div class="field field--inline"><label for="workNoteText">${customer ? 'Add a comment' : 'Add a work note'}</label><textarea class="input" id="workNoteText" name="text" rows="3" maxlength="4000" required aria-describedby="workNoteHelp workNoteMessage" placeholder="${customer ? 'Add details, answer a question, or tell us what changed' : 'Progress, troubleshooting steps, or customer feedback'}"></textarea><p class="help" id="workNoteHelp">${customer ? 'Your technician sees this on the incident.' : 'Visible to the customer and the service team.'}</p></div>
    <div class="row"><button class="btn ${customer ? 'btn-primary' : 'btn-soft'}" type="submit">${customer ? 'Add comment' : 'Add work note'}</button><p class="form-status" id="workNoteMessage" data-activity-message role="status"></p></div></form>
    ${notes ? `<ol class="notes" aria-label="${title}, newest first">${notes}</ol>` : `<p class="sec">${customer ? 'No comments yet.' : 'No activity yet.'}</p>`}</section>`;
}

function transcriptTurns(turns, fallbackName = () => '') {
  return `<div class="turns" tabindex="0" aria-label="Transcript">${turns.map(turn => `<div class="turn"><span class="turn__who">${esc(turn.speaker)}${turn.speaker_name || fallbackName(turn) ? ` · ${esc(turn.speaker_name || fallbackName(turn))}` : ''}${turn.timestamp ? `<time>${esc(new Date(turn.timestamp).toLocaleTimeString())}</time>` : ''}</span><p>${esc(turn.text)}</p></div>`).join('')}</div>`;
}
function transcriptPanel(item) {
  if (!item.transcript.length) return '';
  return `<section class="card" aria-label="Source conversation"><details><summary>Source conversation · <span class="mono">${esc(item.ticket.call_id || 'Recorded intake')}</span>&nbsp;· ${item.transcript.length} ${item.transcript.length === 1 ? 'turn' : 'turns'}</summary><p class="help">Technician: ${esc(item.ticket.assigned_to || 'Not assigned')} · Customer: ${esc(item.caller)}</p>${transcriptTurns(item.transcript)}</details></section>`;
}

function resolutionPanel(item) {
  const resolved = item.ticket.state === "Resolved";
  return `<section class="card stack" aria-labelledby="resolutionPanelTitle"><h2 class="h3" id="resolutionPanelTitle">Resolution</h2><form id="resolutionForm" class="stack stack--sm" novalidate><div class="field field--inline"><label for="resolutionText">Resolution details</label><textarea class="input" id="resolutionText" name="resolution" rows="7" required aria-describedby="resolutionHelp resolutionMessage" placeholder="One step per line, e.g.&#10;Cleared the stuck print queue&#10;Restarted the printer&#10;Customer confirmed a test page printed">${esc(item.ticket.resolution)}</textarea><p class="help" id="resolutionHelp">${resolved ? 'Visible to the customer, and saved as knowledge the AI reuses.' : 'Write each step on its own line. Resolving shows these notes to the customer, starts AI QA, and saves your fix as knowledge so the AI can solve the same problem next time. Don’t include passwords or personal details.'}</p></div><div class="row"><button class="btn btn-primary" type="submit">${resolved ? "Save resolution notes" : "Resolve ticket"}</button><p class="form-status" id="resolutionMessage" data-resolution-message role="status"></p></div></form></section>`;
}

function setFormStatus(box, text, error = false) { box.className = `form-status${error ? ' err' : ''}`; box.textContent = text; }

async function saveTicket(form) {
  const editingTicketDetails = $("#view-ticket-detail").classList.contains("active");
  const values = Object.fromEntries(new FormData(form).entries());
  const status = $('#ticketFormStatus'), button = form.querySelector('[type=submit]');
  for (const field of ["category", "subcategory", "service", "assignment_group"]) {
    const customField = `${field}_other`;
    if (values[field] === "Other") values[field] = (values[customField] || "").trim();
    delete values[customField];
  }
  if (!values.short_description?.trim()) { setFormStatus(status, '✕ Short description can’t be empty.', true); form.elements.short_description.setAttribute('aria-invalid', 'true'); form.elements.short_description.focus(); return; }
  if (!form.reportValidity()) return;
  if (values.state !== "Resolved") values.resolution = "";
  button.disabled = true; button.setAttribute('aria-busy', 'true'); setFormStatus(status, 'Saving…');
  try {
    state.current = await api(`/api/cases/${state.current.id}/ticket`, { method: "PATCH", body: JSON.stringify(values) });
    window.ResolveDirty.mark('ticket', false);
    state.reviewed.add(state.current.id);
    if (editingTicketDetails) await openTicketDetails(state.current.id, {keepScroll: true}); else renderCase(state.current);
    toast(`${state.current.ticket.id} saved.`);
  } catch (error) { setFormStatus(status, `✕ Not saved: ${error.message}`, true); button.disabled = false; button.removeAttribute('aria-busy'); }
}

async function addWorkNote(form) {
  const editingTicketDetails = $("#view-ticket-detail").classList.contains("active");
  const values = Object.fromEntries(new FormData(form).entries());
  const message = form.querySelector("[data-activity-message]"), button = form.querySelector('[type=submit]');
  if (!values.text?.trim()) { message.className = "form-status err"; message.textContent = "✕ Write something before adding it."; form.elements.text.setAttribute('aria-invalid', 'true'); form.elements.text.focus(); return; }
  message.className = "form-status"; message.textContent = "Adding…"; button.disabled = true; button.setAttribute('aria-busy', 'true');
  try {
    state.current = await api(`/api/cases/${state.current.id}/work-notes`, { method: "POST", body: JSON.stringify(values) });
    if (editingTicketDetails) await openTicketDetails(state.current.id, {keepScroll: true}); else renderCase(state.current);
    toast(state.user?.role === 'customer' ? "Comment added." : "Work note added.");
    $('#workNoteText')?.focus();
  } catch (error) { message.className = "form-status err"; message.textContent = `✕ ${error.message}`; button.disabled = false; button.removeAttribute('aria-busy'); }
}

async function saveResolution(form) {
  const message = form.querySelector("[data-resolution-message]"), button = form.querySelector('[type=submit]');
  const resolution = new FormData(form).get("resolution").trim();
  if (!resolution) { setFormStatus(message, "✕ Add the resolution details before resolving.", true); form.elements.resolution.setAttribute('aria-invalid', 'true'); form.elements.resolution.focus(); return; }
  button.disabled = true; button.setAttribute('aria-busy', 'true'); setFormStatus(message, "Resolving…");
  try {
    state.current = await api(`/api/cases/${state.current.id}/ticket`, { method: "PATCH", body: JSON.stringify({ state: "Resolved", resolution }) });
    window.ResolveDirty.mark('ticket', false);
    if ($("#view-ticket-detail").classList.contains("active")) await openTicketDetails(state.current.id, {keepScroll: true});
    else renderCase(state.current);
    toast(`${state.current.ticket.id} resolved. AI QA is running.`);
  } catch (error) { setFormStatus(message, `✕ Not resolved: ${error.message}`, true); button.disabled = false; button.removeAttribute('aria-busy'); }
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

const QA_RESULT = {PASS: ['badge--ok', '✓ Pass'], WARN: ['badge--high', '◆ Check'], FAIL: ['badge--err', '✕ Fail']};
function qaBadge(item) {
  if (item.quality_score == null) return '<span class="badge badge--muted">○ Pending</span>';
  const stale = visibleAuditChecks(item.qa_checks).legacy;
  return `<span class="badge ${item.quality_score >= 80 ? 'badge--ok' : 'badge--high'}">${item.quality_score >= 80 ? '✓' : '◆'} ${item.quality_score}%</span>${stale ? ' <span class="badge badge--high">◆ Out of date</span>' : ''}`;
}

function renderQA(item) {
  ++ticketQaRequest;
  $("#ticketQaPagination").hidden = true;
  $("#ticketQaSummary").hidden = true;
  if (state.user?.role !== 'admin' && item.ticket.assigned_user_id !== state.user?.id) {
    showView('qa'); showFeedback('You can review audits only for tickets assigned to you.'); return;
  }
  if (!$('#view-qa').classList.contains('active')) showView('qa');
  state.current = item; state.qaDetail = item.id;
  selectReportTab("qa", "tickets", false); refreshBulkQA();
  const head = `<div class="row row--between"><button type="button" class="link link--back" data-qa-back>All ticket audits</button></div>
    <div class="section-head section-head--tight"><div><p class="kicker"><span class="mono">${esc(item.ticket.id)}</span>${item.ticket.call_id ? ` · call <span class="mono">${esc(item.ticket.call_id)}</span>` : ''}</p><h2 id="qaDetailTitle" tabindex="-1">${esc(item.issue_title)}</h2></div>${qaBadge(item)}</div>`;
  let body;
  if (item.ticket.state !== "Resolved") body = `<p class="sec">Resolve ${esc(item.ticket.id)} first. QA audits the completed incident record.</p>`;
  else if (item.quality_score == null) body = `<p class="sec">● AI QA is running in the background for ${esc(item.ticket.id)}. Check back shortly.</p><div><button type="button" class="btn btn-soft" id="rerunQa">Run QA now</button></div><p class="form-status" id="rerunQaMessage" role="status"></p>`;
  else {
    const audit = visibleAuditChecks(item.qa_checks);
    const lines = value => esc(value).replace(/\n/g, '<br>');
    body = `${audit.legacy ? '<div class="alert alert--info" role="status"><strong>◆ Out of date.</strong><span class="sec">This score uses an earlier audit format. Rerun QA to refresh it.</span></div>' : ''}
      <ul class="checks">${audit.checks.map(check => { const [tone, label] = QA_RESULT[check.result] || ['badge--muted', `○ ${check.result}`]; return `<li class="panel-block stack stack--sm"><div class="row row--between"><h3 class="h4">${esc(check.field)}</h3><span class="badge ${tone}">${label}</span></div><dl class="kv"><div><dt>Observed</dt><dd>${lines(check.observed)}</dd></div><div><dt>Recommended</dt><dd>${lines(check.recommended)}</dd></div></dl><p class="help" data-detail>Evidence: ${lines(check.evidence)}</p></li>`; }).join('') || '<li class="sec">No checks returned.</li>'}</ul>
      <div class="row"><button type="button" class="btn btn-primary" id="rerunQa">Rerun AI QA</button><p class="form-status" id="rerunQaMessage" role="status"></p></div>`;
  }
  $("#qaWorkspace").innerHTML = `<section class="card stack" aria-labelledby="qaDetailTitle">${head}<p class="help">AI compares the resolved ticket with its source conversation. A reviewer decides what to change.</p>${body}</section>`;
  $('#qaDetailTitle').focus();
}

async function rerunQA() {
  if (!state.current) return;
  const button = $("#rerunQa"), message = $('#rerunQaMessage');
  button.disabled = true; button.setAttribute('aria-busy', 'true'); setFormStatus(message, 'Auditing…');
  try { state.current = await api(`/api/cases/${state.current.id}/qa`, { method: "POST", body: "{}" }); renderQA(state.current); toast(`AI QA updated for ${state.current.ticket.id}.`); }
  catch (error) { setFormStatus(message, `✕ Audit failed: ${error.message}`, true); button.disabled = false; button.removeAttribute('aria-busy'); }
}

const TICKET_QA_FIELDS = ['Short description', 'Description', 'Category / Subcategory', 'Service', 'Priority', 'Assignment group', 'Resolution', 'Work notes'];
const QA_FIELD_POINTS = {PASS:100, WARN:50, FAIL:0};
function qaMean(values) { const scores = values.filter(value => typeof value === 'number' && Number.isFinite(value)); return scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length*10)/10 : null; }
function qaMetric(label, value, count, suffix = '%') {
  return `<div class="qa-metric"><span class="help">${esc(label)}</span><strong>${value === null ? '—' : esc(value)+suffix}</strong><small class="help">${count} scored</small></div>`;
}
function prepareQaFilters(prefix, technicians, services) {
  const admin = state.user?.role === 'admin';
  $('#'+prefix+'TechnicianWrap').hidden = !admin;
  analyticsOptions('#'+prefix+'TechnicianFilter', technicians, 'All technicians');
  analyticsOptions('#'+prefix+'ServiceFilter', services, 'All services');
  if (!admin) $('#'+prefix+'TechnicianFilter').value = '';
  return {technician:admin ? $('#'+prefix+'TechnicianFilter').value : '', service:$('#'+prefix+'ServiceFilter').value};
}
function ticketQaMetrics(items) {
  const scored = items.filter(item => typeof item.quality_score === 'number' && !visibleAuditChecks(item.qa_checks).legacy);
  const fields = Object.fromEntries(TICKET_QA_FIELDS.map(field=>[field,[]]));
  for (const item of scored) {
    for (const check of visibleAuditChecks(item.qa_checks).checks) {
      const field = TICKET_QA_FIELDS.find(field=>field.toLowerCase().replace(/[^a-z]/g,'')===check.field.toLowerCase().replace(/[^a-z]/g,'').replace('resolutionnotes','resolution'));
      if(field && check.result in QA_FIELD_POINTS) fields[field].push(QA_FIELD_POINTS[check.result]);
    }
  }
  return {count:scored.length, overall:qaMean(scored.map(item=>item.quality_score)), fields};
}
let ticketQaCases = [], ticketQaRequest = 0;
const ticketQaPager = {page:1, key:null};
async function loadQA() {
  if (state.qaDetail) return;
  const request = ++ticketQaRequest;
  const box = $('#qaWorkspace'), userId = state.user?.id;
  if (!box.querySelector('table')) box.innerHTML = '<div class="stack" role="status" aria-label="Loading audits"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div></div>';
  let cases;
  try { cases = await api('/api/reporting/tickets'); if (state.qaDetail) return; }
  catch (error) { if (state.qaDetail) return; box.innerHTML = `<div class="alert" role="alert"><strong>✕ Couldn’t load ticket audits.</strong><span class="sec">${esc(error.message)}</span><button type="button" class="btn btn-soft btn-sm" data-retry-qa>Retry</button></div>`; return; }
  if (state.user?.id !== userId || request !== ticketQaRequest) return;
  const resolved = cases.filter(item => item.ticket.state === "Resolved");
  state.qaResolvedCount = resolved.length;
  refreshBulkQA();
  ticketQaCases = resolved;
  renderTicketQAList();
}
function renderTicketQAList() {
  $('#ticketQaSummary').hidden = false;
  const {technician, service} = prepareQaFilters('ticketQa', ticketQaCases.map(item=>item.ticket.assigned_to || 'Unassigned'), ticketQaCases.map(item=>item.ticket.service || 'General'));
  const resolved = ticketQaCases.filter(item=>(!technician || (item.ticket.assigned_to || 'Unassigned')===technician) && (!service || (item.ticket.service || 'General')===service)), box = $('#qaWorkspace');
  const summary = ticketQaMetrics(resolved);
  $('#ticketQaMetrics').innerHTML = qaMetric('Overall average', summary.overall, summary.count) + TICKET_QA_FIELDS.map(field=>qaMetric(field,qaMean(summary.fields[field]),summary.fields[field].length)).join('');
  $('#ticketQaCoverage').textContent = `All filtered results · ${summary.count} audited of ${resolved.length} resolved tickets. Pending / outdated audits excluded. Field averages: Pass 100, Check 50, Fail 0; missing fields excluded.`;
  $('#ticketQaCount').textContent = `${resolved.length} of ${ticketQaCases.length} tickets`;
  const page = paginateItems(resolved, ticketQaPager, JSON.stringify([state.user?.id, technician, service]), '#ticketQaPagination');
  box.innerHTML = resolved.length ? `<div class="tbl-wrap" role="region" aria-label="Ticket audits" tabindex="0"><table class="tbl"><caption class="sr">Resolved tickets and their QA status</caption><thead><tr><th scope="col">Ticket</th><th scope="col">Issue</th><th scope="col" class="col-opt">Service</th><th scope="col">QA</th><th scope="col"><span class="sr">Action</span></th></tr></thead><tbody>${page.map(item => `<tr><td><span class="mono">${esc(item.ticket.id)}</span></td><td>${esc(item.ticket.short_description)}${exampleTag(item)}</td><td class="col-opt">${esc(item.ticket.service)}</td><td>${qaBadge(item)}</td><td><button type="button" class="link" data-qa-case-id="${esc(item.id)}"><span>Review<span class="sr"> audit for ${esc(item.ticket.id)}</span></span></button></td></tr>`).join("")}</tbody></table></div>`
    : ticketQaCases.length ? '<p class="sec">No resolved tickets match these filters.</p>' : '<div class="empty"><h2 class="h3">No resolved tickets yet</h2><p class="sec">Resolved tickets appear here straight away while AI QA runs in the background.</p></div>';
}

['ticketQaTechnicianFilter','ticketQaServiceFilter'].forEach(id=>$('#'+id).addEventListener('change',renderTicketQAList));
$('#ticketQaClear').addEventListener('click',()=>{ $('#ticketQaTechnicianFilter').value=''; $('#ticketQaServiceFilter').value=''; renderTicketQAList(); });

function jobProgress(bar, job) { bar.hidden = job.status !== 'running'; bar.max = Math.max(1, job.total); bar.value = job.completed + job.failed + job.skipped; }
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
    $('#rerunAllQa').toggleAttribute('aria-busy', running);
    $('#rerunAllQa').textContent = running ? 'Audits running…' : 'Rerun all audits';
    jobProgress($('#bulkQaProgress'), job);
    $('#bulkQaStatus').textContent = job.status === 'idle' ? 'Reruns AI QA for every resolved ticket you can see.' :
      `${running ? '● Auditing' : job.failed ? '◆ Finished with problems' : '✓ Finished'}: ${job.completed} done, ${job.failed} failed, ${job.skipped} skipped of ${job.total}.${job.skipped ? ' Skipped tickets changed during the audit or are no longer resolved.' : ''}${job.failed ? ' Check the AI connection, then rerun to retry the failed ones.' : ''}`;
    const finished = lastBulkQaStatus === 'running' && !running;
    lastBulkQaStatus = job.status;
    if (running && $('#view-qa').classList.contains('active')) bulkQaTimer = setTimeout(refreshBulkQA, 2000);
    if (finished && $('#view-qa').classList.contains('active') && !$('#qaDetailTitle')) await loadQA();
  } catch (error) { $('#bulkQaStatus').textContent = `✕ ${error.message}`; $('#rerunAllQa').disabled = false; }
}
$('#rerunAllQa').addEventListener('click', async () => {
  const button = $('#rerunAllQa'); button.disabled = true;
  try {
    await api('/api/qa/rerun-all', {method:'POST', body:'{}'});
    lastBulkQaStatus = 'running';
    await refreshBulkQA();
  } catch(error) { $('#bulkQaStatus').textContent = `✕ ${error.message}`; button.disabled = false; }
});
document.addEventListener('click', event => {
  if (event.target.closest('[data-qa-back]')) { state.current = null; state.qaDetail = null; loadQA(); }
  if (event.target.closest('[data-retry-qa]')) loadQA();
});

let ticketPage = 1, ticketFilterKey = null;
const PAGE_SIZE = 10;
function updatePagination(id, page, total, size = PAGE_SIZE) {
  const count = Math.max(1, Math.ceil(total / size));
  const host = $(id);
  host.hidden = total <= size;
  host.innerHTML = `<span class="help" role="status" aria-live="polite">${total ? (page-1)*size+1 : 0}–${Math.min(page*size,total)} of ${total} · page ${page} of ${count}</span><button type="button" class="btn btn-soft btn-sm" data-page-step="-1" ${page === 1 ? "disabled" : ""}><span aria-hidden="true">‹</span> Previous</button><button type="button" class="btn btn-soft btn-sm" data-page-step="1" ${page === count ? "disabled" : ""}>Next <span aria-hidden="true">›</span></button>`;
}

function paginateItems(items, pager, key, target, size = PAGE_SIZE) {
  if(pager.key !== key) {pager.page=1;pager.key=key;}
  pager.page=Math.max(1,Math.min(pager.page,Math.max(1,Math.ceil(items.length/size))));
  updatePagination(target,pager.page,items.length,size);
  return items.slice((pager.page-1)*size,pager.page*size);
}
function bindPagination(target,pager,render) {
  $(target).addEventListener('click',event=>{
    const button=event.target.closest('[data-page-step]');
    if(button && !button.disabled){pager.page+=Number(button.dataset.pageStep);render();}
  });
}
bindPagination('#ticketQaPagination',ticketQaPager,renderTicketQAList);

async function loadCases() {
  const userId = state.user?.id, first = !state.cases.length;
  $('#ticketsLoadError').hidden = true;
  $('#ticketsLoading').hidden = !first;
  if (first) { $('#ticketsTable').hidden = true; $('#ticketsEmpty').hidden = true; }
  try {
    const cases = await api('/api/cases');
    if (state.user?.id !== userId) return;
    state.cases = cases;
    const select = $('#ticketAssignee'), selected = select.value;
    const names = [...new Set(cases.map(item => item.ticket.assigned_to).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    select.innerHTML = '<option value="">Anyone</option><option value="__unassigned__">Unassigned</option>' + names.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');
    select.value = [...select.options].some(option=>option.value===selected) ? selected : '';
    renderTickets();
  } catch (error) {
    $('#ticketsLoadErrorMessage').textContent = error.message;
    $('#ticketsLoadError').hidden = false;
  } finally { $('#ticketsLoading').hidden = true; }
}
$('#retryTickets').addEventListener('click', loadCases);

const TICKET_FILTERS = [['ticketSearch', 'Search'], ['ticketAssignee', 'Assigned to'], ['ticketStateFilter', 'State'], ['ticketPriorityFilter', 'Priority']];
function renderTickets() {
  const term = $('#ticketSearch').value.trim().toLowerCase(), assignee = $('#ticketAssignee').value;
  const status = $('#ticketStateFilter').value, priority = $('#ticketPriorityFilter').value;
  const cases = state.cases.filter(item => (!term || `${item.ticket.id} ${item.ticket.short_description}`.toLowerCase().includes(term)) &&
    (!status || item.ticket.state === status) && (!priority || item.ticket.priority === priority) &&
    (!assignee || (assignee === '__unassigned__' ? !item.ticket.assigned_to : item.ticket.assigned_to === assignee)));
  const key = JSON.stringify([state.user?.id, term, assignee, status, priority, $('#ticketSort').dataset.direction]);
  if (key !== ticketFilterKey) { ticketPage = 1; ticketFilterKey = key; }
  const newest = $('#ticketSort').dataset.direction !== 'oldest';
  cases.sort((a, b) => newest ? new Date(b.created_at) - new Date(a.created_at) : new Date(a.created_at) - new Date(b.created_at));
  const active = TICKET_FILTERS.filter(([id]) => $('#' + id).value);
  $('#ticketChips').innerHTML = active.map(([id, label]) => { const el = $('#' + id), shown = el.tagName === 'SELECT' ? el.selectedOptions[0].textContent : `“${el.value}”`; return `<button type="button" class="chip" data-clear-filter="${id}"><span>${label}: ${esc(shown)} <span aria-hidden="true">✕</span><span class="sr">, remove filter</span></span></button>`; }).join('');
  $('#clearTicketFilters').hidden = !active.length;
  $('#ticketResultCount').textContent = `${cases.length} of ${state.cases.length} tickets`;
  const empty = $('#ticketsEmpty');
  $('#ticketsTable').hidden = !cases.length;
  empty.hidden = cases.length > 0;
  empty.innerHTML = state.cases.length
    ? '<h2 class="h3">No tickets match these filters</h2><p class="sec">Try a different search, or clear the filters.</p><div><button type="button" class="btn btn-soft" data-clear-all-filters>Clear filters</button></div>'
    : '<h2 class="h3">No tickets yet</h2><p class="sec">Incidents reported by customers, calls and conversation intake appear here. Use New case above to analyze a conversation.</p>';
  ticketPage = Math.min(ticketPage, Math.max(1, Math.ceil(cases.length / PAGE_SIZE)));
  updatePagination('#ticketPagination', ticketPage, cases.length);
  $('#ticketRows').innerHTML = cases.slice((ticketPage-1)*PAGE_SIZE, ticketPage*PAGE_SIZE).map(item => `<tr><td>${incidentLink(item)}</td><td>${esc(item.ticket.short_description)}${exampleTag(item)}</td><td class="col-opt">${esc(item.ticket.service)}</td><td>${priorityBadge(item.ticket.priority)}</td><td class="col-opt">${esc(item.ticket.assigned_to || 'Unassigned')}</td><td>${stateBadge(item.ticket.state)}</td></tr>`).join('');
}
$('#ticketPagination').addEventListener('click', event => { const button=event.target.closest('[data-page-step]'); if(button && !button.disabled) { ticketPage+=Number(button.dataset.pageStep); renderTickets(); } });
$('#ticketSearch').addEventListener('input', renderTickets);
['#ticketAssignee', '#ticketStateFilter', '#ticketPriorityFilter'].forEach(id => $(id).addEventListener('change', renderTickets));
$('#ticketSort').addEventListener('click', () => { toggleTimeSort($('#ticketSort'), 'Ticket'); renderTickets(); });
function clearTicketFilters() { TICKET_FILTERS.forEach(([id]) => { $('#' + id).value = ''; }); renderTickets(); $('#ticketSearch').focus(); }
$('#clearTicketFilters').addEventListener('click', clearTicketFilters);
document.addEventListener('click', event => {
  const chip = event.target.closest('[data-clear-filter]');
  if (chip) { $('#' + chip.dataset.clearFilter).value = ''; renderTickets(); ($('#ticketChips button') || $('#ticketSearch')).focus(); }
  if (event.target.closest('[data-clear-all-filters]')) clearTicketFilters();
});

function staffTicketDetails(item) {
  const t = item.ticket, admin = state.user?.role === 'admin', resolved = t.state === 'Resolved';
  const canAudit = admin || t.assigned_user_id === state.user?.id;
  return `<div class="page-head"><div><p class="kicker"><span class="mono">${esc(t.id)}</span>${t.call_id ? ` · call <span class="mono">${esc(t.call_id)}</span>` : ''}</p><h1 id="ticketDetailTitle" tabindex="-1">${esc(t.short_description)}</h1></div><div class="row row--sm">${priorityBadge(t.priority)}${stateBadge(t.state)}${exampleTag(item)}<button type="button" class="btn btn-soft btn-sm" data-enter-time-machine="${esc(item.id)}">Enter Time Machine <span aria-hidden="true">→</span></button></div></div>
  <div class="detail-grid">
    <div class="stack stack--lg">
      <section class="card stack" aria-labelledby="fieldsTitle"><h2 class="h3" id="fieldsTitle">Ticket fields</h2>${ticketForm(item)}</section>
      ${followupPanels(item)}
      ${renderAttachments(t.attachments, false, t)}${renderVisualAnalysis(t, item.id)}${staffAssist(item)}${transcriptPanel(item)}
    </div>
    <aside class="stack detail-aside" aria-label="Ticket summary">
      <section class="card stack stack--sm" aria-labelledby="assignTitle"><h2 class="h4" id="assignTitle">Assignment</h2><p>${esc(t.assigned_to || 'Unassigned')}</p><p class="help">${esc(t.assignment_group)}</p><p class="help">${admin ? 'Change it in Ticket fields.' : 'Only administrators can reassign tickets.'}</p></section>
      <section class="card stack stack--sm" aria-labelledby="qaTitle"><h2 class="h4" id="qaTitle">Quality audit</h2>${item.quality_score == null ? `<span class="badge badge--muted">○ ${resolved ? 'Audit running or pending' : 'Not audited yet'}</span>` : `<span class="badge ${item.quality_score >= 80 ? 'badge--ok' : 'badge--high'}">${item.quality_score >= 80 ? '✓' : '◆'} ${item.quality_score}%</span>`}<p class="help">${resolved ? 'AI QA compares the resolved ticket with the source conversation.' : 'AI QA runs after the ticket is resolved.'}</p>${resolved && canAudit ? '<div><button type="button" class="link" data-open-qa>Open audit</button></div>' : ''}</section>
    </aside>
  </div>`;
}

async function openTicketDetails(caseId, {keepScroll = false} = {}) {
  const customer = state.user?.role === 'customer';
  try {
    if (state.user?.role === 'admin') state.users = await api('/api/users');
    state.current = await api(`/api/cases/${encodeURIComponent(caseId)}`);
  } catch (error) {
    if ([403, 404].includes(error.status)) { $('#notFoundMessage').textContent = 'This incident doesn’t exist, or it isn’t visible to your account.'; showView('notfound'); return; }
    throw error;
  }
  showView("ticket-detail");
  window.ResolveDirty?.mark('ticket', false);
  $('#caseResult').innerHTML = ''; $('#caseResult').hidden = true;
  const detail = $("#ticketDetailPage");
  $('#ticketDetailBack').dataset.view = customer ? 'customer-home' : 'tickets';
  $('#ticketDetailBack').setAttribute('href', customer ? '/portal' : `${window.Shell.home(state.user.role)}?view=tickets`);
  $('#ticketDetailBack').lastChild.textContent = customer ? ' Back to My support' : ' Back to tickets';
  detail.innerHTML = customer ? customerTicketDetails(state.current) : staffTicketDetails(state.current);
  document.title = `${state.current.ticket.id} · ResolveAI`;
  if (!keepScroll) { window.scrollTo({top: 0}); $('#ticketDetailTitle')?.focus({preventScroll: true}); }
  watchAssist(state.current, fresh => { if ($('#view-ticket-detail').classList.contains('active') && state.current?.id === fresh.id && !window.ResolveDirty?.isDirty?.()) openTicketDetails(fresh.id, {keepScroll: true}); });
  // Resolution durability (from main's Resolution Debt Radar) is staff-only.
  $('#ticketDurability').hidden = customer;
  if (!customer) window.loadCaseResolutionRadar?.(state.current.id);
}

async function openCase(caseId, target = "case") {
  state.current = await api(`/api/cases/${caseId}`);
  if (target === "qa") renderQA(state.current); else { showView("case"); renderCase(state.current); }
}

function groupedCounts(values) {
  return values.reduce((counts, value) => { const key = value || "Unspecified"; counts[key] = (counts[key] || 0) + 1; return counts; }, {});
}

function renderAnalyticsBars(target, counts, total, unit = 'incidents') {
  const caption = $(target).closest('article')?.querySelector('h2')?.textContent || 'Distribution';
  $(target).innerHTML = barChart(counts, {caption, unit, id: target.slice(1)});
}

function analyticsOptions(selector, values, label) {
  const select=$(selector), selected=select.value;
  select.innerHTML=`<option value="">${esc(label)}</option>`+[...new Set(values)].sort().map(value=>`<option value="${esc(value)}">${esc(value)}</option>`).join('');
  select.value=[...select.options].some(option=>option.value===selected)?selected:'';
}
let analyticsCases=[];
async function loadAnalytics() {
  const userId = state.user?.id;
  $('#analyticsScope').textContent = state.user?.role === 'admin' ? 'Ticket and call performance across the whole workspace, all time.' : 'Ticket and call performance for records assigned to you, all time.';
  $('#ticketAnalyticsError').hidden = true;
  try {
    const cases = await api('/api/reporting/tickets');
    if (state.user?.id !== userId) return;
    analyticsCases = cases;
    analyticsOptions('#ticketAnalyticsTechnicianFilter', cases.map(item => item.ticket.assigned_to || 'Unassigned'), 'All technicians');
    analyticsOptions('#ticketAnalyticsServiceFilter', cases.map(item => item.ticket.service || 'Unspecified'), 'All services');
    renderTicketAnalytics();
  } catch (error) { $('#ticketAnalyticsErrorMessage').textContent = error.message; $('#ticketAnalyticsError').hidden = false; }
}
document.addEventListener('click', event => { const retry = event.target.closest('[data-retry-analytics]'); if (retry) loadAnalytics(); });
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
  $("#analyticsQAHelp").textContent = scored.length ? `Percent · mean of ${scored.length} audited, resolved incident${scored.length === 1 ? '' : 's'}` : 'No audited incidents in this selection';
  renderAnalyticsBars("#serviceVolume", serviceCounts, cases.length);
  renderAnalyticsBars("#stateDistribution", groupedCounts(cases.map(item => item.ticket.state)), cases.length);
  renderAnalyticsBars("#priorityDistribution", groupedCounts(cases.map(item => item.ticket.priority)), cases.length);
  renderAnalyticsBars("#routingDistribution", groupedCounts(cases.map(item => `${item.routing.handler} handled`)), cases.length);
  const services = Object.keys(serviceCounts).sort((left, right) => serviceCounts[right] - serviceCounts[left]);
  $("#serviceAnalyticsEmpty").hidden = services.length > 0;
  $("#serviceAnalyticsEmpty").textContent = analyticsCases.length ? "No tickets match these filters." : "No incidents yet.";
  $("#serviceAnalyticsRows").closest('.tbl-wrap').hidden = !services.length;
  $("#serviceAnalyticsRows").innerHTML = paginateItems(services, servicePager, JSON.stringify([state.user?.id, services]), "#serviceAnalyticsPagination").map(service => {
    const items = cases.filter(item => (item.ticket.service || "Unspecified") === service); const serviceResolved = items.filter(item => item.ticket.state === "Resolved"); const serviceScores = serviceResolved.map(item => item.quality_score).filter(value => value != null);
    return `<tr><th scope="row">${esc(service)}</th><td>${items.length}</td><td>${items.length - serviceResolved.length}</td><td>${serviceResolved.length}</td><td class="col-opt">${items.filter(item => item.routing.handler === "AI").length}</td><td>${serviceScores.length ? `${Math.round(serviceScores.reduce((sum, value) => sum + value, 0) / serviceScores.length)}%` : "—"}</td></tr>`;
  }).join("");
}

['Id','Technician','Service'].forEach(field=>$('#ticketAnalytics'+field+'Filter').addEventListener(field==='Id'?'input':'change',renderTicketAnalytics));
const servicePager = {page: 1, key: null};
bindPagination('#serviceAnalyticsPagination', servicePager, () => renderTicketAnalytics());
$('#ticketAnalyticsResetFilters').addEventListener('click',()=>{['Id','Technician','Service'].forEach(field=>$('#ticketAnalytics'+field+'Filter').value='');renderTicketAnalytics();});

async function loadKnowledge() {
  const customer = state.user?.role === 'customer';
  $('#knowledgeKicker').textContent = customer ? 'Help' : 'Knowledge';
  $('#knowledgeTitle').textContent = customer ? 'Help articles' : 'Knowledge articles';
  $('#knowledgeIntro').textContent = customer ? 'Step-by-step fixes for common problems. Still stuck? Report an issue from My support.' : 'Guidance AI retrieves during analysis and calls. Technicians check it before use.';
  $('#knowledgeActions').hidden = customer;
  $('#knowledgeError').hidden = true; $('#knowledgeLoading').hidden = state.knowledge.length > 0;
  try { state.knowledge = await api("/api/knowledge"); renderKnowledge($("#knowledgeSearch").value); }
  catch (error) { $('#knowledgeErrorMessage').textContent = error.message; $('#knowledgeError').hidden = false; }
  finally { $('#knowledgeLoading').hidden = true; }
}
$('#retryKnowledge').addEventListener('click', loadKnowledge);

const knowledgePager = {page:1,key:null};
bindPagination('#knowledgePagination',knowledgePager,()=>renderKnowledge($("#knowledgeSearch").value));
function renderKnowledge(query = "") {
  const term = query.trim().toLowerCase();
  const articles = state.knowledge.filter(article => !term || [article.id, article.title, article.product, article.symptoms, article.tags.join(" "), article.steps.join(" ")].join(" ").toLowerCase().includes(term));
  const page = paginateItems(articles, knowledgePager, JSON.stringify([state.user?.id,term]), '#knowledgePagination');
  $('#knowledgeCount').textContent = term ? `${articles.length} of ${state.knowledge.length} articles match` : `${state.knowledge.length} published articles`;
  const staff = state.user?.role !== 'customer';
  $("#knowledgeList").innerHTML = articles.length ? page.map(article => `<article class="card stack stack--sm" aria-labelledby="kb-${esc(article.id)}"><div class="row row--between"><h2 class="h3" id="kb-${esc(article.id)}">${esc(article.title)}</h2><span class="badge badge--ok">✓ Published</span></div>
      <p class="help"><span class="mono">${esc(article.id)}</span> · ${esc(article.product)}${article.tags.length ? ` · ${esc(article.tags.join(', '))}` : ''}</p><p class="sec">${esc(article.symptoms)}</p>
      <details><summary>Steps (${article.steps.length})</summary><ol class="plain-steps">${article.steps.map(step => `<li>${esc(step)}</li>`).join("")}</ol><p class="small"><strong>Expected result:</strong> ${esc(article.resolution)}</p>${staff && article.source_ticket_ids?.length ? `<p class="help">Drafted from: ${article.source_ticket_ids.map(number => `<button type="button" class="link" data-source-ticket="${esc(number)}">${esc(number)}</button>`).join(" ")}</p>` : ""}</details></article>`).join("")
    : state.knowledge.length ? `<div class="empty"><h2 class="h3">No articles match “${esc(query)}”</h2><p class="sec">Try other words, or clear the search.</p></div>`
      : `<div class="empty"><h2 class="h3">No articles yet</h2><p class="sec">${staff ? 'Add an article, or draft one from resolved incidents.' : 'Help articles will appear here.'}</p></div>`;
}

function kbError(text, field) { const box = $('#knowledgeMessage'); setFormStatus(box, `✕ ${text}`, true); if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); } }
async function addKnowledge(event) {
  event.preventDefault(); const form = event.target;
  form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
  const missing = ['title', 'product', 'symptoms', 'steps', 'resolution'].map(name => form.elements[name]).find(el => !el.value.trim());
  if (missing) return kbError(`Fill in ${form.querySelector(`label[for="${missing.id}"]`).textContent.toLowerCase()}.`, missing);
  const values = Object.fromEntries(new FormData(form).entries());
  values.steps = values.steps.split("\n").map(value => value.trim()).filter(Boolean); values.tags = values.tags.split(",").map(value => value.trim()).filter(Boolean);
  values.source_ticket_ids = knowledgeDraftSources.slice();
  const button = $('#knowledgeSubmit'); button.disabled = true; button.setAttribute('aria-busy', 'true'); setFormStatus($('#knowledgeMessage'), 'Publishing…');
  try {
    const article = await api("/api/knowledge", { method: "POST", body: JSON.stringify(values) });
    form.reset(); $('#knowledgeModal').close(); await loadKnowledge();
    toast(`${article.id} published. AI uses it from the next analysis.`);
  } catch (error) { kbError(`Not published: ${error.message}`); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}

function openKnowledgeEditor(article, warnings = []) {
  const form = $('#knowledgeForm'); form.reset(); form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
  knowledgeDraftSources = article?.source_ticket_ids || [];
  for (const field of ['title','product','symptoms','resolution']) form.elements[field].value = article?.[field] || '';
  form.elements.steps.value = article?.steps.join('\n') || '';
  form.elements.tags.value = article?.tags.join(', ') || '';
  $('#knowledgeModalTitle').textContent = article ? 'Review the AI draft' : 'Add an article';
  $('#knowledgeDraftBadge').hidden = !article;
  $('#knowledgeModalIntro').textContent = article ? 'AI drafted this from the incidents below. It isn’t published until you select Publish. Edit anything that’s wrong.' : 'Published articles are used by AI during analysis and live calls.';
  $('#knowledgeSources').textContent = knowledgeDraftSources.length ? `Drafted from: ${knowledgeDraftSources.join(', ')}` : '';
  $('#knowledgeSources').hidden = !knowledgeDraftSources.length;
  $('#knowledgeWarnings').textContent = warnings.length ? `◆ ${warnings.join(' ')}` : ''; $('#knowledgeWarnings').hidden = !warnings.length;
  $('#knowledgeSubmit').textContent = article ? 'Publish draft' : 'Publish article';
  setFormStatus($('#knowledgeMessage'), '');
  $('#knowledgeModal').showModal();
  form.elements.title.focus();
}

async function generateIncidentKnowledge(event) {
  event.preventDefault();
  const field = event.target.elements.ticket_numbers;
  const numbers = [...new Set(field.value.toUpperCase().split(/[\s,;]+/).filter(Boolean))];
  const message = $('#incidentKnowledgeMessage'), button = $('#generateIncidentKnowledge');
  field.removeAttribute('aria-invalid');
  if (!numbers.length || numbers.length > 20) { setFormStatus(message, '✕ Enter between 1 and 20 incident numbers.', true); field.setAttribute('aria-invalid', 'true'); field.focus(); return; }
  const controller = new AbortController(); knowledgeGeneration = controller;
  button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Generating…';
  setFormStatus(message, `● Reading ${numbers.length} incident${numbers.length === 1 ? '' : 's'} and their conversations…`);
  try {
    const result = await api('/api/knowledge/from-incidents', {method:'POST', signal:controller.signal, body:JSON.stringify({ticket_numbers:numbers})});
    if (controller.signal.aborted) return;
    $('#incidentKnowledgeModal').close(); event.target.reset();
    openKnowledgeEditor(result.article, result.warnings);
  } catch (error) {
    if (error.name !== 'AbortError') setFormStatus(message, `✕ ${error.message}`, true);
  } finally {
    if (knowledgeGeneration === controller) { knowledgeGeneration = null; button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = 'Generate draft'; }
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
  const input = $("#aiKeyInput"), message = $("#keyMessage"), button = event.target.querySelector('[type=submit]');
  if (input.value.trim().length < 20) { setFormStatus(message, '✕ That key looks incomplete. Paste the full key.', true); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
  input.removeAttribute('aria-invalid'); button.disabled = true; button.setAttribute('aria-busy', 'true'); setFormStatus(message, 'Checking and saving…');
  try {
    await api(state.config.provider === "google_ai" ? "/api/config/gemini-key" : "/api/config/openai-key", { method: "POST", body: JSON.stringify({ api_key: input.value }) });
    input.value = ""; await loadConfig(); $('#keyModal').close(); toast(`${providerName()} key saved.`);
  } catch (error) { setFormStatus(message, `✕ Not saved: ${error.message}`, true); }
  finally { input.value = ''; button.disabled = false; button.removeAttribute('aria-busy'); }
}

async function transcribeAudio(file) {
  if (!file) { setCaseStatus("✕ Choose an audio file first.", true); $('#audioFile').focus(); return; }
  const form = new FormData(); form.append("file", file, file.name || "recording.webm");
  setCaseStatus(`● Transcribing with ${state.config?.transcription_model || "the configured model"}…`);
  $('#transcribeFileButton').setAttribute('aria-busy', 'true');
  try {
    const result = await api("/api/transcribe", { method: "POST", body: form });
    $("#transcriptInput").value = result.text;
    setCaseStatus(`✓ Transcribed with ${result.model}. Check the text and add speaker labels if needed, then analyze.`);
    $("#transcriptInput").focus();
  } catch (error) { setCaseStatus(`✕ Transcription failed: ${error.message}`, true); }
  finally { $('#transcribeFileButton').removeAttribute('aria-busy'); }
}

async function toggleRecording() {
  const button = $("#captureButton");
  if (state.mediaRecorder?.state === "recording") { state.mediaRecorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setCaseStatus("✕ This browser can’t record audio. Upload a recording instead.", true); return; }
  try {
    setCaseStatus('● Requesting microphone access…');
    state.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true }); state.audioChunks = [];
    state.mediaRecorder = new MediaRecorder(state.audioStream);
    state.mediaRecorder.ondataavailable = event => { if (event.data.size) state.audioChunks.push(event.data); };
    state.mediaRecorder.onstop = async () => {
      const type = state.mediaRecorder.mimeType || "audio/webm";
      const file = new File([new Blob(state.audioChunks, { type })], "resolveai-call.webm", { type });
      state.audioStream.getTracks().forEach(track => track.stop()); state.audioStream = null; state.mediaRecorder = null;
      button.textContent = "● Start recording"; button.setAttribute('aria-pressed', 'false');
      await transcribeAudio(file);
    };
    state.mediaRecorder.start();
    button.textContent = "■ Stop and transcribe"; button.setAttribute('aria-pressed', 'true');
    setCaseStatus('● Recording. Select Stop and transcribe when you’re done.');
  } catch (error) {
    setCaseStatus(error.name === 'NotAllowedError' ? '✕ Microphone access is blocked. Allow it in your browser’s site settings, or upload an audio file instead.' : `✕ Microphone unavailable: ${error.message}`, true);
  }
}

document.addEventListener("click", event => {
  const ticketLink = event.target.closest('[data-ticket-link]');
  if (ticketLink) {
    if (ticketLink.tagName === 'A' && (event.metaKey || event.ctrlKey || event.shiftKey || event.button)) return;
    event.preventDefault();
    if (window.confirmLeave && !window.confirmLeave(() => ticketLink.click())) return;
    history.pushState({}, '', ticketLink.getAttribute('href') || location.href);
    openTicketDetails(ticketLink.dataset.ticketLink).then(() => { if (ticketLink.hasAttribute('data-focus-comment')) $('#workNoteText')?.focus(); }).catch(error => showFeedback(error.message, true));
    return;
  }
  const nav = event.target.closest("[data-view]");
  if (nav) {
    if (nav.tagName === 'A' && (event.metaKey || event.ctrlKey || event.shiftKey || event.button)) return;
    event.preventDefault();
    if (window.confirmLeave && !window.confirmLeave(() => nav.click())) return;
    if (nav.tagName === 'A') history.pushState({view: nav.dataset.view}, '', nav.getAttribute('href'));
    nav.dataset.view === "case" ? startNewCase() : showView(nav.dataset.view);
  }
  if (event.target.closest('[data-go-home]')) showView(homeView());
  const customerRetry = event.target.closest('[data-customer-retry]');
  if (customerRetry) customerRetry.dataset.customerRetry === 'calls' ? loadCustomerCalls() : loadCustomerIncidents();
  if (event.target.closest("[data-open-case]")) startNewCase();
  const direct = event.target.closest("[data-view-target]"); if (direct) showView(direct.dataset.viewTarget);
  const timeMachine = event.target.closest('[data-enter-time-machine]'); if (timeMachine) window.enterIncidentTimeMachine?.(timeMachine.dataset.enterTimeMachine);
  const qaRow = event.target.closest("[data-qa-case-id]"); if (qaRow) openCase(qaRow.dataset.qaCaseId, "qa");
  if (event.target.closest("[data-open-qa]") && state.current) renderQA(state.current);
  if (event.target.closest("#rerunQa")) rerunQA();
  const reveal = event.target.closest('[data-reveal]');
  if (reveal) { const input = $('#' + reveal.dataset.reveal), show = input.type === 'password'; input.type = show ? 'text' : 'password'; reveal.setAttribute('aria-pressed', String(show)); }
  if (event.target.closest('#dismissGlobalFeedback')) $('#globalFeedback').hidden = true;
  if (event.target.closest("#openKnowledgePanel")) openKnowledgeEditor();
  if (event.target.closest('#openIncidentKnowledgePanel')) { setFormStatus($('#incidentKnowledgeMessage'), ''); $('#incidentKnowledgeModal').showModal(); }
  if (event.target.closest('#closeIncidentKnowledgePanel')) $('#incidentKnowledgeModal').close();
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
$("#caseForm").addEventListener("submit", analyzeConversation);
$("#captureButton").addEventListener("click", toggleRecording);
$("#transcribeFileButton").addEventListener("click", () => transcribeAudio($("#audioFile").files[0]));
document.addEventListener('input', event => {
  if (!event.target.closest('#ticketForm')) return;
  window.ResolveDirty.mark('ticket', true, 'all'); $('#ticketDirtyNote').hidden = false;
});
document.addEventListener('click', async event => {
  if (event.target.closest('#retryCaseMedia')) {
    const button = event.target.closest('#retryCaseMedia'); button.disabled = true;
    try { await uploadCaseMedia(caseUploader.files()); renderCase(state.current); setCaseStatus('✓ Photos attached.'); toast('Photos attached.'); }
    catch (error) { caseUploader.setStatus('failed'); button.disabled = false; setCaseStatus(`✕ Upload failed again: ${error.message}`, true); }
  }
  if (event.target.closest('#acceptDraft')) { state.reviewed.add(state.current.id); toast(`Draft accepted. ${state.current.ticket.id} is ready to work.`); history.pushState({}, '', `${window.Shell.home(state.user.role)}?ticket=${encodeURIComponent(state.current.id)}`); openTicketDetails(state.current.id); }
  if (event.target.closest('#editDraft, #rejectEdit')) { $('#rejectDraftDialog').close(); $('#draftEditor').hidden = false; $('#tf-short').focus(); }
  if (event.target.closest('#rejectDraft')) $('#rejectDraftDialog').showModal();
  if (event.target.closest('#rejectResolve')) {
    $('#rejectDraftDialog').close();
    await openTicketDetails(state.current.id);
    $('#fu-resolution-tab').click();
    $('#resolutionText').value = 'Raised in error: the AI draft was rejected by the technician after review. No action needed.';
    $('#resolutionText').focus();
  }
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
    ['ticketQa','callQa'].forEach(prefix=>{ $('#'+prefix+'Metrics').innerHTML=''; $('#'+prefix+'Coverage').textContent=''; $('#'+prefix+'Count').textContent=''; ['Technician','Service'].forEach(field=>$('#'+prefix+field+'Filter').value=''); });
    $('#callQaSearch').value='';
    window.resetCallQa?.();
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
    select.closest('.field').hidden = !admin;
    if (!admin) select.value = '';
  });
  window.Shell?.render(user);
  if (!user || customer) {
    $('#presenceControl').hidden = $('#micSwitch').hidden = true;
    $('#incomingCallBanner').hidden = true;
  }
  $('#openKnowledgePanel').hidden = $('#openIncidentKnowledgePanel').hidden = !user || customer;
};

// ---- Shared incident building blocks ----
// Where an incident is now, from the customer's side: 0 Received, 1 Assigned, 2 In progress (or Waiting), 3 Resolved.
function customerStage(ticket) {
  if (['Resolved','Closed'].includes(ticket.state)) return 3;
  if (['In Progress','On Hold'].includes(ticket.state)) return 2;
  return ticket.assigned_to ? 1 : 0;
}
const STAGE_BADGES = [['badge--new', '● Received'], ['badge--medium', '● Assigned'], ['badge--high', '◆ In progress'], ['badge--ok', '✓ Resolved']];
function customerStageBadge(ticket) {
  const [tone, label] = ticket.state === 'On Hold' ? ['badge--muted', '○ Waiting for you'] : STAGE_BADGES[customerStage(ticket)];
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}
function progressSteps(ticket) {
  const stage = customerStage(ticket);
  const names = ['Received', 'Assigned', ticket.state === 'On Hold' ? 'Waiting' : 'In progress', 'Resolved'];
  return `<ol class="steps" aria-label="Incident progress">${names.map((name, index) => `<li${index === stage ? ' aria-current="step"' : ''}>${index <= stage ? '✓' : '○'} ${name}</li>`).join('')}</ol>`;
}
function customerNextStep(ticket, assist = null) {
  const who = ticket.assigned_to ? esc(ticket.assigned_to) : 'A technician';
  if (assist?.status === 'pending') return 'The AI assistant is reviewing your report. This page updates by itself.';
  if (assist?.status === 'offered' && !['Resolved','Closed'].includes(ticket.state)) return 'The AI assistant suggested some steps. Try them, then tell us whether they worked.';
  if (['Resolved','Closed'].includes(ticket.state)) return 'Resolved. Open the incident to read what was done.';
  if (ticket.state === 'On Hold') return `Waiting on more information. Open the incident to see the latest comments and reply.`;
  if (ticket.state === 'In Progress') return `${who} is working on it. Updates will appear here.`;
  return ticket.assigned_to ? `${who} has your case. Next: they’ll start work and update you here.` : 'We’ve received your report. Next: a technician will be assigned.';
}
const when = value => value ? new Date(value).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}) : '';

// Visual analysis provenance. Only Gemini/OpenAI results are AI image analysis; the server's local fallback
// is a keyword estimate, and demo mode does not inspect images at all.
function analysisState(ticket) {
  const va = ticket?.visual_analysis, source = va?.analysis_source || '';
  const failed = !va && ticket?.work_notes?.find(note => /(media|image) analysis unavailable/i.test(note.text));
  if (va && /gemini|openai/i.test(source) && !/local extraction|demo/i.test(source)) return {kind: 'ai', badge: '<span class="badge badge--ok">✓ AI analysed</span>', source};
  if (va && /local extraction/i.test(source)) return {kind: 'estimate', badge: '<span class="badge badge--high">◆ Rule-based estimate</span>', source};
  if (va && /demo/i.test(source)) return {kind: 'demo', badge: '<span class="badge badge--muted">○ Not analysed (demo mode)</span>', source};
  if (failed) return {kind: 'unavailable', badge: '<span class="badge badge--err">✕ Analysis unavailable</span>', note: failed.text};
  if (va) return {kind: 'estimate', badge: '<span class="badge badge--high">◆ Unverified source</span>', source};
  return {kind: 'none'};
}

function renderAttachments(attachments = [], customer = false, ticket = null) {
  if (!attachments.length) return '';
  const state = analysisState(ticket);
  const summary = !customer ? '' : state.kind === 'ai' ? '<p class="help">✓ Your images were checked automatically to help your technician.</p>'
    : state.kind === 'none' ? '' : '<p class="help">○ Automatic image checking wasn’t available. Your technician will review the images themselves.</p>';
  return `<section class="card stack" aria-labelledby="attachmentsTitle"><div class="section-head"><h2 id="attachmentsTitle" class="h3">Attachments <span class="muted">(${attachments.length})</span></h2>${customer ? '<span class="badge badge--ok">✓ Attached</span>' : ''}</div>${summary}<ul class="thumbs">${attachments.map(att => {
    const url = `/api/attachments/${encodeURIComponent(att.id)}`;
    const media = att.content_type.startsWith('image/') ? `<img src="${url}" alt="" loading="lazy">`
      : att.content_type.startsWith('video/') ? `<video controls preload="metadata"><source src="${url}" type="${esc(att.content_type)}">Your browser can’t play this video. <a href="${url}">Download it</a>.</video>` : '';
    const action = att.content_type.startsWith('image/') ? `<button type="button" class="link" data-image-preview="${url}" data-image-alt="${esc(att.filename)}"><span>View<span class="sr"> ${esc(att.filename)}</span> full size</span></button>` : `<a class="link" href="${url}" target="_blank" rel="noopener"><span>Open<span class="sr"> ${esc(att.filename)}</span></span></a>`;
    return `<li class="thumb">${media}<span class="thumb__name">${esc(att.filename)}</span><span class="help">${ResolveUploader.size(att.size_bytes)}</span>${action}</li>`;
  }).join('')}</ul></section>`;
}

// Written so a technician can act without opening the images; "Check the image for" says when they still should.
function renderVisualAnalysis(ticket, caseId) {
  const state = analysisState(ticket), va = ticket?.visual_analysis;
  if (state.kind === 'none') return '';
  const hasImages = (ticket.attachments || []).some(att => att.content_type.startsWith('image/'));
  const rerun = caseId && hasImages ? `<div class="row row--sm"><button type="button" class="btn btn-soft btn-sm" data-rerun-images="${esc(caseId)}">${state.kind === 'ai' ? 'Re-run analysis' : 'Analyse images again'}</button><p class="form-status" id="rerunImagesStatus" role="status"></p></div>` : '';
  const head = `<div class="section-head"><h2 class="h3" id="visualTitle">Image analysis</h2>${state.badge}</div>`;
  const section = body => `<section class="card stack" aria-labelledby="visualTitle">${head}${body}${rerun}</section>`;
  if (state.kind === 'unavailable') return section(`<p class="sec">The images are attached, but analysis didn’t run. Analyse them again, or review them yourself.</p><p class="help pre" data-detail>${esc(state.note)}</p>`);
  if (state.kind === 'demo') return section('<p class="sec">This server runs in demo mode, so the images were attached but not inspected. Review them yourself.</p>');
  if (state.kind !== 'ai') return section(`<p class="sec">AI image analysis didn’t run for these images, so nothing was read from them. Analyse them again, or review them yourself.</p>
    <details data-detail><summary>Keyword estimate (not from the images)</summary><p class="help pre">${esc(va.visual_observations)}</p></details>`);

  // Problem first: what is wrong, the exact error, the facts that matter, the likely cause and what to do.
  // Everything else read from the image sits in a collapsed section, so the technician rarely needs to open it.
  const appName = (va.application || '').trim().toLowerCase();
  const facts = (va.key_details || []).map(line => { const at = line.indexOf(':'); return at > 0 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : ['Detail', line.trim()]; })
    .filter(([label, value]) => value && !(/^(app|application|software)$/i.test(label) || (appName && value.toLowerCase() === appName)));
  const env = va.environment && !/^not (explicitly )?visible\.?$/i.test(va.environment) ? va.environment : '';
  const codes = [...new Set([...(va.error_codes || []), ...(va.images || []).flatMap(image => image.error_codes || [])])];
  const steps = va.next_steps?.length ? va.next_steps : [va.recommended_action].filter(Boolean);
  const shown = new Set([va.error_message, va.application, ...facts.map(([, value]) => value)].filter(Boolean).map(value => value.trim().toLowerCase()));
  const evidence = (va.evidence || []).filter(line => line && !shown.has(line.trim().toLowerCase()));
  const level = (va.confidence || '').trim().toLowerCase();
  const confidence = level ? `<span class="badge ${level === 'high' ? 'badge--ok' : level === 'medium' ? 'badge--medium' : 'badge--high'}">${level === 'high' ? '✓' : level === 'medium' ? '●' : '◆'} ${esc(level[0].toUpperCase() + level.slice(1))} confidence</span>` : '';
  const allText = (va.images || []).reduce((total, image) => total + (image.on_screen_text || []).length, 0);
  const imagesDetail = (va.images || []).map((image, i) => `<li class="stack stack--sm"><p><strong>Image ${i + 1}</strong>${image.file ? ` · <span class="mono">${esc(image.file)}</span>` : ''}</p>
      ${image.shows ? `<p class="sec">${esc(image.shows)}</p>` : ''}
      ${image.on_screen_text?.length ? `<ul class="va-text" aria-label="Text read from image ${i + 1}">${image.on_screen_text.map(text => `<li>${esc(text)}</li>`).join('')}</ul>` : ''}</li>`).join('');
  return section(`<p class="va-problem">${esc(va.problem || va.summary || va.visual_observations)}</p>
    ${va.problem && va.summary ? `<p class="sec">${esc(va.summary)}</p>` : ''}
    ${va.error_message || codes.length ? `<div class="va-error"><p class="kicker">Error on screen</p>${va.error_message ? `<blockquote>${esc(va.error_message)}</blockquote>` : ''}${codes.length ? `<ul class="va-codes" aria-label="Error codes">${codes.map(code => `<li class="mono">${esc(code)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    ${va.application || env || facts.length ? `<dl class="kv">${va.application ? `<div><dt>Application</dt><dd>${esc(va.application)}</dd></div>` : ''}${env ? `<div><dt>Device and environment</dt><dd>${esc(env)}</dd></div>` : ''}${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>` : ''}
    ${evidence.length ? `<div class="stack stack--sm"><h3 class="h4">Text that matters</h3><ul class="va-evidence">${evidence.map(line => `<li>${esc(line)}</li>`).join('')}</ul></div>` : ''}
    <div class="va-act">
      <div class="stack stack--sm"><div class="row row--sm"><h3 class="h4">Likely cause</h3>${confidence}</div><p class="sec">${esc(va.technical_diagnosis)}</p></div>
      ${steps.length ? `<div class="stack stack--sm"><h3 class="h4">What to do</h3><ol class="va-steps">${steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol></div>` : ''}
    </div>
    ${va.unclear ? `<div class="alert alert--info"><strong>◆ Open the image to check:</strong><span class="sec">${esc(va.unclear)}</span></div>` : ''}
    ${imagesDetail ? `<details class="va-more"><summary>Everything read from the image${(va.images || []).length > 1 ? 's' : ''}${allText ? ` (${allText} lines of text)` : ''}</summary><ol class="va-images">${imagesDetail}</ol></details>` : va.visual_observations && va.visual_observations !== va.summary ? `<details class="va-more"><summary>Full description</summary><p class="sec pre">${esc(va.visual_observations)}</p></details>` : ''}
    <dl class="kv" data-detail><div><dt>Suggested service</dt><dd>${esc(va.suggested_service)}</dd></div><div><dt>Suggested priority</dt><dd>${priorityBadge((va.suggested_priority || 'P3').toUpperCase())}</dd></div><div><dt>Suggested category</dt><dd>${esc(va.suggested_category)} · ${esc(va.suggested_subcategory)}</dd></div></dl>
    <p class="help">Read by ${esc(state.source)}. Confirm against the image before changing accounts or settings.</p>`);
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-rerun-images]');
  if (!button) return;
  const id = button.dataset.rerunImages, status = $('#rerunImagesStatus');
  button.disabled = true; button.setAttribute('aria-busy', 'true'); setFormStatus(status, 'Reading the images… this can take up to a minute.');
  try {
    state.current = await api(`/api/cases/${encodeURIComponent(id)}/image-analysis`, { method: 'POST', body: '{}' });
    if ($('#view-ticket-detail').classList.contains('active')) await openTicketDetails(id, {keepScroll: true}); else renderCase(state.current);
    toast(`Images analysed for ${state.current.ticket.id}.`);
    $('#visualTitle')?.scrollIntoView({block: 'start'});
  } catch (error) { setFormStatus(status, `✕ ${error.message}`, true); button.disabled = false; button.removeAttribute('aria-busy'); }
});

// ---- AI assistance: self-help first, technician handover when it can't safely help ----
function assistSteps(assist) { return `<ol class="plain-steps">${assist.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>`; }
// AI review runs in the background; poll the ticket until it finishes, then re-render.
let assistPoll;
function watchAssist(item, onDone) {
  clearTimeout(assistPoll);
  if (item?.assist?.status !== 'pending') return;
  let tries = 0;
  const tick = async () => {
    if (++tries > 48) return;
    try {
      const fresh = await api(`/api/cases/${encodeURIComponent(item.id)}`);
      if (fresh.assist?.status !== 'pending') { onDone(fresh); return; }
    } catch (_) {}
    assistPoll = setTimeout(tick, 2500);
  };
  assistPoll = setTimeout(tick, 2500);
}
function customerAssist(item) {
  const assist = item.assist, t = item.ticket;
  if (!assist) return '';
  if (assist.status === 'pending') return `<section class="card stack" aria-labelledby="assistTitle" aria-busy="true"><div class="section-head section-head--tight"><div><p class="kicker">AI assistant</p><h2 class="h3" id="assistTitle">Reviewing your report…</h2></div><span class="badge badge--medium">● Working</span></div><p class="sec">${t.attachments?.length ? 'Reading your images and checking our help articles.' : 'Checking our help articles.'} This usually takes under a minute; this page updates by itself.</p><div class="stack stack--sm" aria-hidden="true"><div class="skeleton"></div><div class="skeleton" style="width:70%"></div></div></section>`;
  if (assist.status === 'offered') return `<section class="card stack" aria-labelledby="assistTitle"><div class="section-head section-head--tight"><div><p class="kicker">AI assistant</p><h2 class="h3" id="assistTitle">Try these steps first</h2></div><span class="badge badge--medium">● Waiting for you</span></div>
    ${assist.summary ? `<p class="sec">${esc(assist.summary)}</p>` : ''}${assistSteps(assist)}
    <p class="help">These steps come from an approved help article. If they don’t work, a technician takes over with everything you’ve shared, including your images.</p>
    <form class="stack stack--sm" data-assist-form="${esc(item.id)}" novalidate><div class="field field--inline"><label for="assistNote">Anything the technician should know? <span class="muted">(optional)</span></label><textarea class="input" id="assistNote" rows="2" maxlength="2000"></textarea></div>
    <div class="row"><button type="button" class="btn btn-primary" data-assist-answer="fixed">That fixed it</button><button type="button" class="btn btn-soft" data-assist-answer="not-fixed">Still not working, send to a technician</button></div><p class="form-status" role="status" data-assist-status></p></form></section>`;
  if (assist.status === 'resolved') return `<section class="card stack stack--sm" aria-labelledby="assistTitle"><div class="section-head section-head--tight"><h2 class="h3" id="assistTitle">AI assistant</h2><span class="badge badge--ok">✓ You confirmed it’s fixed</span></div><p class="sec">The suggested steps solved it, so this incident is resolved.</p></section>`;
  return `<section class="card stack stack--sm" aria-labelledby="assistTitle"><div class="section-head section-head--tight"><h2 class="h3" id="assistTitle">With a technician</h2><span class="badge badge--high">◆ Handed to a person</span></div><p class="sec">${esc(assist.reason)}</p><p class="help">${t.assigned_to ? `${esc(t.assigned_to)} has your case, with your description and images.` : 'Your case is in the service desk queue with your description and images.'}</p></section>`;
}
function staffAssist(item) {
  const assist = item.assist;
  if (!assist) return '';
  const [tone, label] = {pending: ['badge--medium', '● AI reviewing'], offered: ['badge--medium', '● Steps offered · waiting for customer'], resolved: ['badge--ok', '✓ Customer confirmed fixed'], escalated: ['badge--high', '◆ Handed over to a technician']}[assist.status] || ['badge--muted', `○ ${assist.status}`];
  return `<section class="card stack" aria-labelledby="staffAssistTitle"><div class="section-head section-head--tight"><h2 class="h3" id="staffAssistTitle">AI assistance</h2><span class="badge ${tone}">${label}</span></div>
    ${assist.reason ? `<p class="sec"><strong>${assist.status === 'escalated' ? 'Why it came to you:' : 'Basis:'}</strong> ${esc(assist.reason)}</p>` : ''}
    ${assist.steps.length ? `<div class="stack stack--sm"><h3 class="h4">Steps the customer was given</h3>${assistSteps(assist)}<p class="help">From ${assist.knowledge_ids.map(id => `<span class="mono">${esc(id)}</span>`).join(', ') || 'approved knowledge'}${assist.confidence ? ` · ${Math.round(assist.confidence * 100)}% confidence` : ''}</p></div>` : '<p class="help">No self-help was offered to the customer.</p>'}
    ${assist.customer_response ? `<p class="small"><strong>Customer said:</strong> ${esc(assist.customer_response)}</p>` : ''}</section>`;
}

function customerTicketDetails(item) {
  const t = item.ticket;
  return `<div class="page-head"><div><p class="kicker"><span class="mono">${esc(t.id)}</span></p><h1 id="ticketDetailTitle" tabindex="-1">${esc(t.short_description)}</h1></div>${customerStageBadge(t)}</div>
  <div class="stack stack--lg">
    ${customerAssist(item)}
    <section class="card${item.assist?.status === 'offered' ? '' : ''} stack" aria-labelledby="progressTitle"><h2 class="h3" id="progressTitle">Progress</h2>${progressSteps(t)}<p class="sec">${customerNextStep(t, item.assist)}</p></section>
    ${t.resolution ? `<section class="card stack" aria-labelledby="resolutionTitle"><h2 class="h3" id="resolutionTitle">How it was resolved</h2><p class="pre">${esc(t.resolution)}</p></section>` : ''}
    <section class="card stack" aria-labelledby="reportedTitle"><h2 class="h3" id="reportedTitle">What you reported</h2><p class="pre sec">${esc(t.description)}</p>
      <dl class="kv"><div><dt>Service</dt><dd>${esc(t.service)}</dd></div><div><dt>Assigned to</dt><dd>${esc(t.assigned_to || 'Awaiting assignment')}</dd></div><div><dt>Reported</dt><dd>${esc(when(item.created_at))}</dd></div></dl></section>
    ${renderAttachments(t.attachments, true, t)}
    ${activityPanel(item)}
  </div>`;
}

window.showCustomerCreateResult = (item, fileCount, {quiet = false} = {}) => {
  const t = item.ticket, state = analysisState(t), pending = item.assist?.status === 'pending';
  const files = (t.attachments || []).map(att => `<li class="file"><span class="file__name">${esc(att.filename)}</span><span class="row row--sm"><span class="badge badge--ok">✓ Attached</span>${pending ? '<span class="badge badge--medium">● Checking</span>' : state.kind === 'ai' ? '<span class="badge badge--ok">✓ Checked</span>' : '<span class="badge badge--muted">○ Analysis unavailable</span>'}</span></li>`).join('');
  const box = $('#customerCreateResult');
  box.innerHTML = `<div class="card stack"><p class="kicker">Incident created</p><h2 id="createResultTitle" tabindex="-1">✓ ${esc(t.id)} ${['offered', 'pending'].includes(item.assist?.status) ? 'created' : t.assigned_to ? `is with ${esc(t.assigned_to)}` : 'is with the service desk'}</h2><p class="sec">${esc(t.short_description)}. ${item.assist?.status === 'offered' ? 'The AI assistant has some steps for you below.' : item.assist?.status === 'pending' ? 'The AI assistant is reviewing it now.' : 'You’ll see updates on My support.'}</p>
    ${fileCount ? `<div class="stack stack--sm"><h3 class="h4">Your images</h3><ul class="files">${files}</ul>${pending || state.kind === 'ai' ? '' : '<p class="help">Your images are attached to the incident. Automatic checking wasn’t available, so your technician will review them.</p>'}</div>` : ''}
    <div class="row"><a class="btn ${item.assist?.status === 'offered' ? 'btn-soft' : 'btn-primary'}" href="/portal?ticket=${encodeURIComponent(item.id)}" data-ticket-link="${esc(item.id)}">View incident <span aria-hidden="true">→</span></a><button type="button" class="btn btn-soft" id="reportAnother">Report another issue</button></div></div>${customerAssist(item) ? `<div class="section" aria-live="polite">${customerAssist(item)}</div>` : ''}`;
  box.hidden = false; $('#customerCreateForm').hidden = true;
  if (!quiet) { $('#createResultTitle').focus(); toast(`Incident ${t.id} created.`); }
  watchAssist(item, fresh => { if (!box.hidden && box.querySelector(`[data-ticket-link="${CSS.escape(fresh.id)}"]`)) window.showCustomerCreateResult(fresh, fileCount, {quiet: true}); });
};
document.addEventListener('click', async event => {
  const answer = event.target.closest('[data-assist-answer]');
  if (!answer) return;
  const form = answer.closest('[data-assist-form]'), status = form.querySelector('[data-assist-status]');
  form.querySelectorAll('button').forEach(button => { button.disabled = true; });
  answer.setAttribute('aria-busy', 'true');
  setFormStatus(status, answer.dataset.assistAnswer === 'fixed' ? 'Resolving your incident…' : 'Sending your case to a technician…');
  try {
    const item = await api(`/api/cases/${encodeURIComponent(form.dataset.assistForm)}/assist`, {method: 'POST', body: JSON.stringify({resolved: answer.dataset.assistAnswer === 'fixed', note: form.querySelector('textarea').value.trim()})});
    toast(answer.dataset.assistAnswer === 'fixed' ? `Great, ${item.ticket.id} is resolved.` : `${item.ticket.id} is with ${item.ticket.assigned_to || 'the service desk'} now.`);
    // Answered from the "incident created" screen: clear it so the card exists only once, on the ticket.
    if (form.closest('#customerCreateResult')) { $('#customerCreateResult').innerHTML = ''; $('#customerCreateResult').hidden = true; $('#customerCreateForm').hidden = false; }
    history.pushState({}, '', `/portal?ticket=${encodeURIComponent(item.id)}`);
    await openTicketDetails(item.id);
  } catch (error) {
    setFormStatus(status, `✕ ${error.message}`, true);
    form.querySelectorAll('button').forEach(button => { button.disabled = false; }); answer.removeAttribute('aria-busy');
  }
});
document.addEventListener('click', event => {
  if (!event.target.closest('#reportAnother')) return;
  $('#customerCreateResult').hidden = true; $('#customerCreateForm').hidden = false; $('#customerShortDescription').focus();
});

document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-image-preview]');
  if (!trigger) return;
  const dialog = $('#mediaPreviewDialog');
  $('#mediaPreviewImage').src = trigger.dataset.imagePreview;
  $('#mediaPreviewImage').alt = trigger.dataset.imageAlt || 'Incident attachment';
  $('#mediaPreviewCaption').textContent = trigger.dataset.imageAlt || 'Attachment';
  $('#mediaPreviewOpen').href = trigger.dataset.imagePreview;
  dialog.showModal();
});
$('#incidentKnowledgeModal').addEventListener('close', () => knowledgeGeneration?.abort());
$('#mediaPreviewDialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });

const CALL_STATUS = {Completed:['badge--ok','✓ Completed'],Failed:['badge--err','✕ Failed'],'Callback requested':['badge--high','◆ Callback requested']};
function loadError(what, retry) {
  return `<div class="alert" role="alert"><strong>✕ Couldn’t load your ${what}.</strong><span class="sec">Check your connection and try again.</span><button type="button" class="btn btn-soft btn-sm" data-customer-retry="${retry}">Retry</button></div>`;
}
const skeletonCards = n => `<div class="stack" aria-hidden="true">${Array.from({length: n}, () => '<div class="card stack stack--sm"><div class="skeleton" style="width:55%"></div><div class="skeleton"></div><div class="skeleton" style="width:70%"></div></div>').join('')}</div>`;

// The embedded voice page reports its height so the portal card grows with the call instead of scrolling inside.
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.data?.type !== 'resolveai-support-height') return;
  const frame = $('#voiceFrame');
  if (frame && event.source === frame.contentWindow) frame.style.height = `${Math.max(160, Math.min(1400, event.data.height))}px`;
});

async function loadCustomerCalls() {
  const target = $('#customerCalls');
  target.setAttribute('aria-busy', 'true');
  if (!target.querySelector('.list')) target.innerHTML = skeletonCards(1);
  try {
    customerCallsList = await api('/api/customer/calls');
    renderCustomerCalls();
  } catch (error) { target.innerHTML = loadError('calls', 'calls'); }
  finally { target.removeAttribute('aria-busy'); }
}
// Recent calls and chats on My support: five per page.
let customerCallsList = [];
const customerCallsPager = {page: 1, key: null};
function renderCustomerCalls() {
  const target = $('#customerCalls'), calls = customerCallsList;
  const page = paginateItems(calls, customerCallsPager, state.user?.id, '#customerCallsPagination', 5);
  target.innerHTML = calls.length ? `<ul class="list">${page.map(call => {
      const [tone, label] = CALL_STATUS[call.status] || ['badge--medium', `● ${call.status}`];
      return `<li class="list__row"><span class="list__main"><strong>${call.channel === 'chat' ? 'Chat' : 'Voice call'}</strong><span class="mono help">${esc(call.id)}</span><span class="help">${esc(new Date(call.created_at * 1000).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}))}</span></span><span class="badge ${tone}">${esc(label)}</span>${call.case_id ? `<a class="link" href="/portal?ticket=${encodeURIComponent(call.case_id)}" data-ticket-link="${esc(call.case_id)}"><span>View incident<span class="sr"> for ${esc(call.id)}</span></span></a>` : '<span class="help">No incident created</span>'}</li>`;
  }).join('')}</ul>` : '<p class="sec">No calls or chats yet. Ones you start from Get support appear here.</p>';
}
bindPagination('#customerCallsPagination', customerCallsPager, renderCustomerCalls);

// My support keeps a short list: Open or Resolved, newest first, five per page. Full detail is one click away.
const customerList = {items: [], filter: 'open', page: 1};
const CUSTOMER_PAGE = 5;
async function loadCustomerIncidents() {
  const target = $('#customerIncidents');
  target.setAttribute('aria-busy', 'true');
  if (!target.querySelector('.inc-list')) target.innerHTML = skeletonCards(2);
  try { customerList.items = await api('/api/cases'); }
  catch (error) { target.innerHTML = loadError('incidents', 'incidents'); target.removeAttribute('aria-busy'); return; }
  target.removeAttribute('aria-busy');
  renderCustomerIncidents();
}
function renderCustomerIncidents() {
  const target = $('#customerIncidents'), done = item => ['Resolved','Closed'].includes(item.ticket.state);
  const open = customerList.items.filter(item => !done(item)), resolved = customerList.items.filter(done);
  $('#customerOpenCount').textContent = open.length; $('#customerResolvedCount').textContent = resolved.length;
  $$('[data-incident-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.incidentFilter === customerList.filter)));
  if (!customerList.items.length) {
    target.innerHTML = '<div class="empty stack"><h3>No incidents yet</h3><p class="sec">Report a problem and follow it here.</p><div><a class="btn btn-primary" href="/portal?view=customer-create" data-view="customer-create">Report an issue</a></div></div>';
    return;
  }
  const list = (customerList.filter === 'open' ? open : resolved).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (!list.length) {
    target.innerHTML = `<div class="empty"><p class="sec">${customerList.filter === 'open' ? '✓ Nothing open. Everything you reported has been resolved.' : 'Nothing resolved yet.'}</p></div>`;
    return;
  }
  customerList.page = Math.min(customerList.page, Math.ceil(list.length / CUSTOMER_PAGE));
  const start = (customerList.page - 1) * CUSTOMER_PAGE;
  const rows = list.slice(start, start + CUSTOMER_PAGE).map(item => {
    const t = item.ticket, href = `/portal?ticket=${encodeURIComponent(item.id)}`;
    const action = item.assist?.status === 'offered' && !done(item) ? `<a class="btn btn-primary btn-sm" href="${href}" data-ticket-link="${esc(item.id)}"><span>Try the suggested steps<span class="sr"> for ${esc(t.id)}</span></span></a>`
      : t.state === 'On Hold' ? `<a class="btn btn-soft btn-sm" href="${href}" data-ticket-link="${esc(item.id)}" data-focus-comment><span>Add details<span class="sr"> to ${esc(t.id)}</span></span></a>` : '';
    return `<li class="inc-row"><div class="inc-row__main"><a class="inc-row__title" href="${href}" data-ticket-link="${esc(item.id)}">${esc(t.short_description)}</a>
      <p class="help"><span class="mono">${esc(t.id)}</span> · ${esc(t.service)} · ${esc(when(item.created_at))}</p>
      ${done(item) ? '' : `<p class="sec">${customerNextStep(t, item.assist)}</p>`}${action ? `<div>${action}</div>` : ''}</div>${customerStageBadge(t)}</li>`;
  }).join('');
  target.innerHTML = `<ul class="card inc-list">${rows}</ul><nav id="customerPagination" class="pagination" aria-label="Incident pages" hidden></nav>`;
  updatePagination('#customerPagination', customerList.page, list.length, CUSTOMER_PAGE);
}
document.addEventListener('click', event => {
  const filter = event.target.closest('[data-incident-filter]');
  if (filter) { customerList.filter = filter.dataset.incidentFilter; customerList.page = 1; renderCustomerIncidents(); }
  const step = event.target.closest('#customerPagination [data-page-step]');
  if (step && !step.disabled) {
    customerList.page += Number(step.dataset.pageStep); renderCustomerIncidents();
    $('#customerIncidentsTitle').scrollIntoView({block: 'nearest'}); $('.inc-row__title')?.focus({preventScroll: true});
  }
});

window.loadApplication = async () => {
  try {
    const auth=await api('/api/auth/status');applyAccountRole(auth.user);
    if(!auth.user){showView('signin');await window.Auth.showPublic(auth);return;}
    if((['/login','/signup'].includes(location.pathname) || new URLSearchParams(location.search).get('auth')==='login') && new URLSearchParams(location.search).get('next')!=='support'){history.replaceState(null,'',window.Shell.home(auth.user.role));}
    await Promise.all([loadConfig(),loadKnowledge()]);
    if(auth.user.role==='admin')state.users=await api('/api/users');
    const params=new URLSearchParams(location.search);
    if(params.get('next')==='support'){location.href='/support';return;}
    if(params.get('ticket'))return openTicketDetails(params.get('ticket'));
    if(params.get('transcript')){document.body.setAttribute('data-transcript-page','');showView('transcripts');return window.openTranscriptPage(params.get('transcript'));}
    if(params.get('case'))return openTicketDetails(params.get('case'));
    const path = location.pathname;
    if (path === '/portal' && auth.user.role !== 'customer') { location.replace(auth.user.role === 'admin' || auth.user.role === 'technician' ? '/console' : '/'); return; }
    if (path === '/console' && auth.user.role === 'customer') { location.replace('/portal'); return; }
    if (path === '/admin' && auth.user.role !== 'admin') { location.replace(auth.user.role === 'customer' ? '/portal' : '/console'); return; }
    document.body.dataset.entry = path;
    const routeView = path === '/portal' ? 'customer-home' : path === '/console' ? 'calls' : path === '/admin' ? 'overview' : null;
    showView(params.get('view') || routeView || (auth.user.role==='customer'?'customer-home':auth.user.role==='technician'?'calls':'overview'));
  } catch(error){showFeedback(error.message, true);}
};
window.addEventListener('popstate', () => {
  if (!state.user) return;
  const params = new URLSearchParams(location.search);
  if (params.get('ticket')) openTicketDetails(params.get('ticket')).catch(error => showFeedback(error.message, true));
  else showView(params.get('view') || homeView());
});
applyAccountRole(null);
window.loadApplication();
