/* Light / dark theme. Loaded in <head> so the saved theme applies before first paint. */
(() => {
  // The app shell must never run inside one of its own frames (that nests copies of the app and their polling).
  let framedApp = false;
  try { framedApp = window.top !== window.self && window.top.location.origin === location.origin && !location.pathname.startsWith('/support'); } catch (_) {}
  if (framedApp) {
    window.stop();
    document.documentElement.innerHTML = '<head><meta charset="utf-8"><link rel="stylesheet" href="/static/resolveai-components.css?v=8"></head><body class="support--embedded"><p class="sec" style="padding:16px">Your session has ended. <a href="/login" target="_top">Sign in again</a> to call support.</p></body>';
    return;
  }
  const KEY = 'resolveai-theme', root = document.documentElement;
  const SUN = '<svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const saved = () => { try { return localStorage.getItem(KEY); } catch (_) { return null; } };
  // An embedded page (the portal's voice card) always follows the page around it.
  const parentTheme = () => { try { return window.parent !== window ? window.parent.document.documentElement.dataset.theme : null; } catch (_) { return null; } };
  const preferred = () => parentTheme() || saved() || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

  // Each toggle names the theme it switches to, so its label always describes the action.
  function apply(theme) {
    root.dataset.theme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const next = theme === 'light' ? 'dark' : 'light';
      button.innerHTML = next === 'light' ? SUN : MOON;
      button.setAttribute('aria-label', `Switch to ${next} theme`);
      button.title = `Switch to ${next} theme`;
    });
  }

  window.ResolveTheme = {apply};
  apply(preferred());
  document.addEventListener('DOMContentLoaded', () => apply(preferred()));
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-theme-toggle]')) return;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch (_) {}
    apply(next);
    document.querySelectorAll('iframe').forEach(frame => { try { frame.contentWindow.ResolveTheme?.apply(next); } catch (_) {} });
  });
  // Keeps the embedded voice page and other open tabs in step.
  window.addEventListener('storage', event => { if (event.key === KEY) apply(preferred()); });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (!saved()) apply(preferred()); });
})();
