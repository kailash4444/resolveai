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

// Preserve explicit role intent and a pending support destination across the auth modal's URL update.
const supportReturnKey = 'resolveai-support-return';
const nativeOpenAccountAuth = window.openAccountAuth;
if (typeof nativeOpenAccountAuth === 'function') {
  window.openAccountAuth = async (role = null, mode = 'signin') => {
    const params = new URLSearchParams(location.search);
    const requestedRole = params.get('role');
    if (['customer', 'technician'].includes(requestedRole)) role = requestedRole;
    if (params.get('next') === 'support') sessionStorage.setItem(supportReturnKey, '/support');
    const result = await nativeOpenAccountAuth(role, mode);
    if (sessionStorage.getItem(supportReturnKey)) history.replaceState(null, '', `${location.pathname}?next=support`);
    return result;
  };
}

const nativeLoadApplication = window.loadApplication;
if (typeof nativeLoadApplication === 'function') {
  window.loadApplication = async (...args) => {
    const destination = sessionStorage.getItem(supportReturnKey);
    if (destination) {
      try {
        const auth = await api('/api/auth/status');
        if (auth.user) {
          sessionStorage.removeItem(supportReturnKey);
          location.assign(destination);
          return;
        }
      } catch (_) {}
    }
    return nativeLoadApplication(...args);
  };
}
