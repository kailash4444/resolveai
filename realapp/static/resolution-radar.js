const radarState = { window: '30d', service: '', priority: '', status: '', search: '', sort: 'debt', clusterId: null };
const radarDate = value => value ? new Date(value).toLocaleString() : '—';
const radarPercent = value => value == null ? 'Insufficient data' : `${Math.round(value * 100)}%`;
const radarArray = value => (value || []).map(esc).join('<br>') || '<span class="helper">No evidence recorded.</span>';

async function loadResolutionRadarData() {
  const params = new URLSearchParams(Object.entries(radarState).filter(([key, value]) => key !== 'clusterId' && value));
  const data = await api(`/api/resolution-radar?${params}`);
  $('#radarOpen').textContent = data.summary.open_systemic_issues;
  $('#radarHigh').textContent = data.summary.high_debt_issues;
  $('#radarRepeats').textContent = data.summary.recurring_incidents;
  $('#radarWorkaround').textContent = radarPercent(data.summary.temporary_workaround_rate);
  $('#radarEffort').textContent = data.summary.avoidable_effort == null ? 'Insufficient data' : data.summary.avoidable_effort;
  $('#radarPending').textContent = data.summary.pending_resolution_assessments
    ? `${data.summary.pending_resolution_assessments} resolved ticket${data.summary.pending_resolution_assessments === 1 ? '' : 's'} need durability analysis for this time window.`
    : 'Resolved tickets in this time window have current durability assessments.';
  const service = $('#radarService');
  const selected = radarState.service;
  service.innerHTML = '<option value="">All services</option>' + data.filters.services.map(value =>
    `<option value="${esc(value)}">${esc(value)}</option>`).join('');
  service.value = selected;
  $('#radarRows').innerHTML = data.clusters.map(cluster => {
    const coverage = Math.round((cluster.evidence_coverage || 0) * 100);
    const score = cluster.debt_score == null ? 'Insufficient evidence' : `${cluster.debt_score} · ${esc(cluster.score_band)}`;
    const observed = cluster.missing_signals?.length ? `Missing: ${cluster.missing_signals.join(', ')}` : 'All score signals available';
    return `<tr data-radar-open="${esc(cluster.id)}"><td><strong>${esc(cluster.summary)}</strong><br><small>${esc(cluster.service)} · ${cluster.incident_count} matching incident${cluster.incident_count === 1 ? '' : 's'}</small></td><td title="${esc(observed)} · ${coverage}% score evidence coverage"><b>${score}</b><small class="radar-coverage">${coverage}% evidence</small></td><td><span class="tag">${esc(cluster.priority)}</span></td><td>${cluster.incident_count}</td><td>${cluster.customer_count ?? '—'}</td><td>${cluster.recurrence_count}${cluster.recurrence_rate == null ? '' : ` · ${Math.round(cluster.recurrence_rate * 100)}%`}</td><td>${cluster.workaround_count}${cluster.workaround_rate == null ? '' : ` · ${Math.round(cluster.workaround_rate * 100)}%`}</td><td>${radarDate(cluster.latest_occurrence)}</td><td>${radarDate(cluster.last_analysis_at)}</td><td><span class="tag status-${esc(cluster.status)}">${esc(cluster.status)}</span></td></tr>`;
  }).join('');
  $('#radarEmpty').hidden = data.clusters.length > 0;
}

