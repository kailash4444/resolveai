(() => {
  const form = document.querySelector('#customerIncidentForm');
  if (!form) return;
  const input = form.querySelector('[name="attachments"]');
  const selection = document.querySelector('#attachmentSelection');
  const errors = document.querySelector('#customerAttachmentErrors');
  const progress = document.querySelector('#customerAttachmentProgress');
  const retry = document.querySelector('#customerIncidentRetry');
  const message = document.querySelector('#customerIncidentMessage');
  const submit = form.querySelector('[type="submit"]');
  const allowed = new Set(['image/png','image/jpeg','image/webp','image/gif','image/heic']);
  const limit = 20 * 1024 * 1024;
  let files = [], previews = [], uploading = false;
  const humanSize = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const showErrors = list => { errors.hidden = !list.length; errors.textContent = list.join(' '); };
  function renderFiles() {
    previews.forEach(URL.revokeObjectURL); previews = [];
    selection.replaceChildren();
    if (!files.length) { selection.textContent = ''; return; }
    const list = document.createElement('ul'); list.className = 'selected-media-list';
    files.forEach((file, index) => {
      const row = document.createElement('li'); row.className = 'selected-media-item';
      const image = document.createElement('img'); image.alt = ''; image.src = URL.createObjectURL(file); previews.push(image.src);
      const detail = document.createElement('span'); detail.textContent = `${file.name} · ${humanSize(file.size)}`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.addEventListener('click', () => { files.splice(index, 1); renderFiles(); showErrors([]); });
      row.append(image, detail, remove); list.append(row);
    });
    selection.append(list);
  }
  function addFiles(incoming) {
    const next = [...files, ...incoming]; const issues = [];
    if (next.length > 3) issues.push('Choose up to 3 images.');
    if (next.some(file => !allowed.has(file.type) && !/\.(png|jpe?g|webp|gif|heic)$/i.test(file.name))) issues.push('Only PNG, JPEG, WebP, GIF, or HEIC images are supported.');
    if (next.some(file => file.size <= 0)) issues.push('One selected image is empty. Choose another file.');
    if (next.reduce((sum, file) => sum + file.size, 0) > limit) issues.push('Selected images must total 20 MB or less. Remove a file or choose smaller images.');
    showErrors(issues);
    if (!issues.length) { files = next; renderFiles(); }
    input.value = '';
  }
  input.addEventListener('change', () => addFiles([...input.files]));
  const drop = input.closest('[data-drop-zone]');
  drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('is-dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-dragging'));
  drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('is-dragging'); addFiles([...event.dataTransfer.files]); });
  retry.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', event => {
    event.preventDefault(); event.stopImmediatePropagation();
    if (uploading || errors.textContent.trim()) return;
    uploading = true; submit.disabled = true; retry.hidden = true;
    message.textContent = 'Creating your incident…'; progress.hidden = false;
    const bar = progress.querySelector('progress'), label = progress.querySelector('span'); bar.value = 0;
    const body = new FormData(form); body.delete('attachments'); files.forEach(file => body.append('attachments', file, file.name));
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/customer/incidents'); xhr.responseType = 'json';
    xhr.upload.onprogress = event => { if (event.lengthComputable) { bar.value = Math.round(event.loaded / event.total * 100); label.textContent = `Uploading incident and ${files.length} ${files.length === 1 ? 'image' : 'images'} · ${bar.value}%`; } };
    xhr.onload = async () => {
      uploading = false; submit.disabled = false;
      if (xhr.status < 200 || xhr.status >= 300 || !xhr.response) { progress.hidden = true; message.textContent = xhr.response?.detail || 'We could not create this incident. Your details and selected images are still here; please try again.'; retry.hidden = false; retry.focus(); return; }
      const count = files.length; files = []; renderFiles(); form.reset(); progress.hidden = true;
      message.textContent = `Incident created. ${count ? `${count} ${count === 1 ? 'image is' : 'images are'} attached. AI visual analysis may be unavailable; attached images remain on the incident.` : 'You can follow updates in Incident progress.'}`;
      try { await window.openTicketDetails(xhr.response.id); }
      catch { message.textContent += ' Open Incident progress to view its details.'; }
    };
    xhr.onerror = () => { uploading = false; submit.disabled = false; progress.hidden = true; message.textContent = 'Network connection lost. Your details and selected images are still here; please try again.'; retry.hidden = false; retry.focus(); };
    xhr.send(body);
  }, true);

  const list = document.querySelector('#customerIncidents');
  if (list) new MutationObserver(() => list.querySelectorAll('.incident-stepper').forEach(stepper => {
    if (stepper.dataset.compact === 'true') return;
    const items = [...stepper.querySelectorAll('li')];
    const assigned = items[1]?.classList.contains('complete') || items[1]?.classList.contains('current');
    const resolved = items[3]?.classList.contains('current') || items[3]?.classList.contains('complete');
    const stages = [{label:'Received',done:true},{label:'With technician',done:!!assigned && !resolved},{label:'Resolved',done:resolved}];
    stepper.setAttribute('aria-label','Incident progress'); stepper.replaceChildren(); stepper.dataset.compact = 'true';
    stages.forEach((stage, index) => { const li = document.createElement('li'); li.className = stage.done ? 'complete' : index === 1 && assigned ? 'current' : ''; const icon = document.createElement('span'); icon.textContent = stage.done ? '✓' : '○'; const label = document.createElement('small'); label.textContent = stage.label; li.append(icon,label); stepper.append(li); });
  })).observe(list, {childList:true, subtree:true});
})();
