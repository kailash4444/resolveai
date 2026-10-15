/* ResolveAI Pop behaviour. Plain JS, no dependencies. */
document.body.dataset.mode = document.body.dataset.mode || 'focus';
document.addEventListener('click', e => {
  const t = e.target.closest('[data-open],[data-close],[data-toast],[role="tab"],[data-copy]');
  if (!t) return;
  if (t.dataset.open) document.getElementById(t.dataset.open).showModal();      // native focus trap + Escape + focus restore
  if ('close' in t.dataset) t.closest('dialog').close();
  if (t.dataset.toast) {                                                          // success only; errors stay inline
    const box = document.querySelector('.toasts'), n = document.createElement('div');
    n.className = 'toast'; n.textContent = '✓ ' + t.dataset.toast; box.append(n); setTimeout(() => n.remove(), 5000);
  }
  if (t.getAttribute('role') === 'tab') {                                         // tabs
    const list = t.closest('[role="tablist"]');
    list.querySelectorAll('[role="tab"]').forEach(b => {
      const sel = b === t; b.setAttribute('aria-selected', sel); b.tabIndex = sel ? 0 : -1;
      const panel = document.getElementById(b.getAttribute('aria-controls'));   // some tab sets manage their own panels
      if (panel) panel.hidden = !sel;
    });
  }
  if (t.dataset.copy) navigator.clipboard.writeText(document.getElementById(t.dataset.copy).textContent);
});
document.addEventListener('keydown', e => {                                       // arrow keys move between tabs
  if (!['ArrowLeft','ArrowRight'].includes(e.key) || e.target.getAttribute('role') !== 'tab') return;
  const tabs = [...e.target.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
  const next = tabs[(tabs.indexOf(e.target) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.focus(); next.click();
});
