let transcriptSources=[], transcriptSelected=null, callAnalyticsTimer;
let transcriptOwner=null;
function durationLabel(seconds) {
  if(seconds==null) return 'Not recorded';
  return `${Math.floor(seconds/60)}m ${Math.round(seconds%60)}s`;
}
function resetTranscriptFilters() {
  ['transcriptSearch','transcriptTechnicianFilter','transcriptServiceFilter'].forEach(id=>$('#'+id).value='');
  $('#transcriptDurationMin').value='';$('#transcriptDurationMax').value='';
}

window.loadTranscripts = async () => {
  try {
    const userId=state.user?.id,sources=await api('/api/transcripts');
    if(state.user?.id!==userId) return;
    transcriptSources=sources;
    analyticsOptions('#transcriptTechnicianFilter',sources.map(source=>source.technician),'All technicians');
    analyticsOptions('#transcriptServiceFilter',sources.map(source=>source.service || 'General'),'All services');
    $('#transcriptTechnicianLabel').hidden=state.user.role!=='admin';
    if(state.user.role!=='admin') $('#transcriptTechnicianFilter').value='';
    if(transcriptOwner!==userId) {resetTranscriptFilters();transcriptSelected=null;$('#transcriptDetail').hidden=true;transcriptOwner=userId;}
    $('#transcriptScope').textContent=state.user.role==='admin' ? 'All recorded calls and incident conversations.' : state.user.role==='technician' ? 'Conversations assigned to you.' : 'Your own support conversations.';
    renderTranscripts();
    if (!transcriptSources.some(source=>source.source_id===transcriptSelected)) {transcriptSelected=null;$('#transcriptDetail').hidden=true;}
  } catch(error) {$('#transcriptList').textContent=error.message;}
};

function renderTranscripts() {
  const query=$('#transcriptSearch').value.trim().toLowerCase();
  const technician=$('#transcriptTechnicianFilter').value,service=$('#transcriptServiceFilter').value;
  const minInput=$('#transcriptDurationMin'),maxInput=$('#transcriptDurationMax');
  const min=minInput.value===''?0:Number(minInput.value),max=maxInput.value===''?Infinity:Number(maxInput.value);
  const allLengths=minInput.value==='' && maxInput.value==='';
  const invalid=!minInput.validity.valid || !maxInput.validity.valid || min>max;
  [minInput,maxInput].forEach(input=>input.setAttribute('aria-invalid',String(invalid)));
  $('#transcriptDurationLabel').textContent=invalid?'Enter non-negative lengths with minimum no greater than maximum.':allLengths?'All lengths':max===Infinity?`At least ${minInput.value} min`:minInput.value===''?`Up to ${maxInput.value} min`:`${minInput.value} – ${maxInput.value} min`;
  const sources=invalid?[]:transcriptSources.filter(source=>(!query || [source.source_id,source.ticket_number,source.customer,source.technician,source.service].join(' ').toLowerCase().includes(query)) &&
    (!technician || source.technician===technician) && (!service || (source.service || 'General')===service) &&
    (allLengths || source.duration_seconds!=null && source.duration_seconds/60>=min && source.duration_seconds/60<=max));
  if(!sources.some(source=>source.source_id===transcriptSelected)) {transcriptSelected=null;$('#transcriptDetail').hidden=true;}
  $('#transcriptCount').textContent=`${sources.length} of ${transcriptSources.length} conversations`;
  $('#transcriptList').className=sources.length?'table-wrap':'empty-list';
  $('#transcriptList').innerHTML=sources.length?`<table><thead><tr><th>Call / Source ID</th><th>Incident</th><th>Customer</th><th>Technician</th><th>Service</th><th>Call length</th><th></th></tr></thead><tbody>${sources.map(source=>`<tr class="transcript-list-row" data-transcript="${esc(source.source_id)}"><td>${esc(source.call_id || source.source_id)}</td><td>${esc(source.ticket_number || 'Pending')}</td><td>${esc(source.customer)}</td><td>${esc(source.technician)}</td><td>${esc(source.service)}</td><td>${durationLabel(source.duration_seconds)}</td><td><button class="text-button" data-transcript="${esc(source.source_id)}">View transcript</button></td></tr>`).join('')}</tbody></table>`:'No conversations match these filters.';
  if(invalid) {$('#transcriptCount').textContent='Check the call length range.';$('#transcriptList').textContent='Enter a valid call length range to view matching transcripts.';}
}

