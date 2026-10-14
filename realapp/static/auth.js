/* Public entry: landing, log in and first-administrator setup.
   Log in stays on the public app route; ?auth=login&as=staff opens the staff side.
   The selected side is sent to the server, which refuses accounts from the other side.
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
    setup:  {kicker: 'First-time setup', title: 'Create the administrator account', desc: 'No accounts exist yet. The first account becomes the workspace administrator, who then adds your technicians and customers.',
             button: 'Create administrator account', busy: 'Creating account…', page: 'Set up ResolveAI'},
  };

  const PATHS = {signin: '/', staff: '/'};
  function linkFor(target) {
    const query = new URLSearchParams();
    query.set('auth', 'login');
    if (target === 'staff') query.set('as', 'staff');
    else if (nextParam()) query.set('next', nextParam());
    return PATHS[target] + (query.toString() ? '?' + query : '');
  }

  function setMode(value) {
    mode = value;
    const copy = COPY[mode], setup = mode === 'setup';
    $('#authCard').dataset.mode = mode;
    $('#authKicker').textContent = copy.kicker;
    $('#authTitle').textContent = copy.title;
    $('#authDescription').textContent = copy.desc;
    $('#authNameField').hidden = !setup;
    form.elements.name.required = setup;
    $('#setupTokenField').hidden = !setup || !auth?.setup_token_required;
    form.elements.setup_token.required = setup && !!auth?.setup_token_required;
    form.elements.password.minLength = setup ? 12 : 1;
    form.elements.password.autocomplete = setup ? 'new-password' : 'current-password';
    $('#passwordHelp').hidden = !setup;
    $('#authHelp').hidden = mode !== 'signin' && mode !== 'staff';
    submit.innerHTML = copy.button;
    $('#authSide').hidden = mode !== 'signin' && mode !== 'staff';
    $('#authSide').querySelectorAll('a').forEach(link => {
      if (link.dataset.authLink === mode) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
      link.href = linkFor(link.dataset.authLink);
    });
    document.title = copy.page;
    clearError();
  }

  function clearError() {
    error.hidden = true;
    error.textContent = '';
    form.querySelectorAll('.input').forEach(input => input.removeAttribute('aria-invalid'));
  }

  function showError(message, fields = ['username', 'password']) {
    error.textContent = '✕ ' + message;
    error.hidden = false;
    fields.forEach(name => form.elements[name]?.setAttribute('aria-invalid', 'true'));
  }

  async function showPublic(status) {
    auth = status;
    const path = location.pathname;
    $('#roleSignInChoices').hidden = !!auth.setup_required;
    $('#firstAdminSetup').hidden = !auth.setup_required;
    const wantsAuth = params().get('auth') === 'login' || path === '/login' || path === '/signup' || !!nextParam() || ['/portal', '/console', '/admin'].includes(path);
    $('#landing').hidden = wantsAuth;
    $('#authPage').hidden = !wantsAuth;
    if (!wantsAuth) return;

    const query = new URLSearchParams();
    if (nextParam()) query.set('next', nextParam());
    const staff = !auth.setup_required && !nextParam() &&
      (params().get('as') === 'staff' || ['/console', '/admin'].includes(path));
    if (staff) { query.delete('next'); query.set('as', 'staff'); }
    query.set('auth', 'login');
    history.replaceState(null, '', '/' + (query.toString() ? '?' + query : ''));
    setMode(auth.setup_required ? 'setup' : staff ? 'staff' : 'signin');
    $('#authNextNotice').hidden = !nextParam() || mode === 'staff';
    (mode === 'setup' ? form.elements.name : form.elements.username).focus({preventScroll: true});
  }

  function requestBody(values) {
    if (mode === 'setup') return ['/api/auth/setup', {
      name: values.name, username: values.username, password: values.password, setup_token: values.setup_token || ''
    }];
    return ['/api/auth/login', {
      username: values.username, password: values.password, expected_role: mode === 'staff' ? 'technician' : 'customer'
    }];
  }

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
    const problem = mode !== 'setup' ? null
      : body.name.trim().length < 2 ? ['name', 'Enter your full name (at least 2 characters).']
      : body.password.length < 12 ? ['password', 'Use a password of at least 12 characters.']
      : null;
    if (problem) { showError(problem[1], [problem[0]]); form.elements[problem[0]].focus(); return; }

    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    const label = submit.innerHTML;
    submit.textContent = COPY[mode].busy;
    try {
      const user = await api(path, {method: 'POST', body: JSON.stringify(body)});
      const next = mode === 'staff' ? null : nextParam();
      if (next) { location.assign(NEXT[next]); return; }
      history.replaceState(null, '', window.Shell.home(user.role));
      $('#authPage').hidden = true;
      $('#landing').hidden = false;
      form.reset();
      await window.loadApplication();
    } catch (err) {
      const fields = /token/i.test(err.message) ? ['setup_token']
        : mode === 'setup' && /password/i.test(err.message) ? ['password']
        : mode === 'setup' && /name/i.test(err.message) ? ['name']
        : ['username', 'password'];
      showError(err.message, fields);
      form.elements[fields[0]]?.focus();
    } finally {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      if (submit.textContent.endsWith('…')) submit.innerHTML = label;
    }
  });

  document.addEventListener('click', event => {
    const link = event.target.closest('#authPage [data-auth-link]');
    if (!link || !auth || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    history.pushState(null, '', link.getAttribute('href'));
    showPublic(auth);
  });
  window.addEventListener('popstate', () => {
    if (auth && !auth.user) showPublic(auth);
  });

  $('#togglePassword').addEventListener('click', event => {
    const button = event.currentTarget, input = form.elements.password, show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
  });

  window.Auth = {showPublic};
})();
