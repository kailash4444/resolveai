let transcriptSources = [], transcriptSelected = null, callAnalyticsTimer;
let transcriptOwner = null;
function durationLabel(seconds) {
  if (seconds == null) return 'Not recorded';
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}
function resetTranscriptFilters() {
  ['transcriptSearch', 'transcriptTechnicianFilter', 'transcriptServiceFilter', 'transcriptDurationMin', 'transcriptDurationMax'].forEach(id => { $('#' + id).value = ''; });
}
const speakerName = source => turn => turn.speaker === 'AI Agent' ? 'ResolveAI' : turn.speaker === 'Customer' ? source.customer : source.technician;
function overallLabel(overall) {
  return overall?.score != null ? `${overall.score} / 600 · ${overall.percentage}%` : overall?.status === 'incomplete' ? `Partial · ${overall.scored_metrics} of 6 metrics scored` : 'Pending';
}
function overallBadge(overall) {
  if (overall?.score != null) return `<span class="badge ${overall.percentage >= 80 ? 'badge--ok' : 'badge--high'}">${overall.percentage >= 80 ? '✓' : '◆'} ${esc(overallLabel(overall))}</span>`;
  return `<span class="badge badge--low">○ ${esc(overallLabel(overall))}</span>`;
}
function qualityAssessment(source, open = false) {
  const audit = source.quality_audit;
  if (!audit) return '<p class="sec">○ Not assessed yet. Completed calls are assessed in the background.</p>';
  return `<p class="help">AI assessment by ${esc(audit.model)} · ${esc(new Date(audit.assessed_at).toLocaleString())}. Scores are suggestions for a reviewer.</p>${Object.entries(audit.metrics).map(([key, metric]) => `<details ${open ? 'open' : ''}><summary>${esc(key.replaceAll('_', ' '))} · ${metric.score === null ? '○ Not enough evidence' : `${metric.score} / 100`}</summary><div class="stack stack--sm"><blockquote class="quote">${esc(metric.evidence)}</blockquote><p class="sec">${esc(metric.explanation)}</p><p class="small"><strong>Improve:</strong> ${esc(metric.improvement)}</p></div></details>`).join('')}`;
}

window.loadTranscripts = async () => {
  const list = $('#transcriptList');
  if (!transcriptSources.length) list.innerHTML = '<div class="stack" role="status" aria-label="Loading transcripts"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div></div>';
  try {
    const userId = state.user?.id, sources = await api('/api/transcripts');
    if (state.user?.id !== userId) return;
    transcriptSources = sources;
    analyticsOptions('#transcriptTechnicianFilter', sources.map(source => source.technician), 'All technicians');
    analyticsOptions('#transcriptServiceFilter', sources.map(source => source.service || 'General'), 'All services');
    $('#transcriptTechnicianLabel').hidden = state.user.role !== 'admin';
    if (state.user.role !== 'admin') $('#transcriptTechnicianFilter').value = '';
    if (transcriptOwner !== userId) { resetTranscriptFilters(); transcriptSelected = null; $('#transcriptDetail').hidden = true; transcriptOwner = userId; }
    $('#transcriptScope').textContent = state.user.role === 'admin' ? 'Every recorded call and incident conversation.' : state.user.role === 'technician' ? 'Conversations assigned to you.' : 'Your own support conversations.';
    renderTranscripts();
  } catch (error) {
    list.innerHTML = `<div class="alert" role="alert"><strong>✕ Couldn’t load transcripts.</strong><span class="sec">${esc(error.message)}</span><button type="button" class="pop pop--quiet pop--sm" data-retry-transcripts>Retry</button></div>`;
  }
};

