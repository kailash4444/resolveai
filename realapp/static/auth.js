/* Public entry: landing, log in, create account (/signup, customers only) and first-administrator setup.
   Log in is one page (/login) with a Customer | Technician switch; /login?as=staff opens the staff side.
   The chosen side is sent to the server, which refuses accounts from the other side: a customer can never log in as a
   technician or administrator, and staff can't log in on the customer side.
   Sign-up always creates a customer account; technician and admin accounts are created by an administrator.
   Destinations after log in are carried in the URL (?next=support) and only known values are honoured. */
(() => {
  const NEXT = {support: '/support'};
  const form = $('#authForm'), submit = $('#authSubmit'), error = $('#authError');
  let auth = null, mode = 'signin';

  const params = () => new URLSearchParams(location.search);
  const nextParam = () => (NEXT[params().get('next')] ? params().get('next') : null);

  const COPY = {
    signin: {kicker: 'Customer log in', title: 'Welcome back', desc: 'Log in with your email to report issues, talk or chat with support, and follow your requests.',
             button: 'Log in <span aria-hidden="true">→</span>', busy: 'Logging in…', page: 'Log in · ResolveAI'},
    staff:  {kicker: 'Technician and admin log in', title: 'Welcome back', desc: 'Work your support queue. Administrators also manage people and settings here.',
             button: 'Log in <span aria-hidden="true">→</span>', busy: 'Logging in…', page: 'Staff log in · ResolveAI'},
    signup: {kicker: 'Create account', title: 'Get help from ResolveAI', desc: 'For customers: report issues, talk or chat with support and follow every request in one place.',
             button: 'Create account <span aria-hidden="true">→</span>', busy: 'Creating your account…', page: 'Create account · ResolveAI'},
    closed: {kicker: 'Create account', title: 'Accounts are created by your administrator', desc: 'Creating your own account is turned off on this server. Ask your ResolveAI administrator to create your account, then log in.',
             page: 'Create account · ResolveAI'},
    setup:  {kicker: 'First-time setup', title: 'Create the administrator account', desc: 'No accounts exist yet. The first account becomes the workspace administrator, who then adds technicians and customers.',
             button: 'Create administrator account', busy: 'Creating account…', page: 'Set up ResolveAI'},
  };

  // Log in with Google / Microsoft: buttons appear for the providers the server has keys for. The side (customer or
  // technician) travels with the request, and the server applies the same rules as the email form.
  const PROVIDER_ICONS = {
    google: '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>',
    microsoft: '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 21 21"><path fill="#F25022" d="M1 1h9v9H1z"/><path fill="#7FBA00" d="M11 1h9v9h-9z"/><path fill="#00A4EF" d="M1 11h9v9H1z"/><path fill="#FFB900" d="M11 11h9v9h-9z"/></svg>',
  };
  const OAUTH_ERRORS = {
    cancelled: 'Log in was cancelled. Try again, or use your email and password.',
    expired: 'That log-in attempt timed out. Try again.',
    unverified: 'That account didn’t share a verified email address. Log in with your email and password instead.',
    no_account: 'We couldn’t log you in with that account. Check you chose the right side (Customer or Technician), or ask your administrator.',
    signup_off: 'Creating an account is turned off. Ask your ResolveAI administrator for an account.',
    failed: 'Log in with that account didn’t work. Try again, or use your email and password.',
  };
  function renderProviders() {
    const list = auth?.oauth || [], show = list.length > 0 && ['signin', 'staff', 'signup'].includes(mode);
    $('#authOauth').hidden = !show;
    if (!show) return;
    const side = mode === 'staff' ? 'technician' : 'customer', verb = mode === 'signup' ? 'Sign up' : 'Continue';
    $('#authProviders').innerHTML = list.map(item => `<a class="btn btn-soft auth__provider" href="/api/auth/oauth/${encodeURIComponent(item.id)}/start?side=${side}">${PROVIDER_ICONS[item.id] || ''}<span>${verb} with ${esc(item.label)}</span></a>`).join('');
  }

  // Customer links keep ?next (it only leads to customer pages) so the user still lands where they were going.
  const PATHS = {signin: '/login', signup: '/signup', staff: '/login'};
  function linkFor(target) {
    const query = new URLSearchParams();
    if (target === 'staff') query.set('as', 'staff');
    else if (nextParam()) query.set('next', nextParam());
    return `${PATHS[target]}${query.toString() ? `?${query}` : ''}`;
  }

  function setMode(value) {
    mode = value;
    const copy = COPY[mode], setup = mode === 'setup', signup = mode === 'signup', closed = mode === 'closed';
    $('#authCard').dataset.mode = mode;
    $('#authKicker').textContent = copy.kicker;
    $('#authTitle').textContent = copy.title;
    $('#authDescription').textContent = copy.desc;
    form.hidden = closed;
    $('#authSignupNotice').hidden = !closed;
    $('#authNameField').hidden = !(setup || signup);
    form.elements.name.required = setup || signup;
    $('#setupTokenField').hidden = !setup || !auth?.setup_token_required;
    form.elements.setup_token.required = setup && !!auth?.setup_token_required;
    form.elements.password.minLength = setup || signup ? 12 : 1;
    form.elements.password.autocomplete = setup || signup ? 'new-password' : 'current-password';
    $('#passwordHelp').hidden = !(setup || signup);
    // Customers sign up with their Gmail or work email (it becomes their username); log in accepts either.
    const id = form.elements.username;
    $('label[for="authUsername"]').textContent = signup ? 'Email address' : setup ? 'Username' : 'Email or username';
    id.type = signup ? 'email' : 'text';
    id.autocomplete = signup ? 'email' : 'username';
    id.placeholder = signup ? 'you@gmail.com or you@company.com' : '';
    $('#emailHelp').hidden = !signup;
    $('#authHelp').hidden = mode !== 'signin' && mode !== 'staff';
    if (copy.button) submit.innerHTML = copy.button;
    // Footer: customer sign in <-> create account; staff sign-in has no sign-up (staff accounts come from an administrator).
    $('#authSwitch').hidden = setup || mode === 'staff';
    // Customer | Technician switch at the top of the sign-in card.
    $('#authSide').hidden = mode !== 'signin' && mode !== 'staff';
    // Create account is for customers only; staff accounts are created by an administrator.
    $('#authSide').querySelectorAll('a').forEach(link => {
      if (link.dataset.authLink === mode) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      link.href = linkFor(link.dataset.authLink);
    });
    $('#authSwitchText').textContent = mode === 'signin' ? 'New to ResolveAI?' : 'Already have an account?';
    $('#authSwitchLink').textContent = mode === 'signin' ? 'Create account' : 'Log in';
    $('#authSwitchLink').dataset.authLink = mode === 'signin' ? 'signup' : 'signin';
    $('#authSwitchLink').href = linkFor(mode === 'signin' ? 'signup' : 'signin');
    document.querySelectorAll('#authSignupNotice [data-auth-link]').forEach(link => { link.href = linkFor('signin'); });
    document.title = copy.page;
    clearError();
    renderProviders();
  }

  function clearError() {
    error.hidden = true; error.textContent = '';
    form.querySelectorAll('.input').forEach(input => input.removeAttribute('aria-invalid'));
  }

  function showError(message, fields = ['username', 'password']) {
    error.textContent = `✕ ${message}`; error.hidden = false;
    fields.forEach(name => form.elements[name]?.setAttribute('aria-invalid', 'true'));
  }

  // Called by loadApplication when nobody is signed in.
  async function showPublic(status) {
    auth = status;
    const path = location.pathname, oauthError = OAUTH_ERRORS[params().get('oauth_error')];
    $('#roleSignInChoices').hidden = !!auth.setup_required;
    $('#firstAdminSetup').hidden = !auth.setup_required;
    // ?auth=login is the older log-in link (still used by some buttons and bookmarks); it opens /login.
    const wantsAuth = ['/login', '/signup'].includes(path) || params().get('auth') === 'login' || !!nextParam() || ['/portal', '/console', '/admin'].includes(path);
    $('#landing').hidden = wantsAuth;
    $('#authPage').hidden = !wantsAuth;
    if (!wantsAuth) return;
    // Keep ?next in the address bar so a refresh or back-navigation still knows where to go.
    const query = new URLSearchParams();
    if (nextParam()) query.set('next', nextParam());
    // Signed-out visits to the staff workspaces (/console, /admin) open log in on the Technician side.
    const staff = !auth.setup_required && !nextParam() && path !== '/signup' && (params().get('as') === 'staff' || ['/console', '/admin'].includes(path));
    const target = auth.setup_required ? '/login' : path === '/signup' ? '/signup' : '/login';
    if (staff) { query.delete('next'); query.set('as', 'staff'); }
    history.replaceState(null, '', `${target}${query.toString() ? `?${query}` : ''}`);
    setMode(auth.setup_required ? 'setup' : target === '/signup' ? (auth.signup_enabled === false ? 'closed' : 'signup') : staff ? 'staff' : 'signin');
    $('#authNextNotice').hidden = !nextParam() || mode === 'staff';
    if (oauthError) showError(oauthError, []);   // back from Google / Microsoft without logging in
    (mode === 'setup' || mode === 'signup' ? form.elements.name : mode === 'closed' ? $('#authTitle') : form.elements.username).focus({preventScroll: true});
  }

  function requestBody(values) {
    if (mode === 'setup') return ['/api/auth/setup', {name: values.name, username: values.username, password: values.password, setup_token: values.setup_token || ''}];
    if (mode === 'signup') return ['/api/auth/register', {name: values.name.trim(), email: values.username.trim(), password: values.password}];
    // The page decides the side; the server rejects accounts that belong to the other side.
    return ['/api/auth/login', {username: values.username, password: values.password, expected_role: mode === 'staff' ? 'technician' : 'customer'}];
  }

  // Field-level messages for sign-up, so people know which field to fix.
  function invalidMessage(invalid) {
    const field = invalid[0];
    if (!field) return 'Fill in the highlighted fields.';
    if (field.name === 'name' && field.validity.tooShort) return 'Enter your full name (at least 2 characters).';
    if (field.name === 'password' && field.validity.tooShort) return 'Use a password of at least 12 characters.';
    if (field.name === 'username' && field.validity.typeMismatch) return 'Enter a valid email address, like name@company.com.';
    return 'Fill in the highlighted fields.';
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearError();
    if (!form.checkValidity()) {
      const invalid = [...form.elements].filter(el => el.willValidate && !el.validity.valid);
      showError(invalidMessage(invalid), invalid.map(el => el.name));
      invalid[0]?.focus();
      return;
    }
    const [path, body] = requestBody(Object.fromEntries(new FormData(form)));
    // Same rules as the server, checked here too (the browser only checks lengths on typed input).
    const problem = mode !== 'signup' && mode !== 'setup' ? null
      : body.name.trim().length < 2 ? ['name', 'Enter your full name (at least 2 characters).']
      : mode === 'signup' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email) ? ['username', 'Enter a valid email address, like name@company.com.']
      : mode === 'setup' && !/^[a-zA-Z0-9_.@+-]{3,254}$/.test(body.username) ? ['username', 'Use 3 or more letters, numbers, dots, dashes, underscores or @ for the username, with no spaces.']
      : body.password.length < 12 ? ['password', 'Use a password of at least 12 characters.']
      : mode === 'signup' && body.email.split('@')[0].length >= 3 && body.password.toLowerCase().includes(body.email.split('@')[0].toLowerCase()) ? ['password', 'Choose a password that doesn’t contain your email.']
      : null;
    if (problem) { showError(problem[1], [problem[0]]); form.elements[problem[0]].focus(); return; }
    submit.disabled = true; submit.setAttribute('aria-busy', 'true');
    const label = submit.innerHTML; submit.textContent = COPY[mode].busy;
    try {
      const user = await api(path, {method: 'POST', body: JSON.stringify(body)});
      const next = mode === 'staff' ? null : nextParam();
      if (next) { location.assign(NEXT[next]); return; }
      history.replaceState(null, '', window.Shell.home(user.role));
      // Straight into the workspace: never flash the landing page while it loads.
      $('#authPage').hidden = true; $('#appLoading').hidden = false;
      form.reset();
      await window.loadApplication();
      if (path === '/api/auth/register') window.toast?.(`Welcome, ${user.name}. Your account is ready.`);
    } catch (err) {
      const fields = /token/i.test(err.message) ? ['setup_token'] : /username already/i.test(err.message) ? ['username']
        : /password/i.test(err.message) && mode !== 'signin' ? ['password'] : /name/i.test(err.message) && mode !== 'signin' ? ['name'] : ['username', 'password'];
      showError(err.message, fields);
      form.elements[fields[0]]?.focus();
    } finally {
      submit.disabled = false; submit.removeAttribute('aria-busy'); if (submit.textContent.endsWith('…')) submit.innerHTML = label;
    }
  });

  // Switch between log in sides and create account in place (no full reload).
  document.addEventListener('click', event => {
    const link = event.target.closest('#authPage [data-auth-link]');
    if (!link || !auth || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    history.pushState(null, '', link.getAttribute('href'));
    showPublic(auth);
  });
  window.addEventListener('popstate', () => { if (auth && !auth.user && ['/login', '/signup'].includes(location.pathname)) showPublic(auth); });

  $('#togglePassword').addEventListener('click', event => {
    const button = event.currentTarget, input = form.elements.password, show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
  });

  window.Auth = {showPublic};
})();