async function openTranscript(id) {
  transcriptSelected=id;
  const source=await api(`/api/transcripts/${encodeURIComponent(id)}`);
  if (transcriptSelected!==id) return;
  const detail=$('#transcriptDetail');detail.hidden=false;
  detail.innerHTML=`<div class="panel-head"><div><p class="eyebrow">${esc(source.call_id || 'INCIDENT CONVERSATION')}</p><h3>${esc(source.ticket_number || source.source_id)}</h3><p class="helper">Customer: ${esc(source.customer)} · Technician: ${esc(source.technician)}</p></div><a class="secondary transcript-download" href="/api/transcripts/${encodeURIComponent(id)}/download">Download transcript</a></div><div class="live-transcript">${source.transcript.map(turn=>`<div class="transcript-turn"><b>${esc(turn.speaker)} · ${esc(turn.speaker_name || (turn.speaker==='AI Agent'?'ResolveAI':turn.speaker==='Customer'?source.customer:source.technician))}</b><small>${turn.timestamp?esc(new Date(turn.timestamp).toLocaleTimeString()):''}</small><p>${esc(turn.text)}</p></div>`).join('')}</div>${source.quality_audit?`<section class="transcript-assessment"><h4>Call quality assessment</h4><p class="overall-score">${esc(overallLabel(source.overall_quality))}</p><p class="helper">${esc(source.quality_audit.model)} · ${new Date(source.quality_audit.assessed_at).toLocaleString()}</p>${Object.entries(source.quality_audit.metrics).map(([key,metric])=>`<details><summary>${esc(key.replaceAll('_',' '))} · ${metric.score===null?'Not enough evidence':metric.score+'/100'}</summary><blockquote>${esc(metric.evidence)}</blockquote><p>${esc(metric.explanation)}</p><p><b>Improvement:</b> ${esc(metric.improvement)}</p></details>`).join('')}</section>`:''}`;
  detail.scrollIntoView({behavior:'smooth',block:'start'});
}

