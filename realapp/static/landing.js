/* Landing page motion: the live demo card, the step progress line and the counting example figures.
   Runs only while the landing page is visible; every interval, timeout and animation frame is cleared when it is
   hidden. With reduced motion everything shows its final state and nothing cycles. Without JS, all content shows. */
(() => {
  const landing = document.getElementById('landing');
  if (!landing) return;
  const $ = selector => landing.querySelector(selector), $$ = selector => [...landing.querySelectorAll(selector)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const TABS = ['talk', 'chat', 'report'];
  const timers = new Set(), demoTimers = new Set();
  let running = false, counted = false, frame = 0;

  const later = (set, fn, ms) => { const id = setTimeout(() => { set.delete(id); fn(); }, ms); set.add(id); };
  const every = (fn, ms) => { const id = setInterval(fn, ms); timers.add(id); };
  const clear = set => { set.forEach(id => { clearTimeout(id); clearInterval(id); }); set.clear(); };

  // Waveform bars are built once.
  const wave = $('[data-wave]');
  if (wave && !wave.children.length) wave.innerHTML = Array.from({length: 34}, (_, i) => `<i style="--i:${i % 16};--s:${(.35 + ((i * 37) % 60) / 100).toFixed(2)}"></i>`).join('');

  // ---- Live demo: Talk / Chat / Report. Lines appear one by one; then it moves to the next tab. ----
  function select(name) {
    $$('[data-demo-tab]').forEach(tab => {
      const on = tab.dataset.demoTab === name;
      tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1;
    });
    $$('[data-demo-panel]').forEach(panel => { panel.hidden = panel.dataset.demoPanel !== name; });
    $('.demo__tabs').style.setProperty('--tab', String(TABS.indexOf(name)));
  }
  function play(name) {
    clear(demoTimers);
    select(name);
    const panel = $(`[data-demo-panel="${name}"]`), lines = [...panel.querySelectorAll('.demo__line')];
    const pips = $$('.demo__pips i'), typing = panel.querySelector('.typing');
    const stages = (panel.dataset.stages || '').split('|'), stage = $('#demoStage');
    const label = i => { if (stage && stages[i]) stage.textContent = stages[i]; };
    lines.forEach(line => line.classList.remove('is-shown')); pips.forEach(pip => pip.classList.remove('is-on'));
    typing?.classList.remove('is-shown');
    if (reduce.matches) { lines.forEach(line => line.classList.add('is-shown')); pips.forEach(pip => pip.classList.add('is-on')); label(stages.length - 1); return; }
    let index = 0;
    const next = () => {
      if (index >= lines.length) { later(demoTimers, () => play(TABS[(TABS.indexOf(name) + 1) % TABS.length]), 2600); return; }
      const line = lines[index];
      const show = () => { typing?.classList.remove('is-shown'); line.classList.add('is-shown'); pips[index]?.classList.add('is-on'); label(index); index += 1; later(demoTimers, next, 1500); };
      // In chat, the assistant "types" before each reply.
      if (name === 'chat' && !line.classList.contains('bubble--you') && typing) { typing.classList.add('is-shown'); later(demoTimers, show, 900); }
      else show();
    };
    later(demoTimers, next, 900);   // a short pause before the first line
  }
  $('.demo__tabs')?.addEventListener('click', event => {
    const tab = event.target.closest('[data-demo-tab]');
    if (tab) play(tab.dataset.demoTab);   // clicking a tab restarts it
  });
  $('.demo__tabs')?.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const current = TABS.findIndex(name => $(`[data-demo-tab="${name}"]`).getAttribute('aria-selected') === 'true');
    const name = TABS[(current + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    play(name); $(`[data-demo-tab="${name}"]`).focus();
  });

  // ---- Four steps: a progress line fills step by step and the active card lifts. ----
  function steps() {
    const cards = $$('[data-steps] > .card'), line = $('.steps-line');
    if (!cards.length) return;
    if (reduce.matches) { line?.style.setProperty('--p', '1'); return; }
    let step = 0;
    const tick = () => {
      cards.forEach((card, i) => card.toggleAttribute('data-active', i === step));
      line?.style.setProperty('--p', String((step + 1) / cards.length));
      step = (step + 1) % cards.length;
    };
    tick(); every(tick, 2200);
  }

  // ---- Example figures count up once per page load (the final values are already in the HTML). ----
  function countUp() {
    if (counted) return; counted = true;
    const items = $$('[data-count]');
    if (reduce.matches) return;
    const start = performance.now(), duration = 1200;
    const step = now => {
      const t = Math.min(1, (now - start) / duration), eased = 1 - (1 - t) ** 3;
      items.forEach(item => { item.textContent = `${Math.round(Number(item.dataset.count) * eased)}${item.dataset.suffix || ''}`; });
      if (t < 1 && running) frame = requestAnimationFrame(step);
      else items.forEach(item => { item.textContent = `${item.dataset.count}${item.dataset.suffix || ''}`; });
    };
    frame = requestAnimationFrame(step);
  }

  function start() {
    if (running) return;
    running = true;
    $('#demo')?.classList.add('is-running');
    const began = Date.now(), timer = $('#demoTimer');
    if (timer && !reduce.matches) every(() => {
      const seconds = Math.floor((Date.now() - began) / 1000);
      timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }, 1000);
    play('talk'); steps(); countUp();
  }
  function stop() {
    running = false;
    clear(timers); clear(demoTimers); cancelAnimationFrame(frame);
    $('#demo')?.classList.remove('is-running');
  }
  const visible = () => !landing.hidden && landing.closest('.view')?.classList.contains('active');
  const sync = () => (visible() ? start() : stop());
  new MutationObserver(sync).observe(landing, {attributes: true, attributeFilter: ['hidden']});
  const view = landing.closest('.view');
  if (view) new MutationObserver(sync).observe(view, {attributes: true, attributeFilter: ['class']});
  reduce.addEventListener('change', () => { stop(); sync(); });
  window.addEventListener('pagehide', stop);
  sync();
})();
