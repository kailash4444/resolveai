(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const byId = id => document.getElementById(id);
  const state = { caseId: null, data: null, graph: null, guidance: null, provider: '', selectedGraphNode: null, dated: [], undated: [], cursor: 0, activeEvent: null, compare: [], categories: new Set(), zoom: 1, playing: false, timer: null, nodePositions: new Map() };
  // Category colours come from the theme tokens, so the timeline follows light and dark.
  const palette = { ticket_created:'var(--ok)', customer_observation:'var(--high)', conversation:'var(--low)', troubleshooting:'var(--medium)', technician_action:'var(--edge)', failed_attempt:'var(--critical)', status_change:'var(--link)', evidence_added:'var(--low)', qa_result:'var(--text-3)', durability_assessment:'var(--medium)', customer_comment:'var(--high)', system_record:'var(--text-3)', ai_diagnosis:'var(--low)', ai_recommendation:'var(--link)' };
  const groups = { customer_observation:'Customer', conversation:'Conversation', customer_comment:'Customer', technician_action:'Technician', failed_attempt:'Failed steps', troubleshooting:'Reported steps', status_change:'State changes', ticket_created:'Incident', evidence_added:'Attachments', qa_result:'QA', durability_assessment:'Durability', system_record:'System', ai_diagnosis:'AI records', ai_recommendation:'AI records' };
  const allCategories = [...new Set([...Object.values(groups), 'Other'])];
  const dt = value => value ? new Date(value) : null;
  const when = value => { const date = dt(value); return date && !Number.isNaN(date.valueOf()) ? date.toLocaleString([], {dateStyle:'medium',timeStyle:'short'}) : 'Undated'; };
  const category = event => groups[event.type] || 'Other';
  const current = () => state.dated[state.cursor] || state.dated[0] || null;
  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type':'application/json', ...(options.headers || {}) } });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try { const payload = await response.json(); message = typeof payload.detail === 'string' ? payload.detail : message; } catch (_) {}
      throw new Error(message);
    }
    return response.json();
  }
  function message(text, error = false) {
    const box = byId('tmMessage'); box.hidden = !text; box.classList.toggle('error', error); box.textContent = text || '';
  }
  function openView(name) { if (typeof window.showView === 'function') window.showView(name); }
  function eventById(id) { return state.data?.events.find(item => item.id === id) || null; }
  function isVisible(event) { return state.categories.has(category(event)); }

  window.enterIncidentTimeMachine = async caseId => {
    stopPlayback();
    state.caseId = caseId; state.data = null; state.graph = null; state.guidance = null; state.provider = ''; state.selectedGraphNode = null; state.activeEvent = null; state.compare = []; state.nodePositions.clear();
    openView('time-machine');
    byId('tmWorkspace').hidden = true; message('Reconstructing the incident from recorded source evidence…');
    try {
      const [timeline, graph] = await Promise.allSettled([
        request(`/api/cases/${encodeURIComponent(caseId)}/time-machine`),
        request(`/api/cases/${encodeURIComponent(caseId)}/handoff-graph`),
      ]);
      if (timeline.status === 'rejected') throw timeline.reason;
      state.data = timeline.value;
      if (graph.status === 'fulfilled') {
        state.graph = graph.value.graph;
        state.selectedGraphNode = `ticket:${caseId}`;
        showGraphWarnings(graph.value.warnings);
      }
      else showGraphWarnings(['Connected evidence graph could not be loaded. The incident timeline is still available.']);
      state.dated = state.data.events.filter(item => item.occurred_at);
      state.undated = state.data.events.filter(item => !item.occurred_at);
      state.cursor = Math.max(0, state.dated.length - 1);
      state.categories = new Set(allCategories);
      state.zoom = 1; byId('tmZoomLabel').textContent = '100%'; message(''); render();
    } catch (error) { message(error.message, true); }
  };

  function render() {
    if (!state.data) return;
    const {incident} = state.data;
    byId('tmWorkspace').hidden = false;
    byId('tmHeading').textContent = incident.title || 'Incident Time Machine';
    byId('tmIncidentId').textContent = incident.ticket_id;
    byId('tmIncidentState').textContent = incident.state;
    byId('tmCoverage').textContent = `${state.data.chronology_coverage}%`;
    byId('tmEventCounts').textContent = `${state.data.dated_count} / ${state.data.undated_count}`;
    byId('tmCausalStatus').textContent = state.data.causal_status;
    const warnings = byId('tmWarnings');
    warnings.hidden = !state.data.warnings.length;
    warnings.innerHTML = state.data.warnings.map(item => `<p>${esc(item)}</p>`).join('');
    renderFilters(); renderTimeline(); renderInspector(); renderKnowledge(); renderHandoffGraph();
  }

  const graphKindLabel = {ticket:'Incident',customer:'Customer',technician:'Technician',transcript:'Transcript',action:'Reported action',work_note:'Work note',failed_action:'Failed step',knowledge:'Knowledge',similar_case:'Similar ticket'};
  const graphKindIcon = {ticket:'T',customer:'C',technician:'S',transcript:'V',action:'A',work_note:'N',failed_action:'!',knowledge:'K',similar_case:'↗'};
  function showGraphWarnings(items = []) {
    const box = byId('tmHandoffWarnings'); box.hidden = !items.length;
    box.innerHTML = items.map(item => `<p>${esc(item)}</p>`).join('');
  }
  function graphPositions(graph) {
    const columns = {
      people: graph.nodes.filter(item => ['customer','technician'].includes(item.kind)),
      evidence: graph.nodes.filter(item => ['transcript','action','work_note','failed_action'].includes(item.kind)),
      ticket: graph.nodes.filter(item => item.kind === 'ticket'),
      knowledge: graph.nodes.filter(item => item.kind === 'knowledge'),
      history: graph.nodes.filter(item => item.kind === 'similar_case'),
    };
    const height = Math.max(650, ...Object.values(columns).map(items => items.length * 60 + 96));
    const x = {people:24,evidence:285,ticket:568,knowledge:855,history:1124};
    const width = {people:224,evidence:242,ticket:250,knowledge:242,history:242};
    const positions = new Map();
    for (const [name, items] of Object.entries(columns)) {
      const gap = 60, start = Math.max(52, (height - items.length * gap) / 2);
      items.forEach((item,index) => positions.set(item.id, {x:x[name],y:start+index*gap,w:width[name],h:name==='ticket'?80:50}));
    }
    const center = columns.ticket[0];
    if (center) positions.set(center.id,{x:x.ticket,y:(height-80)/2,w:width.ticket,h:80});
    return {columns,height,width:x.history+width.history+24,positions};
  }
  function renderHandoffGraph() {
    const graph = state.graph, svg = byId('tmHandoffGraph');
    if (!svg || !graph) return;
    const layout = graphPositions(graph), {positions,height,width} = layout;
    const selectedNode = graph.nodes.find(item => item.id === state.selectedGraphNode);
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`); svg.style.height = `${height}px`;
    const titles = {people:'PEOPLE & OWNERSHIP',evidence:'WHAT WAS SAID / TRIED',ticket:'ACTIVE INCIDENT',knowledge:'RETRIEVED KNOWLEDGE',history:'SIMILAR INCIDENTS'};
    const headers = Object.entries(titles).map(([key,title])=>{
      const x = ({people:24,evidence:285,ticket:568,knowledge:855,history:1124})[key];
      return `<text class="hg-column-label" x="${x}" y="28">${title}</text>`;
    }).join('');
    const edges = graph.edges.map(edge=>{
      const from=positions.get(edge.from),to=positions.get(edge.to); if(!from||!to)return '';
      const forward=from.x<to.x,sx=forward?from.x+from.w:from.x,ex=forward?to.x:to.x+to.w;
      const sy=from.y+from.h/2,ey=to.y+to.h/2,curve=Math.max(24,Math.abs(ex-sx)*.4);
      const d=`M ${sx} ${sy} C ${sx+(forward?curve:-curve)} ${sy}, ${ex-(forward?curve:-curve)} ${ey}, ${ex} ${ey}`;
      const active=state.selectedGraphNode===edge.from||state.selectedGraphNode===edge.to;
      const label=active&&selectedNode?.kind!=='ticket'?`<text class="hg-edge-label" x="${(sx+ex)/2}" y="${(sy+ey)/2-5}" text-anchor="middle">${esc(edge.label)}</text>`:'';
      return `<path class="hg-edge ${active?'active':''}" d="${d}"><title>${esc(edge.label)}</title></path>${label}`;
    }).join('');
    const cards = graph.nodes.map(item=>{
      const point=positions.get(item.id); if(!point)return '';
      const selected=state.selectedGraphNode===item.id, color=graphKindIcon[item.kind]||'•';
      const subtitle=item.kind==='knowledge'?`${Math.round((item.score||0)*100)}% retrieval match`:item.kind==='similar_case'?(item.outcome||'historical match').replaceAll('_',' '):item.kind==='failed_action'?'EXPLICITLY RECORDED FAILURE':graphKindLabel[item.kind]||'';
      const label=String(item.label||'Evidence').slice(0,34), y=point.y;
      return `<g class="hg-node ${esc(item.kind)} ${selected?'selected':''}" data-hg-node="${esc(item.id)}" tabindex="0" role="button" aria-label="${esc(`${graphKindLabel[item.kind]||'Evidence'}: ${item.label}`)}"><rect class="hg-card" x="${point.x}" y="${y}" width="${point.w}" height="${point.h}" rx="12"/><circle class="hg-icon-ring" cx="${point.x+22}" cy="${y+point.h/2}" r="13"/><text class="hg-icon" x="${point.x+22}" y="${y+point.h/2}">${esc(color)}</text><text class="hg-label" x="${point.x+44}" y="${y+21}">${esc(label)}</text><text class="hg-sub" x="${point.x+44}" y="${y+37}">${esc(subtitle.slice(0,38))}</text>${item.case_id?`<title>${esc(item.detail)}</title>`:''}</g>`;
    }).join('');
    const defs='<defs><linearGradient id="hg-ticket" x1="0" y1="0" x2="1" y2="1"><stop style="stop-color:var(--edge)"/><stop offset="1" style="stop-color:color-mix(in srgb,var(--edge) 55%,var(--link))"/></linearGradient><filter id="hg-shadow" x="-20%" y="-25%" width="150%" height="160%"><feDropShadow dx="0" dy="4" stdDeviation="5" style="flood-color:var(--shade)" flood-opacity=".6"/></filter><filter id="hg-glow" x="-25%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="0" stdDeviation="5" style="flood-color:var(--edge)" flood-opacity=".3"/></filter></defs>';
    svg.innerHTML=defs+headers+edges+cards;
    const counts=graph.counts;
    const handoffOwner=graph.incident.assigned_to_you?'you':graph.incident.assigned_to;
    byId('tmGraphCounts').textContent=`To ${handoffOwner} · ${counts.transcript_and_actions} evidence items · ${counts.knowledge} articles · ${counts.similar_incidents} similar tickets`;
    byId('tmGuideEyebrow').textContent=graph.incident.assigned_to_you?'YOUR HANDOFF · PICK UP HERE':graph.incident.assigned_to==='Unassigned'?'TECHNICIAN HANDOFF · UNASSIGNED':`TECHNICIAN HANDOFF · ${graph.incident.assigned_to}`;
    const empty=byId('tmGraphEmpty'); empty.hidden=graph.edges.length>2 || counts.transcript_and_actions>0;
    empty.textContent='This ticket has little linked history yet. Add work notes and knowledge articles to build a richer evidence map.';
    renderGraphInspector(); renderGuidance();
  }
  function renderGraphInspector() {
    const panel=byId('tmGraphInspector'), graph=state.graph;
    if(!graph)return;
    const item=graph.nodes.find(node=>node.id===state.selectedGraphNode);
    if(!item){panel.innerHTML='<h3>Select a node</h3><p class="helper">Choose a person, transcript, attempted step, article, or similar ticket to inspect its source.</p>';return;}
    const meta=[];
    if(item.state)meta.push(item.state);if(item.priority)meta.push(item.priority);if(item.outcome)meta.push(item.outcome.replaceAll('_',' '));if(Number.isFinite(item.score))meta.push(`${Math.round(item.score*100)}% match`);if(item.similarity_terms?.length)meta.push(`matched: ${item.similarity_terms.join(', ')}`);if(item.timestamp)meta.push(when(item.timestamp));if(item.created_at)meta.push(when(item.created_at));
    const steps=item.steps?.length?`<div class="handoff-inspector-detail"><b>Documented steps</b><ol>${item.steps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol></div>`:'';
    const open=item.case_id?`<button class="text-button handoff-open-case" type="button" data-hg-open-case="${esc(item.case_id)}">Open source ticket →</button>`:'';
    panel.innerHTML=`<span class="handoff-chip">${esc(graphKindLabel[item.kind]||'Evidence')}</span><h3>${esc(item.label)}</h3>${meta.length?`<div class="handoff-source-meta">${meta.map(value=>`<span class="handoff-chip">${esc(value)}</span>`).join('')}</div>`:''}<div class="handoff-inspector-detail">${esc(item.detail||'No additional source detail is recorded.')}</div>${steps}${open}`;
  }
  function renderGuidance() {
    const host=byId('tmGuideContent'), guide=state.guidance;
    if(!guide){host.innerHTML='<p class="helper">Generate a cited plan from this ticket, its conversation, current knowledge, and similar incidents. This makes one live AI request.</p>';byId('tmGuideBadge').textContent=state.provider==='mock'?'DEMO MODE':'EVIDENCE-LED';return;}
    const providerLabel={vertex:'VERTEX AI',google_ai:'GEMINI API',openai:'OPENAI',mock:'DEMO MODE'}[state.provider]||String(state.provider||'AI').toUpperCase();
    byId('tmGuideBadge').textContent=state.provider==='mock'?'DEMO MODE':`${providerLabel} · SOURCED`;
    const actions=guide.next_actions.map((item,index)=>`<li class="handoff-action-card"><div><span class="handoff-step-number">${index+1}</span><b>${esc(item.action)}</b></div><p>${esc(item.rationale)}</p><small><b>Verify:</b> ${esc(item.verify)}</small><div class="handoff-citations">${item.evidence_ids.map(id=>{const source=state.graph.nodes.find(node=>node.id===id);return source?`<button class="handoff-citation" data-hg-citation="${esc(id)}">↗ ${esc(source.label)}</button>`:''}).join('')}</div></li>`).join('');
    host.innerHTML=`<p class="handoff-guide-summary">${esc(guide.summary)}</p><ol class="handoff-action-list">${actions}</ol>${guide.questions_for_customer?.length?`<div class="handoff-subsection"><h4>Ask the customer</h4><ul>${guide.questions_for_customer.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>`:''}${guide.avoid_repeating?.length?`<div class="handoff-subsection"><h4>Avoid repeating</h4><ul>${guide.avoid_repeating.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>`:''}${guide.unknowns?.length?`<div class="handoff-subsection"><h4>Still unknown</h4><ul>${guide.unknowns.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>`:''}`;
  }
  async function generateHandoffGuide() {
    const button=byId('tmGenerateGuide'); if(!state.caseId||button.disabled)return;
    button.disabled=true;button.textContent='Reading evidence…';state.guidance=null;renderGuidance();
    try {
      const result=await request(`/api/cases/${encodeURIComponent(state.caseId)}/handoff-guidance`,{method:'POST'});
      state.graph=result.graph;state.guidance=result.guidance;state.provider=result.provider||'';showGraphWarnings(result.warnings);renderHandoffGraph();
    } catch(error){showGraphWarnings([error.message]);}
    finally{button.disabled=false;button.textContent=state.guidance?'Refresh plan':'Generate next steps';}
  }
  byId('tmGenerateGuide').addEventListener('click',generateHandoffGuide);

  function visibleDatedEvents() {
    if (byId('tmRetrospective').checked || !current()) return state.dated;
    const cutoff = current().occurred_at;
    return state.dated.filter(item => item.occurred_at <= cutoff);
  }

  function renderMomentState() {
    const incident = state.data.incident, selected = current(), status = byId('tmIncidentState');
    if (!selected) { status.textContent = `Current: ${incident.state} · history unavailable`; return; }
    if (byId('tmRetrospective').checked) { status.textContent = `Current: ${incident.state} · retrospective`; return; }
    if (incident.created_at && selected.occurred_at < incident.created_at) { status.textContent = `Not yet created · current: ${incident.state}`; return; }
    const transitions = state.data.events.filter(item => item.type === 'status_change' && item.occurred_at && item.occurred_at <= selected.occurred_at);
    const latest = transitions.length ? transitions[transitions.length - 1].occurred_at : null;
    const tied = latest ? transitions.filter(item => item.occurred_at === latest) : [];
    const states = [...new Set(tied.map(item => item.title.split(' → ').at(-1)))];
    const atTime = states.length > 1 ? 'Unknown · simultaneous state updates' : states[0] || incident.initial_state || 'Unknown';
    status.textContent = `At selected time: ${atTime} · current: ${incident.state}`;
  }

  function renderFilters() {
    byId('tmFilters').innerHTML = allCategories.map(name => `<button type="button" class="tm-filter ${state.categories.has(name) ? 'active' : ''}" data-tm-filter="${esc(name)}" aria-pressed="${state.categories.has(name)}"><i style="--tm-color:${palette[Object.keys(groups).find(key => groups[key] === name)] || 'var(--text-3)'}"></i>${esc(name)}</button>`).join('');
  }

  function renderTimeline() {
    const svg = byId('tmTimeline');
    const dated = state.dated;
    const index = Math.min(state.cursor, Math.max(0, dated.length - 1));
    const cursor = dated[index] || null;
    const retro = byId('tmRetrospective').checked;
    const width = Math.max(1100, Math.ceil(Math.max(1, dated.length) * 82 * state.zoom));
    const height = 430, left = 78, right = width - 42, yBase = 398;
    const lanes = ['Customer','Conversation','AI records','Technician','Failed steps','State changes','Incident','Attachments','QA','Durability','Reported steps','System','Other'];
    const yFor = event => 72 + Math.max(0, lanes.indexOf(category(event))) * 25;
    const firstTime = dated.length ? Date.parse(dated[0].occurred_at) : 0;
    const lastTime = dated.length ? Date.parse(dated[dated.length - 1].occurred_at) : firstTime;
    const xFor = event => lastTime <= firstTime ? (left + right) / 2 : left + ((Date.parse(event.occurred_at) - firstTime) / (lastTime - firstTime)) * (right - left);
    const display = dated.filter(item => (retro || (cursor && item.occurred_at <= cursor.occurred_at)) && isVisible(item));
    const parts = [`<defs><marker id="tm-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" style="fill:var(--border-strong)"/></marker></defs>`,
      `<line class="tm-axis" x1="${left}" y1="${yBase}" x2="${right}" y2="${yBase}"/>`,
      `<text class="tm-axis-caption" x="${left}" y="${height - 22}">RECORDED TIME →</text>`];
    for (const lane of lanes) {
      const y = 70 + lanes.indexOf(lane) * 25;
      parts.push(`<line class="tm-lane" x1="${left}" y1="${y + 8}" x2="${right}" y2="${y + 8}"/><text class="tm-lane-label" x="8" y="${y + 12}">${esc(lane)}</text>`);
    }
    if (cursor) {
      const x = xFor(cursor);
      parts.push(`<line class="tm-cursor" x1="${x}" y1="48" x2="${x}" y2="${height - 42}"/><text class="tm-cursor-label" x="${x + 7}" y="${height - 47}">AS OF</text>`);
    }
    for (const event of display) {
      const x = xFor(event), y = yFor(event), color = palette[event.type] || 'var(--text-3)';
      const chosen = state.activeEvent === event.id ? ' selected' : '';
      const isCurrent = cursor && event.id === cursor.id;
      const shape = event.type === 'status_change' || event.type === 'failed_attempt'
        ? `<path d="M ${x} ${y-8} L ${x+8} ${y} L ${x} ${y+8} L ${x-8} ${y} Z" style="fill:${color}"/>`
        : `<circle cx="${x}" cy="${y}" r="7" style="fill:${color}"/>`;
      parts.push(`<g class="tm-event${chosen}${isCurrent ? ' current' : ''}" data-tm-event="${esc(event.id)}" tabindex="0" role="button" aria-label="${esc(event.title)} · ${esc(when(event.occurred_at))}"><line class="tm-stem" x1="${x}" y1="${y+10}" x2="${x}" y2="${yBase-10}"/><circle class="tm-hit" cx="${x}" cy="${y}" r="14"/>${shape}<text class="tm-point-label" x="${x}" y="${y-12}" text-anchor="middle">${esc(event.title.slice(0, 24))}</text></g>`);
    }
    if (!display.length) parts.push(`<text class="tm-empty" x="${width/2}" y="${height/2}" text-anchor="middle">No visible dated evidence. Adjust filters or rewind.</text>`);
    if (!retro && cursor && dated.some(item => item.occurred_at > cursor.occurred_at)) parts.push(`<text class="tm-future-note" x="${Math.min(right - 12, xFor(cursor) + 14)}" y="${height - 22}">Later records hidden at this historical moment</text>`);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.style.width = `${width}px`; svg.innerHTML = parts.join('');
    byId('tmScrubber').max = String(Math.max(0, dated.length - 1));
    byId('tmScrubber').value = String(index);
    byId('tmScrubber').disabled = dated.length < 2;
    byId('tmAsOf').textContent = retro ? 'Retrospective overview · later evidence visible' : cursor ? `As of ${when(cursor.occurred_at)}` : 'No reliable timestamps recorded';
    byId('tmScrubLabel').textContent = cursor ? `${index + 1} of ${dated.length} dated records` : 'No dated records';
    byId('tmUndatedNote').textContent = state.undated.length ? `${state.undated.length} source record${state.undated.length === 1 ? '' : 's'} lack reliable timestamps and are not placed on the time axis.` : 'All available source records have timestamps.';
    const evidence = byId('tmUndatedEvidence');
    evidence.hidden = !retro || !state.undated.length;
    evidence.innerHTML = retro ? `<h4>Undated source evidence · not placed on historical axis</h4>${state.undated.map(item => `<button class="tm-undated-item" data-tm-event="${esc(item.id)}"><b>${esc(item.title)}</b><span>${esc(item.source_type)} · ${esc(item.source_id)}</span><small>${esc(item.detail)}</small></button>`).join('')}` : '';
    renderMomentState(); renderDecisions(); renderAlternativeChoices(); renderMap();
  }

  function renderInspector() {
    const selected = eventById(state.activeEvent) || current();
    if (!selected) { byId('tmEventTitle').textContent = 'No timestamped event selected'; byId('tmEventDetail').textContent = 'Use retrospective overview to inspect undated evidence.'; }
    else {
      state.activeEvent = selected.id;
      byId('tmEventTitle').textContent = selected.title;
      byId('tmEventDetail').innerHTML = `<p>${esc(selected.detail)}</p><dl class="tm-source"><div><dt>Recorded</dt><dd>${esc(when(selected.occurred_at))} · ${selected.time_quality === 'recorded' ? 'source timestamp' : 'timestamp unavailable'}</dd></div><div><dt>Actor</dt><dd>${esc(selected.actor)}</dd></div><div><dt>Record type</dt><dd>${esc(selected.source_type)} · ${esc(selected.source_id)}</dd></div><div><dt>Outcome</dt><dd>${esc(selected.outcome)}</dd></div></dl><p class="helper">Selecting an event opens its source context. Time order alone does not prove cause.</p>`;
    }
    const compare = byId('tmCompare');
    compare.hidden = state.compare.length < 2;
    compare.innerHTML = state.compare.length >= 2 ? `<h4>Evidence comparison</h4><div>${state.compare.slice(-2).map(id => { const item = eventById(id); return item ? `<article><b>${esc(item.title)}</b><small>${esc(when(item.occurred_at))}</small><p>${esc(item.detail)}</p></article>` : ''; }).join('')}</div><button class="text-button" data-tm-clear-compare>Clear comparison</button>` : '';
  }

  function renderMap() {
    const svg = byId('tmCausalMap'), events = visibleDatedEvents().filter(isVisible);
    const width = Math.max(1000, state.dated.length * 56 + 80), height = 560;
    const indexById = new Map(state.dated.map((item, index) => [item.id, index]));
    const visibleById = new Map(events.map(item => [item.id, item]));
    const x = item => 42 + Math.max(0, indexById.get(item.id) ?? 0) * 56;
    const y = index => 115 + (index % 5) * 58 + (Math.floor(index / 5) % 2) * 28;
    const parts = ['<defs><marker id="tm-map-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" style="fill:var(--border-strong)"/></marker></defs>'];
    (state.data.relationships || []).forEach(link => {
      const from = visibleById.get(link.from), to = visibleById.get(link.to);
      if (!from || !to) return;
      parts.push(`<line class="tm-map-edge" x1="${x(from)+15}" y1="${y(indexById.get(from.id))}" x2="${x(to)-15}" y2="${y(indexById.get(to.id))}" marker-end="url(#tm-map-arrow)"><title>Recorded earlier than. Chronology only, not causation.</title></line>`);
    });
    events.forEach(item => {
      const index = indexById.get(item.id);
      const point = state.nodePositions.get(item.id) || {x:x(item), y:y(index)}, color = palette[item.type] || 'var(--text-3)';
      const label = item.title.length > 10 ? `${item.title.slice(0, 9)}…` : item.title;
      parts.push(`<g class="tm-map-node" data-tm-node="${esc(item.id)}" transform="translate(${point.x} ${point.y})" tabindex="0" role="button"><circle r="15" style="fill:${color}"/><text y="31" text-anchor="middle">${esc(label)}</text><title>${esc(item.title)} · ${esc(when(item.occurred_at))}</title></g>`);
    });
    if (!events.length) parts.push('<text class="tm-empty" x="500" y="280" text-anchor="middle">No dated evidence to map. Undated records stay outside the chronology map.</text>');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.style.width = `${width}px`; svg.innerHTML = parts.join('');
    const undated = byId('tmRetrospective').checked ? state.undated : [];
    byId('tmMapMode').textContent = byId('tmRetrospective').checked ? 'Retrospective map · all dated and undated source records shown.' : `Historical map · ${current() ? `as of ${when(current().occurred_at)}` : 'no dated moment selected'}.`;
    const linkCount = (state.data.relationships || []).filter(link => events.some(item => item.id === link.from) && events.some(item => item.id === link.to)).length;
    byId('tmMapEventList').innerHTML = `<p class="helper">${events.length} visible dated event${events.length === 1 ? '' : 's'} · ${linkCount} recorded-before links · 0 confirmed causal links</p>` + undated.map(item => `<button class="tm-map-undated" data-tm-event="${esc(item.id)}">Undated: ${esc(item.title)}</button>`).join('');
  }

  function renderDecisions() {
    const visibleIds = new Set(visibleDatedEvents().map(item => item.id));
    const decisions = state.data.events.filter(item => ['technician_action','failed_attempt','troubleshooting','status_change'].includes(item.type) && isVisible(item) && (visibleIds.has(item.id) || (byId('tmRetrospective').checked && !item.occurred_at)));
    const counts = { 'Technician actions': decisions.filter(item => item.type === 'technician_action').length, 'Explicitly failed attempts': decisions.filter(item => item.type === 'failed_attempt').length, 'Customer-reported steps': decisions.filter(item => item.type === 'troubleshooting').length, 'State decisions': decisions.filter(item => item.type === 'status_change').length };
    byId('tmDecisionFingerprint').innerHTML = `<div class="tm-decision-metrics">${Object.entries(counts).map(([label,count]) => `<article><small>${esc(label)}</small><strong>${count}</strong></article>`).join('')}</div><h4>Recorded action sequence</h4>${decisions.length ? `<ol class="tm-decision-list">${decisions.map(item => `<li><button data-tm-event="${esc(item.id)}"><b>${esc(item.title)}</b><span>${esc(when(item.occurred_at))} · ${esc(item.actor)}</span><small>${esc(item.detail)}</small></button></li>`).join('')}</ol>` : '<p class="helper">No recorded troubleshooting steps or technician decisions are available for this incident.</p>'}<p class="helper">Failure labels appear only when the source note explicitly reports failure. Other outcomes remain unknown.</p>`;
  }

  function renderAlternativeChoices() {
    const select = byId('tmDecisionPoint');
    const selectedId = select.value;
    const visibleIds = new Set(visibleDatedEvents().map(item => item.id));
    const options = state.data.events.filter(item => item.occurred_at && visibleIds.has(item.id) && isVisible(item) && ['technician_action','failed_attempt','status_change'].includes(item.type));
    select.innerHTML = options.map(item => `<option value="${esc(item.id)}">${esc(when(item.occurred_at))} · ${esc(item.title)}</option>`).join('');
    if (options.some(item => item.id === selectedId)) select.value = selectedId;
    select.disabled = options.length === 0;
    byId('tmRunAlternative').disabled = options.length === 0;
    byId('tmAlternativeMessage').textContent = options.length ? 'The comparison is a model-generated hypothesis. It does not change this incident.' : 'No dated technician action or state decision is available to branch from.';
  }

  function renderKnowledge() {
    const matches = state.data.knowledge_matches || [];
    byId('tmKnowledgeMatches').innerHTML = matches.length ? matches.map(item => `<article class="tm-knowledge-match"><div><b>${esc(item.title)}</b><span>${Math.round(item.score * 100)}% retrieval match</span></div><p>${esc(item.excerpt)}</p>${item.steps?.length ? `<ol>${item.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}</article>`).join('') : '<p class="helper">No linked knowledge retrieval matches were recorded for this incident.</p>';
    byId('tmKnowledgeDraft').hidden = true;
  }

  function selectEvent(eventId) {
    const selected = eventById(eventId); if (!selected) return;
    state.activeEvent = eventId;
    const index = state.dated.findIndex(item => item.id === eventId);
    if (index >= 0 && index > state.cursor && !byId('tmRetrospective').checked) state.cursor = index;
    renderTimeline(); renderInspector();
  }
  function jumpTo(predicate, unavailable) {
    const item = state.dated.find(predicate);
    if (!item) { if (window.toast) window.toast(unavailable); else message(unavailable); return; }
    state.cursor = state.dated.indexOf(item); state.activeEvent = item.id;
    renderTimeline(); renderInspector();
    const node = byId('tmTimeline').querySelector(`[data-tm-event="${CSS.escape(item.id)}"]`);
    node?.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});
  }
  function stopPlayback() { state.playing = false; clearInterval(state.timer); state.timer = null; byId('tmPlay').textContent = '▶ Play'; }

  byId('tmReturnIncident').addEventListener('click', () => { stopPlayback(); if (state.caseId) window.openTicketDetails?.(state.caseId); else openView('tickets'); });
  byId('tmScrubber').addEventListener('input', event => { state.cursor = Number(event.target.value); state.activeEvent = current()?.id || null; renderTimeline(); renderInspector(); });
  byId('tmRetrospective').addEventListener('change', () => {
    if (!byId('tmRetrospective').checked) {
      const selected = eventById(state.activeEvent);
      if (selected && (!selected.occurred_at || selected.occurred_at > current()?.occurred_at)) state.activeEvent = current()?.id || null;
    }
    renderTimeline(); renderInspector();
  });
  byId('tmSpeed').addEventListener('change', () => { if (state.playing) play(); });
  byId('tmPlay').addEventListener('click', () => state.playing ? stopPlayback() : play());
  function play() {
    stopPlayback(); if (state.dated.length < 2 || state.cursor >= state.dated.length - 1) state.cursor = 0;
    state.playing = true; byId('tmPlay').textContent = '❚❚ Pause';
    const interval = Math.max(180, 700 / Number(byId('tmSpeed').value || 1));
    state.timer = setInterval(() => {
      if (state.cursor >= state.dated.length - 1) { stopPlayback(); return; }
      state.cursor += 1; state.activeEvent = current()?.id || null; renderTimeline(); renderInspector();
    }, interval);
  }
  byId('tmFirstFailure').addEventListener('click', () => jumpTo(item => item.type === 'failed_attempt', 'No explicitly failed action with a reliable timestamp is recorded.'));
  byId('tmDecisionJump').addEventListener('click', () => jumpTo(item => item.type === 'technician_action' || item.type === 'status_change', 'No timestamped technician decision or state change is recorded.'));
  byId('tmResolution').addEventListener('click', () => jumpTo(item => item.type === 'status_change' && /resolved/i.test(item.title), 'No recorded resolved-state transition is available.'));
  byId('tmRecurrence').addEventListener('click', () => jumpTo(item =>
    item.type === 'status_change' && /^Resolved\s*→\s*(?!Resolved\b)/i.test(item.title),
    'No recorded reopening after resolution was found in this incident.'));
  byId('tmReset').addEventListener('click', () => {
    stopPlayback(); state.cursor = Math.max(0, state.dated.length - 1); state.categories = new Set(allCategories); state.zoom = 1; state.compare = []; state.nodePositions.clear();
    byId('tmRetrospective').checked = false; byId('tmZoomLabel').textContent = '100%'; renderFilters(); renderTimeline(); renderInspector();
  });
  byId('tmZoomIn').addEventListener('click', () => { state.zoom = Math.min(2.5, state.zoom + .2); byId('tmZoomLabel').textContent = `${Math.round(state.zoom * 100)}%`; renderTimeline(); });
  byId('tmZoomOut').addEventListener('click', () => { state.zoom = Math.max(.6, state.zoom - .2); byId('tmZoomLabel').textContent = `${Math.round(state.zoom * 100)}%`; renderTimeline(); });
  byId('tmResetMap').addEventListener('click', () => { state.nodePositions.clear(); renderMap(); });
  byId('tmDraftKnowledge').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Drafting from source incident…';
    try {
      const result = await request('/api/knowledge/from-incidents', {method:'POST', body:JSON.stringify({ticket_numbers:[state.data.incident.ticket_id]})});
      renderKnowledgeDraft(result.article, result.warnings || []);
    } catch (error) { message(error.message, true); }
    finally { button.disabled = false; button.textContent = 'Draft a knowledge lesson'; }
  });
  function renderKnowledgeDraft(article, warnings) {
    const draft = byId('tmKnowledgeDraft'); draft.hidden = false;
    draft.innerHTML = `<form id="tmKnowledgeApprovalForm"><p class="helper">Generated draft based on ${esc(state.data.incident.ticket_id)}. Review and edit every field before approval.</p>${warnings.map(item => `<p class="tm-warning-line">${esc(item)}</p>`).join('')}<label>Title<input name="title" required minlength="3" value="${esc(article.title)}"></label><label>Product<input name="product" required minlength="2" value="${esc(article.product)}"></label><label>Symptoms<textarea name="symptoms" required minlength="3" rows="3">${esc(article.symptoms)}</textarea></label><label>Steps, one per line<textarea name="steps" required rows="5">${esc((article.steps || []).join('\n'))}</textarea></label><label>Resolution<textarea name="resolution" required minlength="3" rows="3">${esc(article.resolution)}</textarea></label><label>Tags, comma separated<input name="tags" value="${esc((article.tags || []).join(', '))}"></label><p class="helper">Source incident: ${esc(state.data.incident.ticket_id)}. Saving adds a new article; it does not replace an existing one.</p><div class="tm-alt-actions"><button class="primary">Approve and add article</button><button type="button" class="secondary" data-tm-reject-knowledge>Discard draft</button></div><p class="form-message" role="status"></p></form>`;
  }
  byId('tmAlternativeForm').addEventListener('submit', async event => {
    event.preventDefault(); const button = byId('tmRunAlternative'); button.disabled = true; button.textContent = 'Simulating…';
    byId('tmAlternativeMessage').textContent = '';
    try {
      const result = await request(`/api/cases/${encodeURIComponent(state.caseId)}/time-machine/counterfactual`, {method:'POST',body:JSON.stringify({decision_event_id:byId('tmDecisionPoint').value,alternative:byId('tmAlternative').value})});
      renderScenario(result);
    } catch (error) { byId('tmAlternativeMessage').textContent = error.message; }
    finally { button.disabled = false; button.textContent = 'Run simulated comparison'; }
  });
  for (const input of [byId('tmDecisionPoint'), byId('tmAlternative')]) input.addEventListener('change', () => {
    byId('tmHistoricalValidation').hidden = true; byId('tmScenario').hidden = true;
  });
  byId('tmValidateHistory').addEventListener('click', async event => {
    const button = event.currentTarget, decisionId = byId('tmDecisionPoint').value;
    if (!decisionId) { byId('tmAlternativeMessage').textContent = 'Choose a recorded decision first.'; return; }
    button.disabled = true; button.textContent = 'Comparing recorded incidents…';
    const panel = byId('tmHistoricalValidation'); panel.hidden = false; panel.textContent = 'Matching incidents by service and issue terms…';
    try {
      const result = await request(`/api/cases/${encodeURIComponent(state.caseId)}/time-machine/validate`, {method:'POST', body:JSON.stringify({decision_event_id:decisionId, alternative:byId('tmAlternative').value})});
      renderHistoricalContext(result);
    } catch (error) { panel.innerHTML = `<b>History check failed.</b><p>${esc(error.message)}</p>`; }
    finally { button.disabled = false; button.textContent = 'Validate Against History'; }
  });
  function renderHistoricalContext(result) {
    const panel = byId('tmHistoricalValidation'), data = result.historical_context;
    const labels = {customer_confirmed_resolution:'Customer-confirmed resolution', resolved_unverified:'Resolved · not verified', open_after_recorded_failure:'Open after explicit failure', other_or_unknown:'Other / unknown'};
    const outcomes = Object.entries(data.outcomes).map(([key,count]) => `<article><small>${esc(labels[key] || key)}</small><strong>${count}</strong></article>`).join('');
    const cases = data.matches.length ? `<h4>Comparable incidents · inspect source records</h4><div class="tm-comparable-list">${data.matches.map(item => `<article><div><b>${esc(item.ticket_id)}</b><span>${esc(item.state)} · ${esc(item.priority)}${item.demo_dataset ? ' · DEMO DATA' : ''}</span></div><p>${esc(labels[item.outcome] || item.outcome)} · matched: ${item.similarity_terms.map(esc).join(', ')}</p><button type="button" class="text-button" data-tm-match-case="${esc(item.case_id)}">Open incident evidence →</button></article>`).join('')}</div>` : '<p>No other incident met the comparison criteria.</p>';
    panel.innerHTML = `<p class="eyebrow">OBSERVED HISTORICAL CONTEXT · ${data.comparable_count} COMPARABLE${data.comparable_count === 1 ? '' : 'S'}</p><b>${data.status === 'insufficient_evidence' ? 'Insufficient evidence' : 'Observed outcomes in a similar-incident cohort'}</b><p>${esc(data.criteria)}</p><div class="tm-decision-metrics">${outcomes}</div>${cases}<h4>How to read this</h4><p>The cohort is selected deterministically from other incidents with the same service and overlapping issue terms. Counts describe recorded outcomes only; they do not estimate whether the selected alternative would have caused a better result.</p><ul>${data.limitations.map(item => `<li>${esc(item)}</li>`).join('')}</ul><p class="helper">Matched terms: ${data.matched_terms.length ? data.matched_terms.map(esc).join(', ') : 'none'}</p>`;
  }

  function renderScenario(result) {
    const box = byId('tmScenario'), scenario = result.scenario;
    box.hidden = false;
    const cited = new Set([...(scenario.supporting_evidence_ids || []), ...(scenario.contradicting_evidence_ids || []), ...(scenario.steps || []).flatMap(step => step.evidence_ids || [])]);
    const prior = result.evidence_available_before_decision.filter(item => cited.has(item.id));
    const later = result.observed_later_events || [];
    const simultaneous = result.events_at_same_timestamp_order_unknown || [];
    box.innerHTML = `<p class="eyebrow">${esc(result.label)}</p><h3>Simulated path</h3><p>${esc(scenario.summary)}</p>${simultaneous.length ? `<div class="tm-validation"><b>Order unavailable for ${simultaneous.length} record${simultaneous.length === 1 ? '' : 's'} at this timestamp.</b><p>Those records were excluded from the model context because their order relative to this decision is unknown.</p></div>` : ''}<div class="tm-alt-columns"><section><h4>Alternative steps</h4><ol>${scenario.steps.map(step => `<li><b>${esc(step.action)}</b><p>${esc(step.possible_outcome)}</p>${step.evidence_ids?.length ? `<small>Evidence: ${step.evidence_ids.map(esc).join(', ')}</small>` : '<small>No cited earlier evidence</small>'}</li>`).join('')}</ol></section><section><h4>What actually happened later</h4>${later.length ? later.map(item => `<article><b>${esc(item.title)}</b><small>${esc(when(item.timestamp))}</small><p>${esc(item.evidence)}</p></article>`).join('') : '<p class="helper">No later timestamped events were recorded.</p>'}</section></div>${prior.length ? `<h4>Supporting earlier evidence</h4><ul>${prior.map(item => `<li><b>${esc(item.title)}</b> · ${esc(when(item.timestamp))}<p>${esc(item.evidence)}</p></li>`).join('')}</ul>` : '<p class="helper">The model did not cite specific earlier source records.</p>'}${scenario.assumptions?.length ? `<h4>Assumptions</h4><ul>${scenario.assumptions.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}${scenario.unknowns?.length ? `<h4>Unknowns</h4><ul>${scenario.unknowns.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}<div class="tm-validation"><b>Historical validation: not established.</b><p>${esc(result.historical_validation.message)}</p><small>This alternative is a generated hypothesis. It is not a recorded result, measured time saving, or causal finding.</small></div>`;
    box.scrollIntoView({behavior:'smooth',block:'nearest'});
  }

  document.addEventListener('click', async event => {
    const tab = event.target.closest('[data-tm-tab]');
    if (tab) {
      document.querySelectorAll('[data-tm-tab]').forEach(item => item.setAttribute('aria-selected', String(item === tab)));
      document.querySelectorAll('[data-tm-pane]').forEach(item => { item.hidden = item.dataset.tmPane !== tab.dataset.tmTab; });
      return;
    }
    const graphNode=event.target.closest('[data-hg-node]');
    if(graphNode){state.selectedGraphNode=graphNode.dataset.hgNode;renderHandoffGraph();return;}
    const citation=event.target.closest('[data-hg-citation]');
    if(citation){state.selectedGraphNode=citation.dataset.hgCitation;renderHandoffGraph();byId('tmGraphInspector').scrollIntoView({behavior:'smooth',block:'nearest'});return;}
    const sourceCase=event.target.closest('[data-hg-open-case]');
    if(sourceCase){await window.openTicketDetails?.(sourceCase.dataset.hgOpenCase);return;}
    const filter = event.target.closest('[data-tm-filter]');
    if (filter) {
      const value = filter.dataset.tmFilter;
      state.categories.has(value) ? state.categories.delete(value) : state.categories.add(value);
      renderFilters(); renderTimeline(); return;
    }
    const marker = event.target.closest('[data-tm-event]');
    if (marker) {
      const id = marker.dataset.tmEvent;
      if (event.shiftKey && !state.compare.includes(id)) state.compare = [...state.compare.slice(-1), id];
      selectEvent(id); renderInspector(); return;
    }
    if (event.target.closest('[data-tm-clear-compare]')) { state.compare = []; renderInspector(); return; }
    const comparable = event.target.closest('[data-tm-match-case]');
    if (comparable) { stopPlayback(); await window.openTicketDetails?.(comparable.dataset.tmMatchCase); return; }
    if (event.target.closest('[data-tm-reject-knowledge]')) { byId('tmKnowledgeDraft').hidden = true; return; }
    const articleForm = event.target.closest('#tmKnowledgeApprovalForm');
    if (articleForm) return;
  });
  document.addEventListener('keydown', event => {
    const node = event.target.closest('[data-tm-event], [data-tm-node], [data-hg-node]');
    if (node && ['Enter',' '].includes(event.key)) { event.preventDefault(); node.click(); }
  });
  document.addEventListener('submit', async event => {
    const form = event.target.closest('#tmKnowledgeApprovalForm'); if (!form) return;
    event.preventDefault(); const button = form.querySelector('button[type="submit"]') || form.querySelector('button'); button.disabled = true;
    const fields = Object.fromEntries(new FormData(form));
    const payload = {title:fields.title, product:fields.product, symptoms:fields.symptoms, steps:fields.steps.split('\n').map(item => item.trim()).filter(Boolean), resolution:fields.resolution, tags:fields.tags.split(',').map(item => item.trim()).filter(Boolean), source_ticket_ids:[state.data.incident.ticket_id]};
    if (!payload.steps.length) { form.querySelector('[role="status"]').textContent = 'Add at least one troubleshooting step before saving.'; button.disabled = false; return; }
    try {
      const article = await request('/api/knowledge', {method:'POST',body:JSON.stringify(payload)});
      form.innerHTML = `<p class="tm-approved"><b>Knowledge article added</b></p><h4>${esc(article.title)}</h4><p>Source incident: ${esc(state.data.incident.ticket_id)}</p><p class="helper">Article ID: ${esc(article.id)}</p>`;
    } catch (error) { const status = form.querySelector('[role="status"]'); if (status) status.textContent = error.message; button.disabled = false; }
  });

  let dragging = null;
  document.addEventListener('pointerdown', event => {
    const node = event.target.closest('[data-tm-node]'); if (!node) return;
    dragging = {id:node.dataset.tmNode, svg:node.ownerSVGElement, node, pointerId:event.pointerId}; node.setPointerCapture?.(event.pointerId);
  });
  document.addEventListener('pointermove', event => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const svg = dragging.svg, rect = svg.getBoundingClientRect(), view = svg.viewBox.baseVal;
    const px = (event.clientX - rect.left) / rect.width * view.width, py = (event.clientY - rect.top) / rect.height * view.height;
    state.nodePositions.set(dragging.id, {x:Math.max(20,px),y:Math.max(45,Math.min(view.height-50,py))});
    dragging.node.setAttribute('transform', `translate(${Math.max(20,px)} ${Math.max(45,Math.min(view.height-50,py))})`);
  });
  document.addEventListener('pointerup', () => { dragging = null; });
  document.addEventListener('click', event => {
    const node = event.target.closest('[data-tm-node]');
    if (node) selectEvent(node.dataset.tmNode);
  });
})();