function overallLabel(overall) {
  return overall?.score != null ? `${overall.score} / 600 · ${overall.percentage}%` : overall?.status==='incomplete' ? `Incomplete · ${overall.scored_metrics}/6 metrics` : 'Pending';
}
let callAnalyticsRequest=0,callFilterTimer;
window.loadCallAnalytics=async () => {
  const request=++callAnalyticsRequest,userId=state.user?.id;
  try {
    const params=new URLSearchParams({call_id:$('#callAnalyticsIdFilter').value.trim(),technician:$('#callAnalyticsTechnicianFilter').value,service_name:$('#callAnalyticsServiceFilter').value});
    const data=await api('/api/call-analytics?'+params);
    if(request!==callAnalyticsRequest || state.user?.id!==userId) return;
    analyticsOptions('#callAnalyticsTechnicianFilter',data.filters.technicians,'All technicians');
    analyticsOptions('#callAnalyticsServiceFilter',data.filters.services,'All services');
    $('#callAnalyticsFilterCount').textContent=`${data.total} of ${data.available_total} calls`;
    $('#callOverallScore').textContent=overallLabel(data.overall);
    $('#callOverallCoverage').textContent=`Average across ${data.overall.evaluated_count} fully scored calls. ${data.total-data.overall.evaluated_count} pending or incomplete.`;
    $('#callAnalyticsRows').innerHTML=data.calls.length?data.calls.map(call=>`<tr><td>${esc(call.id)}</td><td>${esc(call.technician)}</td><td>${esc(call.service)}</td><td>${call.overall.score===null?esc(overallLabel(call.overall)):call.overall.score+' / 600'}</td><td>${call.overall.percentage===null?'—':call.overall.percentage+'%'}</td></tr>`).join(''):'<tr><td colspan="5">No calls match these filters.</td></tr>';
    $('#callTotal').textContent=data.total;$('#callCompletion').textContent=`${data.completion_rate}% completed`;
    $('#callDuration').textContent=`${Math.round(data.average_duration_seconds/60)} min`;
    $('#callWait').textContent=`${data.average_wait_seconds}s`;$('#callAssessed').textContent=data.audited;
    $('#callQualityMetrics').innerHTML=data.metrics.map(metric=>`<article class="quality-metric"><h4>${esc(metric.label)}</h4><strong>${metric.score===null?'Pending':metric.score+'%'}</strong><p class="helper">${esc(metric.definition)}</p><small>${metric.evaluated_count} scored calls</small></article>`).join('');
    renderAnalyticsBars('#callServiceChart',data.services,data.total);renderAnalyticsBars('#callStateChart',data.states,data.total);renderAnalyticsBars('#callDailyChart',data.daily,data.total);
    $('#callTechnicianRows').innerHTML=data.technicians.map(t=>`<tr><td>${esc(t.name)}</td><td>${t.total}</td><td>${t.completed}</td><td>${esc(overallLabel(t.overall))}</td></tr>`).join('');
    $('#callAnalyticsStatus').textContent='';
  } catch(error) {if(request===callAnalyticsRequest) $('#callAnalyticsStatus').textContent=error.message;}
};

let callQaSources=[], callQaSelected=null;
window.loadCallQA=async () => {
  try {
    const userId=state.user?.id;
    const sources=await api('/api/transcripts');
    if(state.user?.id!==userId) return;
    callQaSources=sources.filter(source=>source.call_id && ['Completed','Callback requested','Failed'].includes(source.status));
    renderCallQA();
    if(!callQaSources.some(source=>source.source_id===callQaSelected)) {callQaSelected=null;$('#callQaDetail').hidden=true;}
    await refreshCallAudit();
  } catch(error) {$('#callAuditStatus').textContent=error.message;}
};
function renderCallQA() {
  const query=$('#callQaSearch').value.trim().toLowerCase();
  const sources=callQaSources.filter(source=>!query || [source.call_id,source.ticket_number,source.customer,source.technician].join(' ').toLowerCase().includes(query));
  $('#callQaList').innerHTML=sources.length?`<table><thead><tr><th>Call ID</th><th>Incident</th><th>Customer</th><th>Technician</th><th>Call status</th><th>Overall quality</th><th></th></tr></thead><tbody>${sources.map(source=>`<tr><td>${esc(source.call_id)}</td><td>${esc(source.ticket_number || 'Pending')}</td><td>${esc(source.customer)}</td><td>${esc(source.technician)}</td><td>${esc(source.status)}</td><td>${esc(overallLabel(source.overall_quality))}</td><td><button class="text-button" data-call-qa="${esc(source.source_id)}">Review audit</button></td></tr>`).join('')}</tbody></table>`:'No completed call conversations match this search.';
}
async function openCallQA(id, scroll=true) {
  callQaSelected=id;
  const userId=state.user?.id,source=await api(`/api/transcripts/${encodeURIComponent(id)}`);
  if(callQaSelected!==id || state.user?.id!==userId) return;
  const audit=source.quality_audit,detail=$('#callQaDetail');detail.hidden=false;
  detail.innerHTML=`<div class="panel-head"><div><p class="eyebrow">CALL QUALITY AUDIT</p><h3>${esc(source.call_id)}</h3><p class="helper">Incident: ${esc(source.ticket_number || 'Pending')} · Customer: ${esc(source.customer)} · Technician: ${esc(source.technician)}</p></div></div><p class="overall-score">Overall quality: ${esc(overallLabel(source.overall_quality))}</p>${audit?`<div class="transcript-assessment"><p class="helper">${esc(audit.model)} · ${new Date(audit.assessed_at).toLocaleString()}</p>${Object.entries(audit.metrics).map(([key,metric])=>`<details open><summary>${esc(key.replaceAll('_',' '))} · ${metric.score===null?'Not enough evidence':metric.score+'/100'}</summary><blockquote>${esc(metric.evidence)}</blockquote><p>${esc(metric.explanation)}</p><p><b>Improvement:</b> ${esc(metric.improvement)}</p></details>`).join('')}</div>`:'<h4>QA pending</h4><p>Call quality is assessed in the background. Use Evaluate completed calls to assess existing conversations.</p>'}<details class="incident-transcript"><summary>View transcript</summary><div class="live-transcript">${source.transcript.map(turn=>`<div class="transcript-turn"><b>${esc(turn.speaker)} · ${esc(turn.speaker_name || (turn.speaker==='AI Agent'?'ResolveAI':turn.speaker==='Customer'?source.customer:source.technician))}</b><p>${esc(turn.text)}</p></div>`).join('')}</div></details>`;
  if(scroll) detail.scrollIntoView({behavior:'smooth',block:'start'});
}

