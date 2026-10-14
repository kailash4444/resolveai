/* ResolveAI app shell: role navigation, mobile drawer, Focus/Detail preference, shared connection states. */
(() => {
  const byId = id => document.getElementById(id);
  const svg = path => `<svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  const ICONS = {
    'customer-home': '<path d="M3 11l9-8 9 8v10H3z"/>',
    'customer-create': '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    tickets: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    calls: '<path d="M6 3h3l2 5-2 2a15 15 0 0 0 5 5l2-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z"/>',
    transcripts: '<path d="M4 6h16M4 11h16M4 16h10M4 21h6"/>',
    analytics: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
    'resolution-radar': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6"/>',
    knowledge: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
    qa: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    technicians: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 6"/>',
    configuration: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  };
  const STAFF = [['overview', 'Overview'], ['tickets', 'Tickets'], ['calls', 'Calls & queue'], ['transcripts', 'Transcripts'], ['analytics', 'Analytics'], ['resolution-radar', 'Resolution debt'], ['knowledge', 'Knowledge'], ['qa', 'Quality audit']];
  const NAV = {
    customer: [['customer-home', 'My support'], ['customer-create', 'Report an issue'], ['knowledge', 'Help articles']],
    technician: STAFF,
    admin: [...STAFF, ['technicians', 'Users'], ['configuration', 'Configuration']],
  };
  const HOME = {customer: '/portal', technician: '/console', admin: '/admin'};
  // Views without their own nav entry highlight their parent section.
  const PARENT = {'ticket-detail': 'tickets', 'time-machine': 'tickets', case: 'overview', 'call-analytics': 'analytics'};
  const LABEL = {customer: 'Customer support', technician: 'Technician workspace', admin: 'Admin workspace'};
  let role = 'guest';

  const sidebar = byId('appSidebar'), toggle = byId('mobileNavToggle'), scrim = byId('mobileNavBackdrop');
  const drawerQuery = window.matchMedia('(max-width: 768px)');

  function links(items) {
    return items.map(([view, label]) => `<a href="${HOME[role]}?view=${view}" data-view="${view}">${svg(ICONS[view])}<span>${label}</span></a>`).join('');
  }

  function render(user) {
    role = user?.role || 'guest';
    document.body.dataset.role = role;
    document.body.dataset.shell = role === 'guest' ? 'public' : role === 'customer' ? 'customer' : 'staff';
    const items = NAV[role] || [];
    byId('appNav').innerHTML = links(items);
    byId('appNav').setAttribute('aria-label', role === 'customer' ? 'Customer' : role === 'admin' ? 'Admin' : 'Technician');
    byId('topNav').innerHTML = role === 'customer' ? links(items) : '';
    byId('workspaceLabel').textContent = LABEL[role] || '';
    sidebar.hidden = role === 'guest';
    byId('workspaceTopbar').hidden = role === 'guest';
    byId('accountIdentity').textContent = user ? `${user.name} · ${role === 'admin' ? 'Admin' : role === 'customer' ? 'Customer' : 'Technician'}` : '';
    // Customers always see Focus; staff keep their saved preference (default Focus).
    const modeSwitch = byId('modeSwitch');
    modeSwitch.hidden = role === 'guest' || role === 'customer';
    let saved = 'focus';
    try { saved = localStorage.getItem('resolveai-view-mode') === 'detail' ? 'detail' : 'focus'; } catch (_) {}
    const mode = role === 'admin' || role === 'technician' ? saved : 'focus';
    document.body.dataset.mode = mode;
    modeSwitch.setAttribute('aria-checked', String(mode === 'detail'));
    closeDrawer(false);
    syncDrawer();
  }

  function setCurrent(view) {
    const target = PARENT[view] || view;
    document.body.dataset.currentView = view;   // not data-view: that attribute marks navigation links
    document.querySelectorAll('#appNav a, #topNav a').forEach(link => {
      if (link.dataset.view === target) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  // Persist the Focus/Detail choice after the component script flips it.
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-mode-switch]')) return;
    queueMicrotask(() => { try { localStorage.setItem('resolveai-view-mode', document.body.dataset.mode); } catch (_) {} });
  });

  // ---- Drawer at 768px and below: focus trap, Escape closes, focus returns to Menu. ----
  const isOpen = () => sidebar.hasAttribute('data-open');
  function syncDrawer() {
    const mobile = drawerQuery.matches;
    sidebar.inert = mobile && !isOpen();
    if (!mobile && isOpen()) closeDrawer(false);
  }
  function openDrawer() {
    sidebar.setAttribute('data-open', '');
    sidebar.inert = false;
    toggle.setAttribute('aria-expanded', 'true');
    scrim.hidden = false;
    byId('shellBody').inert = true;
    (sidebar.querySelector('[aria-current="page"]') || sidebar.querySelector('a, button'))?.focus();
  }
  function closeDrawer(restore = true) {
    const wasOpen = isOpen();
    sidebar.removeAttribute('data-open');
    toggle.setAttribute('aria-expanded', 'false');
    scrim.hidden = true;
    byId('shellBody').inert = false;
    sidebar.inert = drawerQuery.matches;
    if (restore && wasOpen) toggle.focus();
  }
  toggle.addEventListener('click', () => (isOpen() ? closeDrawer() : openDrawer()));
  byId('closeNav').addEventListener('click', () => closeDrawer());
  scrim.addEventListener('click', () => closeDrawer());
  sidebar.addEventListener('click', event => { if (event.target.closest('a[data-view]') && drawerQuery.matches) closeDrawer(false); });
  document.addEventListener('keydown', event => {
    if (!isOpen()) return;
    if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); return; }
    if (event.key !== 'Tab') return;
    const items = [...sidebar.querySelectorAll('a[href], button:not([disabled])')].filter(el => el.getClientRects().length);
    if (!items.length) return;
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
  });
  drawerQuery.addEventListener('change', syncDrawer);

  // ---- Shared connection states ----
  const offline = byId('offlineNotice');
  const syncOnline = () => { offline.hidden = navigator.onLine; };
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  syncOnline();

  let pending = 0, slowTimer;
  function requestStarted() {
    pending += 1;
    if (pending === 1) slowTimer = setTimeout(() => { byId('slowNotice').hidden = false; }, 6000);
  }
  function requestFinished() {
    pending = Math.max(0, pending - 1);
    if (!pending) { clearTimeout(slowTimer); byId('slowNotice').hidden = true; }
  }
  function sessionExpired() {
    const dialog = byId('sessionDialog');
    if (role !== 'guest' && !dialog.open) dialog.showModal();
  }
  byId('sessionSignIn').addEventListener('click', () => { location.assign(role === 'customer' ? '/login' : '/login?as=staff'); });

  // ---- Unsaved changes. "unload" keys only guard leaving the page; "all" keys also guard in-app navigation. ----
  const dirty = new Map();
  let retryLeave = null;
  window.ResolveDirty = {
    mark(key, on, scope = 'unload') { if (on) dirty.set(key, scope); else dirty.delete(key); },
    clear() { dirty.clear(); },
    isDirty() { return [...dirty.values()].includes('all'); },
  };
  window.confirmLeave = retry => {
    if (![...dirty.values()].includes('all')) return true;
    retryLeave = retry;
    byId('leaveDialog').showModal();
    return false;
  };
  byId('confirmLeave').addEventListener('click', () => {
    [...dirty].forEach(([key, scope]) => { if (scope === 'all') dirty.delete(key); });
    byId('leaveDialog').close();
    const retry = retryLeave; retryLeave = null; retry?.();
  });
  window.addEventListener('beforeunload', event => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });

  window.Shell = {render, setCurrent, closeDrawer, requestStarted, requestFinished, sessionExpired, home: r => HOME[r] || '/'};
  render(null);
})();
