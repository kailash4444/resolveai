/* Customer "Get support": choose voice, chat, incident or help articles, then start it. */
(() => {
  const chooser = $('#supportChooser');
  if (!chooser) return;
  const KEY = 'resolveai-active-chat';
  const MODES = {
    talk: {icon: '<path d="M6 3h3l2 5-2 2a15 15 0 0 0 5 5l2-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z"/>', button: 'Start voice call', help: 'Your browser will ask for microphone access when the call starts.'},
    chat: {icon: '<path d="M4 5h16v11H9l-5 4z"/>', button: 'Start chat', help: 'Type with our AI assistant. A technician can join if you need one.'},
    incident: {icon: '<path d="M12 5v14M5 12h14"/>', button: 'Raise an incident', help: 'Opens the incident form, where you can add screenshots.'},
    help: {icon: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5"/>', button: 'Browse help articles', help: 'Opens step-by-step guides for common problems.'},
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
  let voiceConfigured = null, chat = null, poll = null, sending = false, voiceActive = false, renderedTurns = 0, endedByMe = false;

  const mode = () => chooser.elements.supportMode.value;
  function syncButton() {
    const spec = MODES[mode()] || MODES.chat;
    $('#supportStart .btn__label').textContent = spec.button;
    $('#supportStart .btn__bubble svg').innerHTML = spec.icon;
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
  // After a call or chat ends, its incident is written in the background (a few seconds). My support refreshes itself
  // until the new incident shows, so the customer never has to reload the page. It gives up quietly after a minute
  // (a conversation where no issue was described doesn't create an incident).
  let afterSupportTimer = null;
  function refreshAfterSupport() {
    clearInterval(afterSupportTimer);
    const before = typeof customerList !== 'undefined' ? customerList.items.length : 0;
    let tries = 0;
    const tick = async () => {
      tries += 1;
      await Promise.all([window.loadCustomerCalls?.(), window.loadCustomerIncidents?.()]);
      const now = typeof customerList !== 'undefined' ? customerList.items.length : 0;
      if (now > before || tries >= 20) { clearInterval(afterSupportTimer); afterSupportTimer = null; }
    };
    tick();
    afterSupportTimer = setInterval(tick, 3000);
  }
  // When a call or chat ends, Get support says so for a moment and then goes back to its options, ready for the next
  // conversation. The transcript stays available from "Your recent calls and chats" and the incident.
  let backTimer = null;
  function returnToOptions(message, delay) {
    clearTimeout(backTimer);
    backTimer = setTimeout(() => {
      if (voiceActive || (chat && !ENDED.has(chat.status))) return;   // a new conversation already started
      show('chooser'); resetChatPanel();
      const frame = $('#voiceFrame'); frame.removeAttribute('src'); frame.style.height = '';
      if (message) toast(message);
    }, delay);
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.data?.type !== 'resolveai-support-state') return;
    if (event.source !== $('#voiceFrame').contentWindow) return;
    if (voiceActive && ['ended', 'error'].includes(event.data.state)) {
      refreshAfterSupport();
      if (event.data.state === 'ended') returnToOptions('Call ended. Your incident stays on My support.', 6000);
    }
    voiceActive = ['requesting', 'connecting', 'active', 'muted', 'requested', 'connected', 'reconnecting'].includes(event.data.state);
    if (!$('#voicePanel').hidden) show('voice');
  });

  // ---- Chat ----
  const who = turn => turn.speaker === 'Customer' ? 'You' : turn.speaker === 'AI Agent' ? 'ResolveAI assistant' : (chat?.technician_name || 'Technician');
  function resetChatPanel() {
    chat = null; renderedTurns = 0; delete $('#chatLog').dataset.count;
    $('#chatStartForm').hidden = false; $('#chatLog').hidden = true; $('#chatReplyForm').hidden = true;
    $('#chatLog').innerHTML = ''; $('#chatMeta').hidden = true;
    $('#chatBadge').className = 'badge badge--low'; $('#chatBadge').textContent = '○ Not started';
    setFormStatus($('#chatStatus'), '');
  }
  function renderChat() {
    if (!chat) return;
    const [tone, label] = CHAT_STATUS[chat.status] || ['badge--muted', `○ ${chat.status}`];
    $('#chatBadge').className = `badge ${tone}`;
    $('#chatBadge').textContent = chat.status === 'Connected' && chat.technician_name ? `✓ ${chat.technician_name} joined` : label;
    $('#chatMeta').hidden = !chat.ticket_number;
    $('#chatMeta').textContent = chat.ticket_number ? `Incident ${chat.ticket_number} · follow it on My support` : '';
    $('#chatStartForm').hidden = true; $('#chatLog').hidden = false;
    // Newest message at the bottom, like any chat; "…" while the assistant or the technician is typing.
    const typing = chat.agent_typing && !ENDED.has(chat.status) ? (chat.status === 'Connected' ? (chat.technician_name || 'Technician') : 'ResolveAI assistant') : '';
    renderChatWindow($('#chatLog'), chat.transcript, {mine: 'Customer', name: who, typing});
    renderedTurns = chat.transcript.length;
    const ended = ENDED.has(chat.status);
    $('#chatReplyForm').hidden = ended;
    $('#chatAskTechnician').hidden = !['Triage', 'AI'].includes(chat.status);
    if (ended) {
      if (poll) {   // the chat was live in this tab and has just ended
        refreshAfterSupport();
        const note = document.createElement('p');
        note.className = 'chat-note';
        note.textContent = endedByMe ? 'You ended the chat' : chat.status === 'Completed' && chat.technician_name ? `${chat.technician_name} ended the chat` : 'The chat has ended';
        $('#chatLog').append(note); $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
        returnToOptions(chat.ticket_number ? `Chat ended. Incident ${chat.ticket_number} stays on My support.` : 'Chat ended.', endedByMe ? 1500 : 6000);
        endedByMe = false;
      }
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
    }, 1000);
  }
  // The customer's message shows at once; the assistant's typing bubble follows from the server.
  function showPending(text) { showPendingBubble($('#chatLog'), text, 'You'); }
  // Tell the other side the customer is typing (at most every 2.5 seconds).
  let typingSentAt = 0;
  $('#chatMessage').addEventListener('input', () => {
    if (!chat || ENDED.has(chat.status) || Date.now() - typingSentAt < 2500 || !$('#chatMessage').value.trim()) return;
    typingSentAt = Date.now();
    api(`/api/support/chats/${encodeURIComponent(chat.id)}/typing`, {method: 'POST', body: '{}'}).catch(() => {});
  });

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
    showPending(text); field.value = '';
    typingSentAt = 0;
    try { chat = await api(`/api/support/chats/${encodeURIComponent(chat.id)}/messages`, {method: 'POST', body: JSON.stringify({text})}); field.value = ''; setFormStatus($('#chatStatus'), ''); renderChat(); }
    catch (error) { $('#chatLog').querySelectorAll('[data-pending]').forEach(item => item.remove()); field.value = text; setFormStatus($('#chatStatus'), `✕ Not sent: ${error.message}`, true); }
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
    if (!chat) return;   // nothing to end (no chat started in this tab)
    endedByMe = true;
    try { chat = await api(`/api/support/chats/${encodeURIComponent(chat.id)}/end`, {method: 'POST', body: '{}'}); renderChat(); refreshAfterSupport(); }
    catch (error) { setFormStatus($('#chatStatus'), `✕ ${error.message}`, true); }
  });

  // Called when My support opens: check voice availability and resume a chat left open in this tab.
  window.SupportHub = {
    async open() {
      await checkVoice();
      let id = null; try { id = sessionStorage.getItem(KEY); } catch (_) {}
      if (id && !chat) {
        try { chat = await api(`/api/support/chats/${encodeURIComponent(id)}`); renderedTurns = 0; $('#chatLog').innerHTML = ''; delete $('#chatLog').dataset.count; renderChat(); if (!ENDED.has(chat.status)) startPolling(); return; }
        catch (_) { try { sessionStorage.removeItem(KEY); } catch (__) {} }
      }
      // A finished chat or call isn't shown again: My support opens on the options, ready for a new request.
      if (chat && ENDED.has(chat.status)) resetChatPanel();
      if (!voiceActive && !$('#voicePanel').hidden) $('#voiceFrame').removeAttribute('src');
      if (!(chat && !ENDED.has(chat.status)) && !voiceActive) show('chooser');
    },
  };
  syncButton();
})();
