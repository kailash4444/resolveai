/* Attachment uploader for .drop + .files. Mirrors the server contract: images only, 3 files, 20 MB total. */
window.ResolveUploader = (() => {
  const MAX_FILES = 3, MAX_BYTES = 20 * 1024 * 1024;
  const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic']);
  const EXT = /\.(png|jpe?g|webp|gif|heic)$/i;
  const size = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const STATUS = {
    ready: ['badge--muted', '○ Ready to upload'],
    uploading: ['badge--medium', '● Uploading'],
    attached: ['badge--ok', '✓ Attached'],
    failed: ['badge--err', '✕ Not uploaded'],
  };

  function create({drop, list, errors, onChange = () => {}}) {
    const input = drop.querySelector('input[type=file]');
    let items = [], previews = [];

    function validate() {
      let total = 0;
      items.forEach((item, index) => {
        const file = item.file;
        item.error = '';
        if (!TYPES.has(file.type) && !EXT.test(file.name)) item.error = 'Not a supported image';
        else if (!file.size) item.error = 'File is empty';
        else if (index >= MAX_FILES) item.error = `Over the ${MAX_FILES}-image limit`;
        else if ((total += file.size) > MAX_BYTES) item.error = 'Over 20 MB total';
      });
      const bad = items.filter(item => item.error).length;
      errors.textContent = bad ? `✕ ${bad === 1 ? 'One file can’t' : `${bad} files can’t`} be uploaded. Remove the ${bad === 1 ? 'file' : 'files'} marked ✕ to continue.` : '';
      errors.hidden = !bad;
      input.setAttribute('aria-invalid', String(!!bad));
    }

    function render() {
      previews.forEach(URL.revokeObjectURL); previews = [];
      list.replaceChildren(...items.map((item, index) => {
        const row = document.createElement('li'); row.className = 'file';
        const media = document.createElement('span'); media.className = 'file__main';
        if (!item.error && item.file.type.startsWith('image/') && item.file.type !== 'image/heic') {
          const img = document.createElement('img'); img.className = 'file__thumb'; img.alt = '';
          img.src = URL.createObjectURL(item.file); previews.push(img.src); media.append(img);
        }
        const name = document.createElement('span'); name.className = 'file__name';
        name.textContent = `${item.file.name} · ${size(item.file.size)}`; media.append(name);
        const [tone, label] = item.error ? ['badge--err', `✕ ${item.error}`] : STATUS[item.status] || STATUS.ready;
        const badge = document.createElement('span'); badge.className = `badge ${tone}`; badge.textContent = item.detail || label;
        row.append(media, badge);
        if (!['uploading', 'attached'].includes(item.status)) {
          const remove = document.createElement('button');
          remove.type = 'button'; remove.className = 'icon-btn'; remove.title = 'Remove';
          remove.innerHTML = '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
          remove.setAttribute('aria-label', `Remove ${item.file.name}`);
          remove.addEventListener('click', () => {
            items.splice(index, 1); validate(); render(); onChange();
            (list.querySelectorAll('button')[index] || list.querySelector('button:last-of-type') || input).focus();
          });
          row.append(remove);
        }
        return row;
      }));
      list.hidden = !items.length;
    }

    function add(files) {
      items = [...items, ...[...files].map(file => ({file, status: 'ready'}))];
      validate(); render(); onChange(); input.value = '';
    }

    input.addEventListener('change', () => add(input.files));
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.dataset.dragging = ''; });
    drop.addEventListener('dragleave', () => delete drop.dataset.dragging);
    drop.addEventListener('drop', event => { event.preventDefault(); delete drop.dataset.dragging; add(event.dataTransfer.files); });

    return {
      files: () => items.filter(item => !item.error).map(item => item.file),
      count: () => items.length,
      hasErrors: () => items.some(item => item.error),
      setStatus(status, detail = '') { items.forEach(item => { if (!item.error) { item.status = status; item.detail = detail; } }); render(); },
      clear() { items = []; validate(); render(); onChange(); },
    };
  }
  return {create, MAX_FILES, MAX_BYTES, size};
})();

