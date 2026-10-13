/* Public entry: landing, sign-in, sign-up information and first-administrator setup.
   Destinations after sign-in are carried in the URL (?next=support) and only known values are honoured. */
(() => {
  const NEXT = {support: '/support'};
  const form = $('#authForm'), submit = $('#authSubmit'), error = $('#authError');
  let auth = null;

  const params = () => new URLSearchParams(location.search);
  const nextParam = () => (NEXT[params().get('next')] ? params().get('next') : null);
  const selectedRole = () => form.elements.expected_role.value || 'technician';

  function setRole(role) {
    const value = role === 'customer' ? 'customer' : 'technician';
    form.elements.expected_role.value = value;
    $('#adminSignInHint').hidden = params().get('role') !== 'admin';
  }

  function setMode(mode) {
    const setup = mode === 'setup', signup = mode === 'signup';
    $('#authCard').dataset.mode = mode;
    $('#authKicker').textContent = setup ? 'First-time setup' : signup ? 'Accounts' : 'Sign in';
    $('#authTitle').textContent = setup ? 'Create the administrator account' : signup ? 'Accounts are created by your administrator' : 'Welcome back';
    $('#authDescription').textContent = setup
      ? 'No accounts exist yet. The first account becomes the workspace administrator, who then adds technicians and customers.'
      : signup ? 'Self-service sign-up isn’t available. Ask your ResolveAI administrator to create your account and share your username, then sign in here.'
        : 'Sign in with the username and password from your administrator.';
    form.hidden = signup;
    $('#authSignupNotice').hidden = !signup;
    $('#authRoleField').hidden = setup;
    $('#setupNameField').hidden = !setup;
    form.elements.name.required = setup;
    $('#setupTokenField').hidden = !setup || !auth?.setup_token_required;
    form.elements.setup_token.required = setup && !!auth?.setup_token_required;
    form.elements.password.minLength = setup ? 12 : 1;
    form.elements.password.autocomplete = setup ? 'new-password' : 'current-password';
    $('#passwordHelp').hidden = !setup;
    $('#authHelp').hidden = setup || signup;
    submit.innerHTML = setup ? 'Create administrator account' : 'Sign in <span aria-hidden="true">→</span>';
    clearError();
  }

  function clearError() {
    error.hidden = true; error.textContent = '';
    $('#authSwitchRole').hidden = true;
    form.querySelectorAll('.input').forEach(input => input.removeAttribute('aria-invalid'));
  }

  function showError(message, fields = ['username', 'password']) {
    error.textContent = `✕ ${message}`; error.hidden = false;
    fields.forEach(name => form.elements[name]?.setAttribute('aria-invalid', 'true'));
    // A role mismatch is recoverable in one step: offer the other workspace explicitly.
    const other = /Choose Technician/i.test(message) ? 'technician' : /Choose Customer/i.test(message) ? 'customer' : null;
    $('#authSwitchRole').hidden = !other;
    if (other) { $('#authSwitchRole').dataset.role = other; $('#authSwitchRole').textContent = `Sign in as ${other === 'customer' ? 'Customer' : 'Technician'} instead`; }
  }

  // Called by loadApplication when nobody is signed in.
  async function showPublic(status) {
    auth = status;
    const path = location.pathname;
    $('#roleSignInChoices').hidden = !!auth.setup_required;
    $('#firstAdminSetup').hidden = !auth.setup_required;
    const wantsAuth = ['/login', '/signup'].includes(path) || !!nextParam() || ['/portal', '/console', '/admin'].includes(path);
    $('#landing').hidden = wantsAuth;
    $('#authPage').hidden = !wantsAuth;
    if (!wantsAuth) return;
    // Keep ?next and ?role in the address bar so a refresh or back-navigation still knows where to go.
    const query = new URLSearchParams();
    if (nextParam()) query.set('next', nextParam());
    const role = params().get('role') || (path === '/portal' ? 'customer' : null);
    if (role) query.set('role', role);
    const target = path === '/signup' && !auth.setup_required ? '/signup' : '/login';
    history.replaceState(null, '', `${target}${query.toString() ? `?${query}` : ''}`);
    setRole(role);
    setMode(auth.setup_required ? 'setup' : target === '/signup' ? 'signup' : 'signin');
    $('#authNextNotice').hidden = !nextParam();
    document.title = auth.setup_required ? 'Set up ResolveAI' : target === '/signup' ? 'Get an account · ResolveAI' : 'Sign in · ResolveAI';
    (auth.setup_required ? form.elements.name : target === '/signup' ? $('#authTitle') : form.elements.username).focus({preventScroll: true});
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearError();
    if (!form.checkValidity()) {
      const invalid = [...form.elements].filter(el => el.willValidate && !el.validity.valid);
      showError(invalid[0]?.name === 'password' && auth?.setup_required ? 'Use a password of at least 12 characters.' : 'Fill in the highlighted fields.', invalid.map(el => el.name));
      invalid[0]?.focus();
      return;
    }
    const values = Object.fromEntries(new FormData(form));
    const setup = !!auth?.setup_required;
    const body = setup ? {name: values.name, username: values.username, password: values.password, setup_token: values.setup_token || ''}
      : {username: values.username, password: values.password, expected_role: selectedRole()};
    submit.disabled = true; submit.setAttribute('aria-busy', 'true');
    const label = submit.innerHTML; submit.textContent = setup ? 'Creating account…' : 'Signing in…';
    try {
      const user = await api(setup ? '/api/auth/setup' : '/api/auth/login', {method: 'POST', body: JSON.stringify(body)});
      const next = nextParam();
      if (next) { location.assign(NEXT[next]); return; }
      history.replaceState(null, '', window.Shell.home(user.role));
      $('#authPage').hidden = true; $('#landing').hidden = false;
      form.reset();
      await window.loadApplication();
    } catch (err) {
      showError(err.message, setup && /token/i.test(err.message) ? ['setup_token'] : ['username', 'password']);
      (/token/i.test(err.message) ? form.elements.setup_token : form.elements.username).focus();
    } finally {
      submit.disabled = false; submit.removeAttribute('aria-busy'); if (submit.textContent.endsWith('…')) submit.innerHTML = label;
    }
  });

  $('#authSwitchRole').addEventListener('click', event => { setRole(event.currentTarget.dataset.role); form.requestSubmit(); });
  form.addEventListener('change', event => { if (event.target.name === 'expected_role') clearError(); });
  $('#togglePassword').addEventListener('click', event => {
    const button = event.currentTarget, input = form.elements.password, show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
    button.setAttribute('aria-pressed', String(show));
  });

  window.Auth = {showPublic};
})();