function renderTranscripts() {
  const query = $('#transcriptSearch').value.trim().toLowerCase();
  const technician = $('#transcriptTechnicianFilter').value, service = $('#transcriptServiceFilter').value;
  const minInput = $('#transcriptDurationMin'), maxInput = $('#transcriptDurationMax');
  const min = minInput.value === '' ? 0 : Number(minInput.value), max = maxInput.value === '' ? Infinity : Number(maxInput.value);
  const allLengths = minInput.value === '' && maxInput.value === '';
  const invalid = !minInput.validity.valid || !maxInput.validity.valid || min > max;
  [minInput, maxInput].forEach(input => input.setAttribute('aria-invalid', String(invalid)));
  $('#transcriptDurationLabel').textContent = invalid ? '✕ Use non-negative minutes, with the shortest no longer than the longest' : allLengths ? 'All lengths' : max === Infinity ? `At least ${minInput.value} min` : minInput.value === '' ? `Up to ${maxInput.value} min` : `${minInput.value}–${maxInput.value} min`;
  const sources = invalid ? [] : transcriptSources.filter(source => (!query || [source.source_id, source.ticket_number, source.customer, source.technician, source.service].join(' ').toLowerCase().includes(query)) &&
    (!technician || source.technician === technician) && (!service || (source.service || 'General') === service) &&
    (allLengths || source.duration_seconds != null && source.duration_seconds / 60 >= min && source.duration_seconds / 60 <= max));
  if (!sources.some(source => source.source_id === transcriptSelected)) { transcriptSelected = null; $('#transcriptDetail').hidden = true; }
  $('#transcriptCount').textContent = invalid ? 'Check the call length range.' : `${sources.length} of ${transcriptSources.length} conversations`;
  $('#transcriptList').innerHTML = sources.length ? `<div class="tbl-wrap" role="region" aria-label="Conversations" tabindex="0"><table class="tbl"><caption class="sr">Conversations matching the filters</caption><thead><tr><th scope="col">Conversation</th><th scope="col">Incident</th><th scope="col" class="col-opt">Customer</th><th scope="col" class="col-opt">Technician</th><th scope="col" class="col-opt">Length</th><th scope="col"><span class="sr">Action</span></th></tr></thead><tbody>${sources.map(source => `<tr${source.source_id === transcriptSelected ? ' aria-current="true"' : ''}><td><span class="mono">${esc(source.call_id || source.source_id)}</span></td><td>${esc(source.ticket_number || 'Pending')}</td><td class="col-opt">${esc(source.customer)}</td><td class="col-opt">${esc(source.technician)}</td><td class="col-opt">${durationLabel(source.duration_seconds)}</td><td><button type="button" class="pop pop--quiet pop--sm" data-transcript="${esc(source.source_id)}"><span>View<span class="sr"> transcript ${esc(source.call_id || source.ticket_number || source.source_id)}</span></span></button></td></tr>`).join('')}</tbody></table></div>`
    : invalid ? '<p class="sec">Enter a valid length range to see matching conversations.</p>'
      : transcriptSources.length ? '<div class="empty"><h2 class="h3">No conversations match</h2><p class="sec">Change the filters or clear them.</p></div>' : '<div class="empty"><h2 class="h3">No conversations yet</h2><p class="sec">Call transcripts and conversation intakes appear here.</p></div>';
}

async function openTranscript(id) {
  transcriptSelected = id;
  const detail = $('#transcriptDetail');
  detail.hidden = false; detail.innerHTML = '<div class="skeleton" role="status" aria-label="Loading transcript"></div>';
  let source;
  try { source = await api(`/api/transcripts/${encodeURIComponent(id)}`); }
  catch (error) { detail.innerHTML = `<div class="alert" role="alert"><strong>✕ Couldn’t open this transcript.</strong><span class="sec">${esc(error.message)}</span></div>`; return; }
  if (transcriptSelected !== id) return;
  renderTranscripts();
  detail.innerHTML = `<div class="row row--between"><div><p class="kicker"><span class="mono">${esc(source.call_id || 'Incident conversation')}</span></p><h2 class="h3" id="transcriptDetailTitle">${esc(source.ticket_number || source.source_id)}</h2></div><button type="button" class="pop pop--quiet pop--sm" data-download-transcript="${esc(id)}">Download</button></div>
    <p class="help">Customer: ${esc(source.customer)} · Technician: ${esc(source.technician)}</p><p class="form-status" id="transcriptDownloadStatus" role="status"></p>
    ${source.transcript.length ? transcriptTurns(source.transcript, speakerName(source)) : '<p class="sec">This conversation has no recorded turns.</p>'}
    ${source.quality_audit ? `<section class="stack stack--sm" aria-labelledby="assessTitle"><div class="row row--between"><h3 class="h4" id="assessTitle">Call quality assessment</h3>${overallBadge(source.overall_quality)}</div>${qualityAssessment(source)}</section>` : ''}`;
  detail.focus({preventScroll: true});
  if (window.matchMedia('(max-width: 1024px)').matches) detail.scrollIntoView({block: 'start'});
}

