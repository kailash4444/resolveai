(() => {
  const controls = [...document.querySelectorAll('[data-view-mode]')];
  const workspaceLabel = document.querySelector('.workspace-label');
  const defaultLabel = workspaceLabel?.textContent?.trim() || 'SERVICE OPERATIONS';
  let mode = localStorage.getItem('resolveai-view-mode') === 'detail' ? 'detail' : 'focus';

  function applyMode(value = mode) {
    mode = value === 'detail' ? 'detail' : 'focus';
    document.body.dataset.viewMode = mode;
    controls.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.viewMode === mode)));
    localStorage.setItem('resolveai-view-mode', mode);
  }

  function applyRole(user) {
    const role = user?.role || 'guest';
    if (workspaceLabel) workspaceLabel.textContent = role === 'customer' ? 'CUSTOMER SUPPORT' : defaultLabel;
    const admin = role === 'admin';
    document.querySelectorAll('[data-view="technicians"]').forEach(button => {
      if (!admin && role !== 'guest') button.hidden = true;
    });
    document.querySelectorAll('.system-card').forEach(card => { card.hidden = !user || role === 'customer'; });
    document.querySelectorAll('.staff-only').forEach(node => { node.hidden = role === 'customer' || role === 'guest'; });
    if (role === 'customer' || role === 'guest') applyMode('focus');
  }

  controls.forEach(button => button.addEventListener('click', () => applyMode(button.dataset.viewMode)));
  const originalApplyAccountRole = window.applyAccountRole;
  if (typeof originalApplyAccountRole === 'function') {
    window.applyAccountRole = user => {
      originalApplyAccountRole(user);
      applyRole(user);
    };
  }
  applyMode();
  applyRole(null);
})();