function renderRadarDetail(data) {
  const cluster = data.cluster;
  const components = Object.entries(cluster.score_components || {}).map(([name, value]) =>
    `<div><span>${esc(name.replaceAll('_', ' '))} <small>(${radarWeights[name] ?? 0}% weight)</small></span><b>${value == null ? 'Insufficient data' : `${Math.round(value)} / 100`}</b></div>`).join('');
  const incidents = data.incidents.map(item => {
    const link = item.link;
    const reviewControl = link.link_type === 'anchor' ? '<span class="helper">Cluster anchor</span>' :
      `<label class="radar-review">Match review<select data-radar-review="${esc(cluster.id)}" data-radar-case="${esc(item.case_id)}"><option value="unreviewed" ${link.review_state === 'unreviewed' ? 'selected' : ''}>Unreviewed</option><option value="confirmed" ${link.review_state === 'confirmed' ? 'selected' : ''}>Confirm match</option><option value="dismissed" ${link.review_state === 'dismissed' ? 'selected' : ''}>Dismiss match</option></select></label>`;
    const events = [`Reported ${radarDate(item.created_at)}`, item.resolved_at ? `Resolved ${radarDate(item.resolved_at)}` : '', ...(item.reopens || []).map(event => `Reopened ${radarDate(event.changed_at)}`)].filter(Boolean).join(' · ');
    return `<article class="radar-incident"><div class="panel-head"><div><button class="text-button" data-radar-ticket="${esc(item.case_id)}"><strong>${esc(item.ticket_id)}</strong> · ${esc(item.title)}</button><small>${esc(item.service)} · ${esc(item.priority)} · ${esc(item.state)} · ${esc(link.link_type)}</small></div><span class="tag">${link.confidence < 0.72 ? 'Possible match · ' : ''}${Math.round(link.confidence * 100)}%</span></div><p class="helper">${esc(link.rationale)}</p><p class="helper">${esc(events)}</p><p><b>Resolution assessment:</b> ${item.resolution_classification ? `${esc(item.resolution_classification.replaceAll('_', ' '))} · ${Math.round(item.resolution_confidence * 100)}% model confidence` : 'Not assessed'}${item.resolution_rationale ? `<br><span class="helper">${esc(item.resolution_rationale)}</span>` : ''}</p>${item.resolution_evidence_ids?.length ? `<p class="helper"><b>Assessment evidence:</b> ${item.resolution_evidence_ids.map(esc).join(', ')}</p>` : ''}${item.verification_evidence ? `<p class="helper"><b>Verification signal:</b> ${esc(item.verification_evidence)}</p>` : ''}${item.missing_information?.length ? `<p class="helper"><b>Missing:</b> ${item.missing_information.map(esc).join('; ')}</p>` : ''}${reviewControl}${item.evidence?.length ? `<details><summary>Supporting record excerpts</summary>${item.evidence.map(evidence => `<blockquote><small>${esc(evidence.source)} · ${esc(evidence.id)}</small><p>${esc(evidence.text)}</p></blockquote>`).join('')}</details>` : ''}</article>`;
  }).join('');
  const history = data.resolution_history.length ? `<div class="table-wrap"><table class="radar-history-table"><thead><tr><th>Approach</th><th>Incidents</th><th>Recurrences</th><th>Observed outcomes</th></tr></thead><tbody>${data.resolution_history.map(row => `<tr><td>${esc(row.approach)}</td><td>${row.incident_count}</td><td>${row.recurrence_count}</td><td>${esc(row.outcome)}${row.documented_outcomes?.length ? `<br><small>${row.documented_outcomes.map(esc).join(' · ')}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="helper">No comparable troubleshooting approaches have been extracted yet.</p>';
  const recommendations = data.recommendations.map(row => `<li><b>${esc(row.action)}</b><p class="helper">Evidence: ${esc(row.evidence)}</p></li>`).join('');
  const followups = data.followups.map(renderEngineeringFollowup).join('');
  const score = cluster.debt_score == null ? 'Insufficient evidence' : `${cluster.debt_score} / 100 · ${esc(cluster.score_band)}`;
  $('#radarDetail').innerHTML = `<div class="panel-head page-section-head"><div><p class="eyebrow">RESOLUTION DEBT RADAR</p><h2>${esc(cluster.summary)}</h2><p class="helper">${esc(cluster.service)} · First seen ${radarDate(cluster.first_occurrence)} · Latest ${radarDate(cluster.latest_occurrence)}</p></div><button class="secondary" data-radar-back>← Back to radar</button></div>
    <div class="radar-detail-grid"><article class="panel"><p class="eyebrow">ISSUE OVERVIEW · RECORD-DERIVED MATCH</p><h3>${esc(cluster.summary)}</h3><p>These incidents were linked using service and overlapping issue-specific symptom terms. This is a candidate systemic pattern, not a confirmed root cause.</p><div class="detail-list"><div><span>Linked incidents</span><strong>${cluster.incident_count}</strong></div><div><span>Known customer accounts</span><strong>${cluster.customer_count ?? 'Insufficient data'}</strong></div><div><span>Recurrences after closure</span><strong>${cluster.recurrence_count}${cluster.recurrence_rate == null ? ' · observation insufficient' : ` · ${Math.round(cluster.recurrence_rate * 100)}% of linked incidents`}</strong></div><div><span>Temporary workarounds</span><strong>${cluster.workaround_rate == null ? 'Insufficient data' : `${cluster.workaround_count} · ${Math.round(cluster.workaround_rate * 100)}%`}</strong></div></div></article>
    <article class="panel"><p class="eyebrow">RESOLUTION DEBT SCORE · INVESTIGATION PRIORITY</p><h3>${score}</h3><p class="helper">${Math.round(cluster.evidence_coverage * 100)}% evidence coverage. Missing signals are excluded and available weights are renormalized; this is not a recurrence probability.</p><div class="radar-components">${components}</div>${cluster.missing_signals?.length ? `<p class="helper">Missing: ${cluster.missing_signals.map(esc).join(', ')}</p>` : ''}</article></div>
    <article class="panel radar-status-panel"><div><p class="eyebrow">INVESTIGATION STATUS</p><p class="helper">Changes are recorded in the cluster audit history. New related cases after a verified resolution return it to monitoring.</p></div><form id="radarStatusForm" data-cluster="${esc(cluster.id)}"><select name="status">${[['new','New'],['investigating','Investigating'],['monitoring','Monitoring fix'],['resolved','Resolved / verified'],['dismissed','Dismissed']].map(([value,label]) => `<option value="${value}" ${cluster.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select><input name="note" placeholder="Optional status note" maxlength="400"><button class="secondary">Save status</button></form></article>
    <article class="panel"><p class="eyebrow">INCIDENT TIMELINE AND EVIDENCE</p><h3>${data.incidents.length} linked ticket${data.incidents.length === 1 ? '' : 's'}</h3><div class="radar-timeline">${incidents || '<p class="helper">No incident evidence is available.</p>'}</div></article>
    <article class="panel"><p class="eyebrow">RESOLUTION HISTORY</p><h3>Approaches and observed outcomes</h3><p class="helper">No later recurrence does not establish that an approach was effective. Recurrence uses a 30-day window after closure.</p>${history}</article>
    <article class="panel"><p class="eyebrow">RECOMMENDED ACTION</p><h3>Evidence-backed next steps</h3><ul class="radar-recommendations">${recommendations}</ul></article>
    <article class="panel"><div class="panel-head"><div><p class="eyebrow">ENGINEERING FOLLOW-UP</p><h3>Investigation brief</h3><p class="helper">Generate creates a persisted internal follow-up; it does not file an external engineering issue.</p></div><button class="primary" data-radar-generate="${esc(cluster.id)}">Generate engineering brief</button></div><div class="radar-followups">${followups || '<p class="helper">No engineering follow-up has been created for this cluster.</p>'}</div></article>
    <article class="panel"><p class="eyebrow">STATUS AUDIT</p>${(cluster.status_history || []).slice().reverse().map(event => `<p><b>${esc(event.status)}</b> by ${esc(event.changed_by)} · ${radarDate(event.changed_at)}${event.note ? `<br><span class="helper">${esc(event.note)}</span>` : ''}</p>`).join('') || '<p class="helper">No status changes recorded.</p>'}</article>`;
}

const radarWeights = { recurrence_after_closure: 25, incident_frequency: 20, customer_breadth: 20, temporary_workaround_rate: 15, support_effort: 10, severity: 10 };
const briefArrayFields = ['recommended_investigation', 'verification_plan', 'unknowns_and_limitations', 'evidence', 'what_has_been_tried'];
const briefTextFields = ['title', 'executive_summary', 'customer_impact', 'repeated_failure_pattern', 'root_cause_hypothesis'];
function renderEngineeringFollowup(item) {
  const brief = item.brief;
  const controls = briefTextFields.map(key => `<label>${esc(key.replaceAll('_', ' '))}<textarea name="${key}" rows="${key.includes('summary') || key.includes('hypothesis') ? 3 : 2}">${esc(brief[key] || '')}</textarea></label>`).join('');
  const lists = briefArrayFields.map(key => `<label>${esc(key.replaceAll('_', ' '))}<textarea name="${key}" rows="4">${esc((brief[key] || []).join('\n'))}</textarea></label>`).join('');
  return `<form class="radar-followup-form" data-followup="${esc(item.id)}"><div class="panel-head"><strong>${esc(item.id)} · ${esc(item.status)}</strong><span class="helper">Generated ${radarDate(brief.generated_at)} · ${brief.source_ticket_ids?.map(esc).join(', ') || 'No source IDs'}</span></div><div class="radar-brief-fields">${controls}${lists}</div><label>Follow-up status<select name="status"><option value="open" ${item.status === 'open' ? 'selected' : ''}>Open</option><option value="closed" ${item.status === 'closed' ? 'selected' : ''}>Closed</option></select></label><div class="action-row"><button class="secondary" type="button" data-copy-brief="${esc(item.id)}">Copy brief</button><button class="primary">Save approved brief</button></div></form>`;
}

async function openResolutionCluster(clusterId) {
  radarState.clusterId = clusterId;
  $('#radarDashboard').hidden = true;
  $('#radarDetail').hidden = false;
  $('#radarDetail').innerHTML = '<article class="panel empty-list">Loading incident evidence…</article>';
  try { renderRadarDetail(await api(`/api/resolution-radar/clusters/${encodeURIComponent(clusterId)}`)); }
  catch (error) { $('#radarDetail').innerHTML = `<article class="panel form-message error">${esc(error.message)}</article>`; }
}

window.loadResolutionRadar = () => loadResolutionRadarData().catch(error => toast(error.message));
window.loadCaseResolutionRadar = async caseId => {
  const panel = $('#ticketDurability');
  if (!panel || state.user?.role === 'customer') return;
  panel.hidden = false; panel.innerHTML = '<p class="helper">Loading resolution durability and related incidents…</p>';
  try {
    const result = await api(`/api/cases/${encodeURIComponent(caseId)}/resolution-radar`);
    const assessment = result.assessment;
    panel.innerHTML = `<p class="eyebrow">RESOLUTION DURABILITY AND RELATED INCIDENTS</p><h3>${assessment ? esc(assessment.classification.replaceAll('_', ' ')) : 'Assessment pending'}</h3>${assessment ? `<p><b>Model confidence:</b> ${Math.round(assessment.confidence * 100)}% · <b>Analysis:</b> ${radarDate(assessment.analyzed_at)}</p><p>${esc(assessment.rationale)}</p><p class="helper">Confidence is an AI assessment, not proof of customer outcome.${assessment.verification_evidence ? ` Verification evidence: ${esc(assessment.verification_evidence)}` : ' No verification signal is recorded.'}</p>${assessment.evidence_ids?.length ? `<p class="helper"><b>Evidence references:</b> ${assessment.evidence_ids.map(esc).join(', ')}</p>` : ''}${assessment.missing_information?.length ? `<p class="helper"><b>Missing information:</b> ${assessment.missing_information.map(esc).join('; ')}</p>` : ''}${assessment.approaches?.length ? `<ul>${assessment.approaches.map(item => `<li>${esc(item.approach)} — ${esc(item.outcome)}</li>`).join('')}</ul>` : ''}` : `<p class="helper">Durability assessment is unavailable. Resolve the ticket and allow its background analysis to finish, or use Resolution Debt Radar to analyze resolved history.</p>`}${result.related_ticket_ids?.length ? `<p><b>Related incidents:</b> ${result.related_ticket_ids.map(esc).join(', ')}</p>` : '<p class="helper">No recurring issue cluster is linked to this incident yet.</p>'}${result.recurrence_ticket_ids?.length ? `<p><b>Similar incidents reported after a related ticket closed:</b> ${result.recurrence_ticket_ids.map(esc).join(', ')}</p>` : ''}${result.cluster_id ? `<button class="text-button" data-open-radar-cluster="${esc(result.cluster_id)}">Open issue in Resolution Debt Radar →</button>` : ''}${assessment && state.current.ticket.state === 'Resolved' ? `<button class="secondary" data-radar-rerun="${esc(caseId)}">Re-run durability assessment</button>` : ''}`;
  } catch (error) { panel.innerHTML = `<p class="form-message error">Could not load resolution durability: ${esc(error.message)}</p>`; }
};

for (const id of ['radarWindow', 'radarService', 'radarPriority', 'radarStatus', 'radarSort']) {
  $(`#${id}`).addEventListener('change', async event => {
    radarState[{radarWindow:'window',radarService:'service',radarPriority:'priority',radarStatus:'status',radarSort:'sort'}[id]] = event.target.value;
    await loadResolutionRadarData().catch(error => toast(error.message));
  });
}
let radarSearchTimer;
$('#radarSearch').addEventListener('input', event => {
  radarState.search = event.target.value;
  clearTimeout(radarSearchTimer);
  radarSearchTimer = setTimeout(() => loadResolutionRadarData().catch(error => toast(error.message)), 250);
});
$('#radarAnalyzeMissing').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try {
    const result = await api('/api/resolution-radar/analyze-missing', { method: 'POST' });
    toast(result.scheduled ? `${result.scheduled} resolution assessments queued.${result.remaining ? ` ${result.remaining} more remain for a later batch.` : ''} Refresh this view when they finish.` : result.message);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-view="resolution-radar"]');
  if (nav) { radarState.clusterId = null; $('#radarDetail').hidden = true; $('#radarDashboard').hidden = false; }
  const open = event.target.closest('[data-radar-open]');
  if (open) { await openResolutionCluster(open.dataset.radarOpen); return; }
  if (event.target.closest('[data-radar-back]')) {
    $('#radarDetail').hidden = true; $('#radarDashboard').hidden = false; radarState.clusterId = null;
    await loadResolutionRadarData().catch(error => toast(error.message)); return;
  }
  const detail = event.target.closest('[data-open-radar-cluster]');
  if (detail) { showView('resolution-radar'); await openResolutionCluster(detail.dataset.openRadarCluster); return; }
  const ticket = event.target.closest('[data-radar-ticket]');
  if (ticket) { await openTicketDetails(ticket.dataset.radarTicket); return; }
  const generate = event.target.closest('[data-radar-generate]');
  if (generate) {
    generate.disabled = true; generate.textContent = 'Generating…';
    try {
      const result = await api(`/api/resolution-radar/clusters/${encodeURIComponent(generate.dataset.radarGenerate)}/engineering-followups`, { method: 'POST' });
      toast('Internal engineering follow-up created. Review and save the brief.');
      await openResolutionCluster(result.cluster_id);
    } catch (error) { toast(error.message); generate.disabled = false; generate.textContent = 'Generate engineering brief'; }
    return;
  }
  const copy = event.target.closest('[data-copy-brief]');
  if (copy) {
    const form = copy.closest('form'); const lines = [];
    for (const field of briefTextFields) lines.push(`${field.replaceAll('_', ' ').toUpperCase()}\n${form.elements[field].value}`);
    for (const field of briefArrayFields) lines.push(`${field.replaceAll('_', ' ').toUpperCase()}\n${form.elements[field].value}`);
    const sourceIds = form.closest('.radar-followup-form').querySelector('.panel-head .helper')?.textContent || '';
    lines.push(`SOURCE METADATA\n${sourceIds}`);
    try { await navigator.clipboard.writeText(lines.join('\n\n')); toast('Brief copied.'); } catch (_) { toast('Clipboard access is unavailable in this browser.'); }
    return;
  }
  const rerun = event.target.closest('[data-radar-rerun]');
  if (rerun) {
    rerun.disabled = true;
    try {
      const result = await api(`/api/cases/${encodeURIComponent(rerun.dataset.radarRerun)}/resolution-radar`, { method: 'POST' });
      toast(result.message);
    } catch (error) { toast(error.message); rerun.disabled = false; }
    return;
  }
  const link = event.target.closest('[data-radar-review]');
  if (link) return;
});

document.addEventListener('change', async event => {
  const select = event.target.closest('[data-radar-review]');
  if (!select) return;
  try {
    await api(`/api/resolution-radar/clusters/${encodeURIComponent(select.dataset.radarReview)}/links/${encodeURIComponent(select.dataset.radarCase)}`, {
      method: 'PATCH', body: JSON.stringify({ decision: select.value }) });
    toast('Incident match review saved.');
    await openResolutionCluster(select.dataset.radarReview);
  } catch (error) { toast(error.message); }
});

document.addEventListener('submit', async event => {
  const statusForm = event.target.closest('#radarStatusForm');
  if (statusForm) {
    event.preventDefault();
    try {
      const form = new FormData(statusForm);
      await api(`/api/resolution-radar/clusters/${encodeURIComponent(statusForm.dataset.cluster)}`, {
        method: 'PATCH', body: JSON.stringify({ status: form.get('status'), note: form.get('note') }) });
      toast('Investigation status saved.'); await openResolutionCluster(statusForm.dataset.cluster);
    } catch (error) { toast(error.message); }
    return;
  }
  const followupForm = event.target.closest('.radar-followup-form');
  if (!followupForm) return;
  event.preventDefault();
  try {
    const form = new FormData(followupForm);
    const data = await api(`/api/resolution-radar/clusters/${encodeURIComponent(radarState.clusterId)}`);
    const existing = data.followups.find(item => item.id === followupForm.dataset.followup);
    if (!existing) throw new Error('Engineering follow-up not found.');
    const brief = { ...existing.brief };
    for (const key of briefTextFields) brief[key] = String(form.get(key) || '').trim();
    for (const key of briefArrayFields) brief[key] = String(form.get(key) || '').split('\n').map(line => line.trim()).filter(Boolean);
    await api(`/api/resolution-radar/engineering-followups/${encodeURIComponent(followupForm.dataset.followup)}`, {
      method: 'PATCH', body: JSON.stringify({ brief, status: form.get('status') }) });
    toast('Approved brief saved.'); await openResolutionCluster(radarState.clusterId);
  } catch (error) { toast(error.message); }
});