// Fetch first so a failed export is reported here instead of navigating to an error page.
async function downloadTranscript(id) {
  const status = $('#transcriptDownloadStatus');
  status.className = 'form-status'; status.textContent = 'Preparing download…';
  try {
    const response = await fetch(`/api/transcripts/${encodeURIComponent(id)}/download`);
    if (!response.ok) { let detail = `Request failed (${response.status})`; try { detail = (await response.json()).detail || detail; } catch (_) {} throw new Error(detail); }
    const name = /filename="?([^";]+)"?/.exec(response.headers.get('Content-Disposition') || '')?.[1] || `${id}.txt`;
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `✓ Downloaded ${name}`;
  } catch (error) { status.className = 'form-status err'; status.textContent = `✕ Download failed: ${error.message}`; }
}

let callAnalyticsRequest = 0, callFilterTimer;
window.loadCallAnalytics = async () => {
  const request = ++callAnalyticsRequest, userId = state.user?.id, notice = $('#callAnalyticsStatus');
  try {
    const params = new URLSearchParams({call_id: $('#callAnalyticsIdFilter').value.trim(), technician: $('#callAnalyticsTechnicianFilter').value, service_name: $('#callAnalyticsServiceFilter').value});
    const data = await api('/api/call-analytics?' + params);
    if (request !== callAnalyticsRequest || state.user?.id !== userId) return;
    analyticsOptions('#callAnalyticsTechnicianFilter', data.filters.technicians, 'All technicians');
    analyticsOptions('#callAnalyticsServiceFilter', data.filters.services, 'All services');
    $('#callAnalyticsFilterCount').textContent = `${data.total} of ${data.available_total} calls`;
    $('#callOverallScore').textContent = overallLabel(data.overall);
    const pending = data.total - data.overall.evaluated_count;
    $('#callOverallCoverage').textContent = !data.total ? 'No calls in this selection.' : `Average of ${data.overall.evaluated_count} fully scored call${data.overall.evaluated_count === 1 ? '' : 's'}.${pending ? ` ${pending} pending or partially scored — not included.` : ''}`;
    notice.hidden = !(data.total && pending);
    notice.className = 'alert alert--info'; notice.setAttribute('role', 'status');
    notice.innerHTML = `<strong>◆ Partial data.</strong><span class="sec">${pending} of ${data.total} calls aren’t fully scored yet, so quality averages cover only the rest.</span>`;
    $('#callAnalyticsRows').innerHTML = data.calls.length ? data.calls.map(call => `<tr><td><span class="mono">${esc(call.id)}</span></td><td>${esc(call.technician)}</td><td class="col-opt">${esc(call.service)}</td><td>${call.overall.score === null ? esc(overallLabel(call.overall)) : `${call.overall.score} / 600`}</td><td>${call.overall.percentage === null ? '—' : call.overall.percentage + '%'}</td></tr>`).join('') : '<tr><td colspan="5">No calls match these filters.</td></tr>';
    $('#callTotal').textContent = data.total; $('#callCompletion').textContent = `Count · ${data.completion_rate}% completed`;
    $('#callDuration').textContent = data.total ? `${Math.round(data.average_duration_seconds / 60)} min` : '—';
    $('#callWait').textContent = data.total ? `${data.average_wait_seconds} s` : '—'; $('#callAssessed').textContent = data.audited;
    $('#callQualityMetrics').innerHTML = data.metrics.map(metric => `<article class="metric"><h3 class="metric__label">${esc(metric.label)}</h3><p class="metric__value">${metric.score === null ? '—' : metric.score + '%'}</p><p class="help">${esc(metric.definition)}</p><p class="help">${metric.score === null ? 'No scored calls yet' : `Percent · average of ${metric.evaluated_count} scored calls`}</p></article>`).join('');
    renderAnalyticsBars('#callServiceChart', data.services, data.total, 'calls'); renderAnalyticsBars('#callStateChart', data.states, data.total, 'calls'); renderAnalyticsBars('#callDailyChart', data.daily, data.total, 'calls');
    $('#callTechnicianRows').innerHTML = data.technicians.length ? data.technicians.map(t => `<tr><th scope="row">${esc(t.name)}</th><td>${t.total}</td><td>${t.completed}</td><td>${esc(overallLabel(t.overall))}</td></tr>`).join('') : '<tr><td colspan="4">No technician calls in this selection.</td></tr>';
  } catch (error) {
    if (request !== callAnalyticsRequest) return;
    notice.hidden = false; notice.className = 'alert'; notice.setAttribute('role', 'alert');
    notice.innerHTML = `<strong>✕ Call analytics are unavailable.</strong><span class="sec">${esc(error.message)}</span><button type="button" class="pop pop--quiet pop--sm" data-retry-call-analytics>Retry</button>`;
  }
};

