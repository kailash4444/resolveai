/* Customer "Get support": choose voice, chat, incident or help articles, then start it. */
(() => {
  const chooser = $('#supportChooser');
  if (!chooser) return;
  const KEY = 'resolveai-active-chat';
  const MODES = {
    talk: {button: 'Start voice call', help: 'Your browser will ask for microphone access when the call starts.'},
    chat: {button: 'Start chat', help: 'Type with our AI assistant. A technician can join if you need one.'},
    incident: {button: 'Raise an incident', help: 'Opens the incident form, where you can add screenshots.'},
    help: {button: 'Browse help articles', help: 'Opens step-by-step guides for common problems.'},
  };
  const CHAT_STATUS = {
    Triage: ['badge--medium', '● Reading your message'],
    AI: ['badge--medium', '● Chatting with the AI assistant'],
    Queued: ['badge--high', '◆ Waiting for a technician'],
    Ringing: ['badge--high', '◆ Connecting you to a technician'],
    Connected: ['badge--ok', '✓ Technician joined'],
    Completed: ['badge--ok', '✓ Chat ended'],
    'Callback requested': ['badge--high', '◆ No technician free right now'],
    Failed: ['badge--err', '✕ Chat interrupted'],
  };
  const ENDED = new Set(['Completed', 'Callback requested', 'Failed']);
  let voiceConfigured = null, chat = null, poll = null, sending = false, voiceActive = false, renderedTurns = 0;

  const mode = () => chooser.elements.supportMode.value;
  function syncButton() {
    const spec = MODES[mode()] || MODES.chat;
    $('#supportStart').textContent = spec.button;
    $('#supportStartHelp').textContent = spec.help;
  }
  chooser.addEventListener('change', syncButton);

  function show(panel) {
    chooser.hidden = panel !== 'chooser';
    $('#voicePanel').hidden = panel !== 'voice';
    $('#chatPanel').hidden = panel !== 'chat';
    $('#supportBack').hidden = panel === 'chooser' || (panel === 'voice' && voiceActive) || (panel === 'chat' && chat && !ENDED.has(chat.status));
  }

  // Voice is only offered when the server has browser calling configured.
  async function checkVoice() {
    if (voiceConfigured !== null) return;
    try { voiceConfigured = !!(await api('/api/support/status')).configured; } catch (_) { voiceConfigured = false; }
    const talk = chooser.querySelector('input[value="talk"]');
    talk.disabled = !voiceConfigured;
    talk.closest('.choice').toggleAttribute('data-disabled', !voiceConfigured);
    $('#mode-talk-help').textContent = voiceConfigured ? 'Voice call in your browser. AI first; ask for a technician any time.' : 'Not available yet: your support team hasn’t set up browser calling.';
    if (!voiceConfigured && mode() === 'talk') chooser.querySelector('input[value="chat"]').checked = true;
    syncButton();
  }

  chooser.addEventListener('submit', event => {
    event.preventDefault();
    const choice = mode();
    if (choice === 'talk') startVoice();
    else if (choice === 'chat') { show('chat'); resetChatPanel(); $('#chatFirstMessage').focus(); }
    else if (choice === 'incident') $('#appNav a[data-view="customer-create"], #topNav a[data-view="customer-create"]')?.click();
    else if (choice === 'help') $('#topNav a[data-view="knowledge"], #appNav a[data-view="knowledge"]')?.click();
  });
  $('#supportBack').addEventListener('click', () => { show('chooser'); stopPolling(); chooser.querySelector('input:checked')?.focus(); });

  // ---- Voice: the embedded call page starts immediately, which triggers the microphone prompt. ----
  function startVoice() {
    voiceActive = true;
    const frame = $('#voiceFrame');
    frame.src = `${frame.dataset.src}&autostart=1&t=${Date.now()}`;
    show('voice');
    frame.focus();
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.data?.type !== 'resolveai-support-state') return;
    if (event.source !== $('#voiceFrame').contentWindow) return;
    voiceActive = ['requesting', 'connecting', 'active', 'muted', 'requested', 'connected', 'reconnecting'].includes(event.data.state);
    if (!$('#voicePanel').hidden) show('voice');
  });

  // ---- Chat ----
  const who = turn => turn.speaker === 'Customer' ? 'You' : turn.speaker === 'AI Agent' ? 'ResolveAI assistant' : (chat?.technician_name || 'Technician');
  function resetChatPanel() {
    chat = null; renderedTurns = 0;
    $('#chatStartForm').hidden = false; $('#chatLog').hidden = true; $('#chatReplyForm').hidden = true;
    $('#chatLog').innerHTML = ''; $('#chatMeta').hidden = true;
    $('#chatBadge').className = 'badge badge--low'; $('#chatBadge').textContent = '○ Not started';
    setFormStatus($('#chatStatus'), '');
  }
  function renderChat() {
    if (!chat) return;
    const [tone, label] = CHAT_STATUS[chat.status] || ['badge--low', `○ ${chat.status}`];
    $('#chatBadge').className = `badge ${tone}`;
    $('#chatBadge').textContent = chat.status === 'Connected' && chat.technician_name ? `✓ ${chat.technician_name} joined` : label;
    $('#chatMeta').hidden = !chat.ticket_number;
    $('#chatMeta').textContent = chat.ticket_number ? `Incident ${chat.ticket_number} · follow it on My support` : '';
    $('#chatStartForm').hidden = true; $('#chatLog').hidden = false;
    const log = $('#chatLog'), atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    // Append only new turns so screen readers announce just the new message.
    chat.transcript.slice(renderedTurns).forEach(turn => {
      const item = document.createElement('div');
      item.className = `turn${turn.speaker === 'Customer' ? ' turn--you' : ''}`;
      item.innerHTML = `<span class="turn__who">${esc(who(turn))}${turn.timestamp ? `<time>${esc(new Date(turn.timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}))}</time>` : ''}</span><p>${esc(turn.text)}</p>`;
      log.append(item);
    });
    renderedTurns = chat.transcript.length;
    if (atEnd) log.scrollTop = log.scrollHeight;
    const ended = ENDED.has(chat.status);
    $('#chatReplyForm').hidden = ended;
    $('#chatAskTechnician').hidden = !['Triage', 'AI'].includes(chat.status);
    if (ended) {
      stopPolling();
      try { sessionStorage.removeItem(KEY); } catch (_) {}
      setFormStatus($('#chatStatus'), chat.status === 'Callback requested' ? 'Nobody could join in time. Your incident is open and the team will follow up there.' : chat.status === 'Failed' ? 'The chat was interrupted. Your incident is still open.' : 'Chat ended. Your incident stays on My support.');
    }
    show('chat');
  }
  function stopPolling() { clearInterval(poll); poll = null; }
  function startPolling() {
    stopPolling();
    poll = setInterval(async () => {
      if (!chat || sending || $('#chatPanel').hidden) return;
      try { chat = await api(`/api/support/chats/${encodeURIComponent(chat.id)}`); renderChat(); }
      catch (error) { if (error.status === 404) { stopPolling(); resetChatPanel(); } }
    }, 3000);
  }

  $('#chatStartForm').addEventListener('submit', async event => {
    event.preventDefault();
    const field = $('#chatFirstMessage'), text = field.value.trim();
    if (text.length < 10) { setFormStatus($('#chatStatus'), '✕ Describe the problem in at least 10 characters.', true); field.setAttribute('aria-invalid', 'true'); field.focus(); return; }
    field.removeAttribute('aria-invalid');
    const button = $('#chatStartButton'); button.disabled = true; button.setAttribute('aria-busy', 'true');
    setFormStatus($('#chatStatus'), '● Starting the chat…');
    try {
      chat = await api('/api/support/chats', {method: 'POST', body: JSON.stringify({description: text})});
      try { sessionStorage.setItem(KEY, chat.id); } catch (_) {}
      field.value = ''; setFormStatus($('#chatStatus'), '');
      renderChat(); startPolling(); $('#chatMessage').focus();
      window.loadCustomerIncidents?.();
    } catch (error) { setFormStatus($('#chatStatus'), `✕ Chat didn’t start: ${error.message}`, true); }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  });

  $('#chatReplyForm').addEventListener('submit', async event => {
    event.preventDefault();
    const field = $('#chatMessage'), text = field.value.trim();
    if (!text || !chat) return;
    sending = true; $('#chatSend').disabled = true; $('#chatSend').setAttribute('aria-busy', 'true');
    try { chat = await api(`/api/support/chats/${encodeURIComponent(chat.id)}/messages`, {method: 'POST', body: JSON.stringify({text})}); field.value = ''; setFormStatus($('#chatStatus'), ''); renderChat(); }
    catch (error) { setFormStatus($('#chatStatus'), `✕ Not sent: ${error.message}`, true); }
    finally { sending = false; $('#chatSend').disabled = false; $('#chatSend').removeAttribute('aria-busy'); field.focus(); }
  });
  $('#chatMessage').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#chatReplyForm').requestSubmit(); } });

  $('#chatAskTechnician').addEventListener('click', async () => {
    const button = $('#chatAskTechnician'); button.disabled = true;
    try { chat = await api(`/api/support/chats/${encodeURIComponent(chat.id)}/technician`, {method: 'POST', body: '{}'}); renderChat(); setFormStatus($('#chatStatus'), '◆ A technician has been asked to join. Keep this chat open.'); }
    catch (error) { setFormStatus($('#chatStatus'), `✕ ${error.message}`, true); }
    finally { button.disabled = false; }
  });
  $('#chatEnd').addEventListener('click', () => $('#endChatDialog').showModal());
  $('#confirmEndChat').addEventListener('click', async () => {
    $('#endChatDialog').close();
    try { chat = await api(`/api/support/chats/${encodeURIComponent(chat.id)}/end`, {method: 'POST', body: '{}'}); renderChat(); window.loadCustomerCalls?.(); }
    catch (error) { setFormStatus($('#chatStatus'), `✕ ${error.message}`, true); }
  });

  // Called when My support opens: check voice availability and resume a chat left open in this tab.
  window.SupportHub = {
    async open() {
      await checkVoice();
      let id = null; try { id = sessionStorage.getItem(KEY); } catch (_) {}
      if (id && !chat) {
        try { chat = await api(`/api/support/chats/${encodeURIComponent(id)}`); renderedTurns = 0; $('#chatLog').innerHTML = ''; renderChat(); if (!ENDED.has(chat.status)) startPolling(); return; }
        catch (_) { try { sessionStorage.removeItem(KEY); } catch (__) {} }
      }
      if (!chat && !voiceActive) show('chooser');
    },
  };
  syncButton();
})();