async function refreshCallAudit() {
  clearTimeout(callAnalyticsTimer);
  if (state.user?.role==='customer' || !state.user) return;
  const job=await api('/api/call-analytics/audit-job'),running=job.status==='running';
  $('#evaluateCalls').disabled=running;
  $('#evaluateCalls').textContent=running?'Evaluating calls…':'Evaluate completed calls';
  $('#callAuditStatus').textContent=job.status==='idle'?'Completed calls are assessed in the background. Use Evaluate completed calls to assess existing conversations.':`${running?'Evaluating':'Finished'}: ${job.completed} completed, ${job.failed} failed, ${job.skipped} skipped · ${job.total} calls`;
  if($('#view-qa').classList.contains('active') && reportTabs.qa==='calls') {
    if(callQaSelected) await openCallQA(callQaSelected,false);
    if(running) callAnalyticsTimer=setTimeout(window.loadCallQA,3000);
  }
}

$('#transcriptSearch').addEventListener('input',renderTranscripts);
['transcriptTechnicianFilter','transcriptServiceFilter'].forEach(id=>$('#'+id).addEventListener('change',renderTranscripts));
['Min','Max'].forEach(bound=>$('#transcriptDuration'+bound).addEventListener('input',renderTranscripts));
$('#clearTranscriptFilters').addEventListener('click',()=>{resetTranscriptFilters();renderTranscripts();});
$('#callQaSearch').addEventListener('input',renderCallQA);
document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-transcript]');
  if(target) {try{await openTranscript(target.dataset.transcript);}catch(error){toast(error.message);}}
  const audit=event.target.closest('[data-call-qa]');
  if(audit) {try{await openCallQA(audit.dataset.callQa);}catch(error){toast(error.message);}}
});
$('#evaluateCalls').addEventListener('click',async () => {
  $('#evaluateCalls').disabled=true;
  try {await api('/api/call-analytics/evaluate',{method:'POST',body:'{}'});await window.loadCallQA();}
  catch(error){toast(error.message);$('#evaluateCalls').disabled=false;}
});

$('#callAnalyticsIdFilter').addEventListener('input',()=>{++callAnalyticsRequest;clearTimeout(callFilterTimer);callFilterTimer=setTimeout(window.loadCallAnalytics,200);});
['Technician','Service'].forEach(field=>$('#callAnalytics'+field+'Filter').addEventListener('change',()=>{clearTimeout(callFilterTimer);window.loadCallAnalytics();}));
$('#callAnalyticsResetFilters').addEventListener('click',()=>{clearTimeout(callFilterTimer);['Id','Technician','Service'].forEach(field=>$('#callAnalytics'+field+'Filter').value='');window.loadCallAnalytics();});