let callQaSources = [], callQaSelected = null;
window.loadCallQA = async () => {
  try {
    const userId = state.user?.id;
    const sources = await api('/api/transcripts');
    if (state.user?.id !== userId) return;
    callQaSources = sources.filter(source => source.call_id && ['Completed', 'Callback requested', 'Failed'].includes(source.status));
    renderCallQA();
    if (!callQaSources.some(source => source.source_id === callQaSelected)) { callQaSelected = null; $('#callQaDetail').hidden = true; }
    await refreshCallAudit();
  } catch (error) { $('#callAuditStatus').textContent = `✕ ${error.message}`; }
};
function renderCallQA() {
  const query = $('#callQaSearch').value.trim().toLowerCase();
  const sources = callQaSources.filter(source => !query || [source.call_id, source.ticket_number, source.customer, source.technician].join(' ').toLowerCase().includes(query));
  $('#callQaList').innerHTML = sources.length ? `<div class="tbl-wrap" role="region" aria-label="Call audits" tabindex="0"><table class="tbl"><caption class="sr">Completed calls and their quality status</caption><thead><tr><th scope="col">Call</th><th scope="col" class="col-opt">Incident</th><th scope="col" class="col-opt">Technician</th><th scope="col">Call status</th><th scope="col">Quality</th><th scope="col"><span class="sr">Action</span></th></tr></thead><tbody>${sources.map(source => `<tr><td><span class="mono">${esc(source.call_id)}</span></td><td class="col-opt">${esc(source.ticket_number || 'Pending')}</td><td class="col-opt">${esc(source.technician)}</td><td>${callBadge(source.status)}</td><td>${overallBadge(source.overall_quality)}</td><td><button type="button" class="pop pop--quiet pop--sm" data-call-qa="${esc(source.source_id)}"><span>Review<span class="sr"> audit for ${esc(source.call_id)}</span></span></button></td></tr>`).join('')}</tbody></table></div>`
    : callQaSources.length ? '<p class="sec">No completed calls match this search.</p>' : '<div class="empty"><h2 class="h3">No completed calls yet</h2><p class="sec">Finished browser calls appear here for quality review.</p></div>';
}
async function openCallQA(id, scroll = true) {
  callQaSelected = id;
  const userId = state.user?.id, source = await api(`/api/transcripts/${encodeURIComponent(id)}`);
  if (callQaSelected !== id || state.user?.id !== userId) return;
  const detail = $('#callQaDetail'); detail.hidden = false;
  detail.innerHTML = `<div class="row row--between"><div><p class="kicker">Call quality audit</p><h2 class="h3"><span class="mono">${esc(source.call_id)}</span></h2></div>${overallBadge(source.overall_quality)}</div><p class="help">Incident ${esc(source.ticket_number || 'pending')} · Customer: ${esc(source.customer)} · Technician: ${esc(source.technician)}</p>${source.quality_audit ? qualityAssessment(source, true) : '<p class="sec">○ Not assessed yet. Select Evaluate completed calls to assess it now.</p>'}<details><summary>Transcript</summary>${transcriptTurns(source.transcript, speakerName(source))}</details>`;
  if (scroll) { detail.focus({preventScroll: true}); if (window.matchMedia('(max-width: 1024px)').matches) detail.scrollIntoView({block: 'start'}); }
}