/* Customer "Report an issue": validation, upload progress, and honest result states. */
(() => {
  const form = document.getElementById('customerIncidentForm');
  if (!form) return;
  const $id = id => document.getElementById(id);
  const uploader = ResolveUploader.create({drop: $id('customerDrop'), list: $id('attachmentSelection'), errors: $id('customerAttachmentErrors')});
  const submit = $id('customerIncidentSubmit'), message = $id('customerIncidentMessage'), progress = $id('customerAttachmentProgress');
  const RULES = {
    short_description: field => field.value.trim().length < 3 ? 'Enter at least 3 characters.' : '',
    description: field => field.value.trim().length < 10 ? 'Describe the problem in at least 10 characters.' : '',
    service: field => field.value.trim().length < 2 ? 'Enter a service, or leave it as General.' : '',
  };
  let uploading = false;

  function fieldError(name) {
    const field = form.elements[name], error = $id(`${field.id}Error`), text = RULES[name](field);
    error.textContent = text ? `✕ ${text}` : ''; error.hidden = !text;
    field.setAttribute('aria-invalid', String(!!text));
    return !text;
  }
  Object.keys(RULES).forEach(name => form.elements[name].addEventListener('blur', () => { if (form.elements[name].getAttribute('aria-invalid') === 'true' || form.elements[name].value) fieldError(name); }));
  const counter = $id('shortDescriptionCount');
  form.elements.short_description.addEventListener('input', event => { counter.textContent = `${event.target.value.length} / 200`; });
  form.addEventListener('input', () => { window.ResolveDirty?.mark('customer-create', true); });

  function setMessage(kind, html) {
    message.className = kind === 'error' ? 'alert' : 'alert alert--info';
    message.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    message.innerHTML = html; message.hidden = !html;
  }

  $id('customerIncidentRetry').addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (uploading) return;
    const valid = Object.keys(RULES).map(fieldError).every(Boolean);
    if (!valid || uploader.hasErrors()) {
      setMessage('error', `<strong>✕ Check the form.</strong><span class="sec">${!valid ? 'Fix the fields marked ✕.' : 'Remove the files marked ✕.'}</span>`);
      (form.querySelector('[aria-invalid="true"]') || $id('customerDrop').querySelector('input')).focus();
      return;
    }
    uploading = true; submit.disabled = true; submit.setAttribute('aria-busy', 'true'); submit.textContent = 'Submitting…';
    $id('customerIncidentRetry').hidden = true;
    const files = uploader.files();
    const body = new FormData();
    ['short_description', 'description', 'service'].forEach(name => body.append(name, form.elements[name].value.trim()));
    files.forEach(file => body.append('attachments', file, file.name));
    setMessage('info', `<strong>● Creating your incident.</strong><span class="sec">${files.length ? 'Uploading your images first.' : 'This usually takes a few seconds.'}</span>`);
    const bar = progress.querySelector('progress'), label = progress.querySelector('span');
    progress.hidden = !files.length; bar.value = 0; label.textContent = 'Uploading 0%';
    if (files.length) uploader.setStatus('uploading');
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/customer/incidents'); xhr.responseType = 'json';
    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      bar.value = Math.round(event.loaded / event.total * 100);
      label.textContent = bar.value < 100 ? `Uploading ${bar.value}%` : 'Upload complete. Creating the incident and checking your images…';
    };
    const done = () => { uploading = false; submit.disabled = false; submit.removeAttribute('aria-busy'); submit.innerHTML = 'Submit incident <span aria-hidden="true">→</span>'; progress.hidden = true; };
    xhr.onload = () => {
      done();
      if (xhr.status === 401) { window.Shell?.sessionExpired(); }
      if (xhr.status < 200 || xhr.status >= 300 || !xhr.response) {
        uploader.setStatus('ready');
        const detail = typeof xhr.response?.detail === 'string' ? xhr.response.detail : 'The server didn’t accept the request.';
        setMessage('error', `<strong>✕ Your incident wasn’t created.</strong><span class="sec">${esc(detail)} Your details and images are still here.</span>`);
        $id('customerIncidentRetry').hidden = false; $id('customerIncidentRetry').focus();
        return;
      }
      const item = xhr.response;
      window.ResolveDirty?.mark('customer-create', false);
      form.reset(); counter.textContent = '0 / 200'; uploader.clear(); setMessage('', '');
      window.showCustomerCreateResult(item, files.length);
    };
    xhr.onerror = () => {
      done(); uploader.setStatus('ready');
      setMessage('error', '<strong>✕ Connection lost.</strong><span class="sec">Your incident wasn’t created. Your details and images are still here; try again when you’re back online.</span>');
      $id('customerIncidentRetry').hidden = false; $id('customerIncidentRetry').focus();
    };
    xhr.send(body);
  });
})();
