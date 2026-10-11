const state = { currentCase: null, config: null, activeView: "overview" };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || "Request failed");
  }
  return response.json();
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2600);
}

function showView(name) {
  state.activeView = name;
  $$(".view").forEach(v => v.classList.toggle("active", v.id === `view-${name}`));
  $$(".nav-item[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  $(".sidebar").classList.remove("open");
  if (name === "tickets") loadTickets();
  if (name === "qa") renderQA(state.currentCase);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadConfig() {
  state.config = await api("/api/config");
  const isMock = state.config.provider === "mock";
  $("#providerLabel").textContent = isMock ? "Mock AI mode" : `${state.config.provider} mode`;
  $("#modelLabel").textContent = isMock ? "No credentials required" : state.config.model;
  $("#configProvider").textContent = isMock ? `Mock · ready for ${state.config.model}` : `${state.config.provider} · ${state.config.model}`;
  $("#configStore").textContent = state.config.store === "firestore" ? "Cloud Firestore" : "In-memory demo store";
}

async function loadOverview() {
  try {
    const data = await api("/api/overview");
    const values = [data.active_cases, `${data.ai_containment_rate}%`, `${data.average_resolution_minutes}m`, `${data.qa_pass_rate}%`];
    $$("#metricGrid .metric-card strong").forEach((node, i) => node.textContent = values[i]);
  } catch (error) { console.warn(error); }
}

async function runDemo(name) {
  history.replaceState(null, "", `?demo=${encodeURIComponent(name)}`);
  showView("case");
  $$(".scenario-button").forEach(button => button.classList.toggle("active", button.dataset.demo === name));
  $("#workspaceEmpty").classList.add("loading");
  $("#caseTitle").textContent = "ResolveAI is analyzing the conversation…";
  $("#caseSubtitle").textContent = "Extracting context, evaluating risk, and retrieving relevant knowledge.";
  try {
    const result = await api(`/api/demo/${name}`, { method: "POST" });
    state.currentCase = result;
    renderCase(result);
    toast(`${result.scenario} analyzed successfully`);
  } catch (error) {
    $("#caseTitle").textContent = "Analysis could not be completed";
    $("#caseSubtitle").textContent = error.message;
    toast(error.message);
  } finally {
    $("#workspaceEmpty").classList.remove("loading");
  }
}

async function analyzeTranscript() {
  const transcript = $("#transcriptInput").value.trim();
  if (transcript.length < 10) return toast("Add a little more conversation before analyzing.");
  $("#analyzeButton").disabled = true;
  $("#analyzeButton").textContent = "Analyzing…";
  try {
    const result = await api("/api/analyze", { method: "POST", body: JSON.stringify({ transcript }) });
    state.currentCase = result;
    renderCase(result);
    $("#transcriptEntry").hidden = true;
    toast("Transcript analyzed");
  } catch (error) { toast(error.message); }
  finally { $("#analyzeButton").disabled = false; $("#analyzeButton").textContent = "Analyze transcript"; }
}

function renderCase(data) {
  $("#workspaceEmpty").hidden = true;
  $("#caseWorkspace").hidden = false;
  $("#resolveButton").disabled = false;
  $("#caseTitle").textContent = data.scenario;
  $("#caseSubtitle").textContent = `${data.case_id} · ${data.handler_label}`;
  $("#caseStatus").textContent = data.status.toUpperCase();
  $("#routeConfidence").textContent = `${Math.round(data.routing.confidence * 100)}% confident`;
  renderTranscript(data.transcript);
  renderIntelligence(data);
  renderTicket(data);
}

function renderTranscript(lines) {
  $("#transcriptPanel").innerHTML = lines.map(line => {
    const key = line.speaker.toLowerCase().replace(/\s+/g, "-");
    const initials = line.speaker.split(" ").map(part => part[0]).join("").slice(0,2);
    return `<article class="utterance ${escapeHtml(key)}"><span class="speaker-dot">${escapeHtml(initials)}</span><div><strong>${escapeHtml(line.speaker)} <small>${escapeHtml(line.timestamp)}</small></strong><p>${escapeHtml(line.text)}</p></div></article>`;
  }).join("");
}

function renderIntelligence(data) {
  const u = data.understanding;
  const routeClass = data.routing.handler === "HUMAN" ? "human" : "";
  const knowledge = data.knowledge.map((kb, index) => `<div class="kb-result"><strong>${escapeHtml(kb.id)} · ${escapeHtml(kb.title)}</strong><span>${Math.round(kb.score * 100)}% match</span><p>${escapeHtml(kb.reason)}</p>${index === 0 ? `<button class="text-button" data-kb-action>View recommended steps →</button>` : ""}</div>`).join("");
  $("#intelligencePanel").innerHTML = `
    <article class="intel-card highlight"><h3>Current understanding</h3><strong>${escapeHtml(u.problem)}</strong><p>${escapeHtml(u.service)} · ${escapeHtml(u.users_affected)} · ${escapeHtml(u.urgency_signal)}</p></article>
    <article class="intel-card"><h3>Routing decision</h3><div class="route-row"><strong>${data.routing.handler === "AI" ? "AI agent" : "Human technician"}</strong><span class="route-chip ${routeClass}">${escapeHtml(data.routing.complexity)} · ${escapeHtml(data.routing.risk)} risk</span></div><p>${escapeHtml(data.routing.reason)}</p><p><b>Policy:</b> ${escapeHtml(data.routing.policy)}</p></article>
    <article class="intel-card"><h3>Suggested next question</h3><strong>“${escapeHtml(data.next_question)}”</strong></article>
    <article class="intel-card"><h3>Recommended action</h3><p>${escapeHtml(data.recommended_action)}</p></article>
    <article class="intel-card"><h3>Knowledge matches</h3>${knowledge}</article>`;
  const action = $("[data-kb-action]");
  if (action) action.addEventListener("click", () => toast(data.knowledge[0].steps.join(" · ")));
}

const ticketFields = [
  ["short_description", "Short description"], ["service", "Service"], ["category", "Category"],
  ["subcategory", "Subcategory"], ["impact", "Impact"], ["urgency", "Urgency"],
  ["priority", "Priority"], ["assignment_group", "Assignment group"], ["resolution_notes", "Resolution notes"]
];

function renderTicket(data) {
  const failed = data.qa.filter(item => item.status === "FAIL");
  const fields = ticketFields.map(([key, label]) => {
    const field = data.ticket[key];
    return `<div class="ticket-field"><span>${label}<b class="confidence">${Math.round(field.confidence * 100)}%</b></span><strong>${escapeHtml(field.value)}</strong></div>`;
  }).join("");
  const issue = failed[0];
  $("#ticketPanel").innerHTML = `<div class="ticket-meta"><strong>${escapeHtml(data.ticket.id)}</strong><span class="status-badge">${escapeHtml(data.ticket.status)}</span></div>${fields}${issue ? `<div class="qa-banner"><h3>QA found ${failed.length} issue${failed.length > 1 ? "s" : ""}</h3><p><b>${escapeHtml(issue.field)}:</b> ${escapeHtml(issue.reason)}</p><button class="outline-button" data-apply-fix="${escapeHtml(issue.field)}" data-value="${escapeHtml(issue.recommended)}">Apply ${escapeHtml(issue.recommended)}</button></div>` : `<div class="qa-banner pass"><h3>Quality audit passed</h3><p>All reviewed fields agree with the conversation evidence.</p></div>`}`;
  $$('[data-apply-fix]').forEach(button => button.addEventListener("click", () => applyFix(button.dataset.applyFix, button.dataset.value)));
}

async function applyFix(field, value) {
  if (!state.currentCase) return;
  try {
    const updated = await api(`/api/cases/${state.currentCase.case_id}/ticket`, { method: "PATCH", body: JSON.stringify({ fields: { [field]: value } }) });
    state.currentCase = updated;
    renderTicket(updated);
    renderQA(updated);
    toast(`${field.replaceAll("_", " ")} updated to ${value}`);
  } catch (error) { toast(error.message); }
}

async function loadTickets() {
  try {
    const cases = await api("/api/cases");
    const table = $("#ticketTable");
    if (!cases.length) { table.innerHTML = '<div class="table-empty">Run a demo scenario to create the first ticket.</div>'; return; }
    table.innerHTML = `<div class="ticket-row header"><span>Ticket</span><span>Summary</span><span>Assignment</span><span>Status</span><span>Quality</span></div>` + cases.map(item => `<div class="ticket-row"><strong>${escapeHtml(item.ticket.id)}</strong><span><b>${escapeHtml(item.ticket.short_description.value)}</b><small>${escapeHtml(item.scenario)}</small></span><span>${escapeHtml(item.ticket.assignment_group.value)}</span><span class="status-badge">${escapeHtml(item.ticket.status)}</span><strong>${item.quality_score}%</strong></div>`).join("");
  } catch (error) { toast(error.message); }
}

function renderQA(data) {
  if (!data) {
    $("#qaSummary").innerHTML = '<div class="score-ring"><strong>--</strong><span>Quality score</span></div><div><h2>No case selected</h2><p>Run a scenario, then return here to inspect its audit.</p></div>';
    $("#qaGrid").innerHTML = "";
    return;
  }
  const failures = data.qa.filter(item => item.status === "FAIL").length;
  $("#qaSummary").innerHTML = `<div class="score-ring"><strong>${data.quality_score}</strong><span>Quality score</span></div><div><p class="eyebrow light">${escapeHtml(data.ticket.id)}</p><h2>${failures ? `${failures} field${failures > 1 ? "s" : ""} need review` : "Ticket passed the quality audit"}</h2><p>${escapeHtml(data.scenario)} · ${escapeHtml(data.case_id)}</p></div>`;
  $("#qaGrid").innerHTML = data.qa.map(check => `<article class="qa-card"><div class="qa-card-head"><h3>${escapeHtml(check.field.replaceAll("_", " "))}</h3><span class="qa-status ${check.status.toLowerCase()}">${escapeHtml(check.status)} · ${Math.round(check.confidence * 100)}%</span></div><dl><dt>Current</dt><dd>${escapeHtml(check.current)}</dd><dt>Recommended</dt><dd>${escapeHtml(check.recommended)}</dd><dt>Reason</dt><dd>${escapeHtml(check.reason)}</dd></dl><p class="evidence">${escapeHtml(check.evidence)}</p>${check.status === "FAIL" ? `<button class="outline-button" data-qa-fix="${escapeHtml(check.field)}" data-value="${escapeHtml(check.recommended)}">Accept recommendation</button>` : ""}</article>`).join("");
  $$('[data-qa-fix]').forEach(button => button.addEventListener("click", () => applyFix(button.dataset.qaFix, button.dataset.value)));
}

function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $("#voiceButton").disabled = true;
    $("#voiceHelper").textContent = "Speech recognition is not available in this browser. Paste the transcript instead.";
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onstart = () => { $("#voiceButton").textContent = "Listening… click to stop"; $("#voiceButton").dataset.listening = "true"; };
  recognition.onresult = event => {
    let text = "";
    for (let i = event.resultIndex; i < event.results.length; i++) text += event.results[i][0].transcript;
    $("#transcriptInput").value += `${$("#transcriptInput").value ? " " : "Customer: "}${text}`;
  };
  recognition.onend = () => { $("#voiceButton").textContent = "Use microphone"; $("#voiceButton").dataset.listening = "false"; };
  $("#voiceButton").addEventListener("click", () => $("#voiceButton").dataset.listening === "true" ? recognition.stop() : recognition.start());
}

document.addEventListener("DOMContentLoaded", () => {
  $$(".nav-item[data-view]").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
  $$("[data-open-case]").forEach(button => button.addEventListener("click", () => showView("case")));
  $$("[data-view-jump]").forEach(button => button.addEventListener("click", () => showView(button.dataset.viewJump)));
  $$("[data-demo]").forEach(button => button.addEventListener("click", () => runDemo(button.dataset.demo)));
  $("#toggleTranscript").addEventListener("click", () => { $("#transcriptEntry").hidden = !$("#transcriptEntry").hidden; });
  $("#analyzeButton").addEventListener("click", analyzeTranscript);
  $("#resolveButton").addEventListener("click", () => { if (!state.currentCase) return; state.currentCase.ticket.status = "Resolved"; state.currentCase.status = "Resolved"; renderCase(state.currentCase); toast("Case marked resolved"); });
  $("#refreshTickets").addEventListener("click", loadTickets);
  $(".mobile-menu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
  setupVoice();
  loadConfig().catch(error => toast(error.message));
  loadOverview();
  const initialDemo = new URLSearchParams(window.location.search).get("demo");
  if (["vpn", "account", "sap"].includes(initialDemo)) runDemo(initialDemo);
});