async function refreshCallAudit() {
  clearTimeout(callAnalyticsTimer);
  if (state.user?.role === 'customer' || !state.user) return;
  const job = await api('/api/call-analytics/audit-job'), running = job.status === 'running';
  $('#evaluateCalls').disabled = running;
  $('#evaluateCalls').toggleAttribute('aria-busy', running);
  $('#evaluateCalls').textContent = running ? 'Evaluating calls…' : 'Evaluate completed calls';
  jobProgress($('#callAuditProgress'), job);
  $('#callAuditStatus').textContent = job.status === 'idle' ? 'Completed calls are assessed in the background. Evaluate now to assess any that are missing.' : `${running ? '● Evaluating' : job.failed ? '◆ Finished with problems' : '✓ Finished'}: ${job.completed} done, ${job.failed} failed, ${job.skipped} skipped of ${job.total} calls.${job.failed ? ' Check the AI connection, then evaluate again.' : ''}`;
  if ($('#view-qa').classList.contains('active') && reportTabs.qa === 'calls') {
    if (callQaSelected) await openCallQA(callQaSelected, false);
    if (running) callAnalyticsTimer = setTimeout(window.loadCallQA, 3000);
  }
}

$('#transcriptSearch').addEventListener('input', renderTranscripts);
['transcriptTechnicianFilter', 'transcriptServiceFilter'].forEach(id => $('#' + id).addEventListener('change', renderTranscripts));
['Min', 'Max'].forEach(bound => $('#transcriptDuration' + bound).addEventListener('input', renderTranscripts));
$('#clearTranscriptFilters').addEventListener('click', () => { resetTranscriptFilters(); renderTranscripts(); $('#transcriptSearch').focus(); });
$('#callQaSearch').addEventListener('input', renderCallQA);
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-transcript]');
  if (target) await openTranscript(target.dataset.transcript);
  const audit = event.target.closest('[data-call-qa]');
  if (audit) { try { await openCallQA(audit.dataset.callQa); } catch (error) { $('#callQaDetail').hidden = false; $('#callQaDetail').innerHTML = `<div class="alert" role="alert"><strong>✕ Couldn’t open this audit.</strong><span class="sec">${esc(error.message)}</span></div>`; } }
  const download = event.target.closest('[data-download-transcript]');
  if (download) downloadTranscript(download.dataset.downloadTranscript);
  if (event.target.closest('[data-retry-transcripts]')) window.loadTranscripts();
  if (event.target.closest('[data-retry-call-analytics]')) window.loadCallAnalytics();
});
$('#evaluateCalls').addEventListener('click', async () => {
  $('#evaluateCalls').disabled = true;
  try { await api('/api/call-analytics/evaluate', {method: 'POST', body: '{}'}); await window.loadCallQA(); }
  catch (error) { $('#callAuditStatus').textContent = `✕ ${error.message}`; $('#evaluateCalls').disabled = false; }
});

$('#callAnalyticsIdFilter').addEventListener('input', () => { ++callAnalyticsRequest; clearTimeout(callFilterTimer); callFilterTimer = setTimeout(window.loadCallAnalytics, 200); });
['Technician', 'Service'].forEach(field => $('#callAnalytics' + field + 'Filter').addEventListener('change', () => { clearTimeout(callFilterTimer); window.loadCallAnalytics(); }));
$('#callAnalyticsResetFilters').addEventListener('click', () => { clearTimeout(callFilterTimer); ['Id', 'Technician', 'Service'].forEach(field => $('#callAnalytics' + field + 'Filter').value = ''); window.loadCallAnalytics(); });
