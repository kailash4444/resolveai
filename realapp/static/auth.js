/* Public entry: landing, log in, create account (/signup, customers only) and first-administrator setup.
   Log in is one page (/login) with a Customer | Technician / Admin switch; /login?as=staff opens the staff side.
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
    signin: {kicker: 'Customer log in', title: 'Welcome back', desc: 'Report issues, talk or chat with support, and follow your requests.',
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
    $('#authHelp').hidden = mode !== 'signin' && mode !== 'staff';
    if (copy.button) submit.innerHTML = copy.button;
    // Footer: customer sign in <-> create account; staff sign-in has no sign-up (staff accounts come from an administrator).
    $('#authSwitch').hidden = setup || mode === 'staff';
    // Customer | Technician / Admin switch at the top of the sign-in card.
    $('#authSide').hidden = mode !== 'signin' && mode !== 'staff';
    // Create account is for customers only; staff accounts are created by an administrator.
    $('#signupStaffNote').hidden = !signup;
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
    const path = location.pathname;
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
    // Signed-out visits to the staff workspaces (/console, /admin) open log in on the Technician / Admin side.
    const staff = !auth.setup_required && !nextParam() && path !== '/signup' && (params().get('as') === 'staff' || ['/console', '/admin'].includes(path));
    const target = auth.setup_required ? '/login' : path === '/signup' ? '/signup' : '/login';
    if (staff) { query.delete('next'); query.set('as', 'staff'); }
    history.replaceState(null, '', `${target}${query.toString() ? `?${query}` : ''}`);
    setMode(auth.setup_required ? 'setup' : target === '/signup' ? (auth.signup_enabled === false ? 'closed' : 'signup') : staff ? 'staff' : 'signin');
    $('#authNextNotice').hidden = !nextParam() || mode === 'staff';
    (mode === 'setup' || mode === 'signup' ? form.elements.name : mode === 'closed' ? $('#authTitle') : form.elements.username).focus({preventScroll: true});
  }

  function requestBody(values) {
    if (mode === 'setup') return ['/api/auth/setup', {name: values.name, username: values.username, password: values.password, setup_token: values.setup_token || ''}];
    if (mode === 'signup') return ['/api/auth/register', {name: values.name.trim(), username: values.username.trim(), password: values.password}];
    // The page decides the side; the server rejects accounts that belong to the other side.
    return ['/api/auth/login', {username: values.username, password: values.password, expected_role: mode === 'staff' ? 'technician' : 'customer'}];
  }

  // Field-level messages for sign-up, so people know which field to fix.
  function invalidMessage(invalid) {
    const field = invalid[0];
    if (!field) return 'Fill in the highlighted fields.';
    if (field.name === 'name' && field.validity.tooShort) return 'Enter your full name (at least 2 characters).';
    if (field.name === 'password' && field.validity.tooShort) return 'Use a password of at least 12 characters.';
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
      : mode === 'signup' && !/^[a-zA-Z0-9_.@-]{3,80}$/.test(body.username) ? ['username', 'Use 3 or more letters, numbers, dots, dashes, underscores or @ for your username, with no spaces.']
      : body.password.length < 12 ? ['password', 'Use a password of at least 12 characters.']
      : mode === 'signup' && body.password.toLowerCase().includes(body.username.toLowerCase()) ? ['password', 'Choose a password that doesn’t contain your username.']
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
