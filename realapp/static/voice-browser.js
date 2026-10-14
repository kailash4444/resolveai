// Shared LiveKit audio client. Project secrets never enter the browser.
window.ResolveAIVoice = {
  async microphonePermission() {
    const stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    stream.getTracks().forEach(track => track.stop());
  },
  monitorMicrophone(room) {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    context.resume().catch(() => {});
    const analyser = context.createAnalyser(); analyser.fftSize = 1024;
    const samples = new Float32Array(analyser.fftSize);
    let source, currentTrack, lastSpeech = Date.now();
    room.microphoneSignal = {state:'connecting', level:0};
    const timer = setInterval(() => {
      const publication = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
      const track = publication?.track?.mediaStreamTrack;
      if (track !== currentTrack) {
        source?.disconnect(); currentTrack = track; lastSpeech = Date.now();
        if (track && track.readyState === 'live') {
          source = context.createMediaStreamSource(new MediaStream([track])); source.connect(analyser);
        }
      }
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length);
      if (rms > .0027) lastSpeech = Date.now();
      const state = !track || track.readyState !== 'live' ? 'stopped' :
        publication.isMuted ? 'muted' : track.muted ? 'interrupted' :
        context.state !== 'running' ? 'paused' : rms > .0027 ? 'speech' :
        Date.now()-lastSpeech > 10000 ? 'quiet' : 'listening';
      room.microphoneSignal = {state,level:Math.min(1,rms*12)};
      const panel = document.querySelector('[data-microphone-panel]');
      if(panel && !panel.hidden) {
        panel.querySelector('meter').value = room.microphoneSignal.level;
        panel.querySelector('[data-mic-status]').textContent = {
          stopped:'Microphone stopped. Restart it below.', muted:'Microphone muted',
          interrupted:'Microphone interrupted. Restart it below.', paused:'Microphone monitor paused. Restart it below.',
          speech:'Speech detected', listening:'Listening — speak to test your microphone',
          quiet:'No speech detected. Check your microphone or select another input.'
        }[state];
      }
    }, 200);
    room.resumeMicrophoneMonitor = () => context.resume();
    room.once(LivekitClient.RoomEvent.Disconnected,()=>{clearInterval(timer);source?.disconnect();context.close().catch(()=>{});const panel=document.querySelector('[data-microphone-panel]');if(panel)panel.hidden=true;});
  },
  async microphonePanel(room) {
    const panel = document.querySelector('[data-microphone-panel]');
    if(!panel)return;
    panel.hidden=false;
    panel.innerHTML='<strong>Your microphone</strong><p data-mic-status>Connecting microphone…</p><meter min="0" max="1" value="0" aria-label="Microphone input level"></meter><label>Microphone<select aria-label="Microphone input"></select></label><button type="button" class="secondary" data-restart-microphone>Restart microphone</button><p data-mic-error role="status"></p>';
    const select=panel.querySelector('select'), button=panel.querySelector('button'), error=panel.querySelector('[data-mic-error]');
    async function inputs(){
      const devices=await navigator.mediaDevices.enumerateDevices();
      select.replaceChildren();
      for(const device of devices.filter(d=>d.kind==='audioinput')) {
        const option=document.createElement('option');option.value=device.deviceId;option.textContent=device.label || 'Microphone';select.append(option);
      }
      const track=room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone)?.track;
      const id=track?.mediaStreamTrack?.getSettings().deviceId;
      if(id)select.value=id;
    }
    select.onchange=async()=>{
      error.textContent='';
      try {await room.switchActiveDevice('audioinput',select.value);await room.resumeMicrophoneMonitor();}
      catch(_){error.textContent='Could not use this input. Check microphone permissions or choose another device.';}
    };
    button.onclick=async()=>{
      button.disabled=true;error.textContent='';
      try {
        const publication=room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
        if(publication?.track)await room.localParticipant.unpublishTrack(publication.track,true);
        await room.localParticipant.setMicrophoneEnabled(true,{deviceId:select.value || undefined});
        await room.resumeMicrophoneMonitor();await inputs();
      } catch(_){error.textContent='Could not restart the microphone. Allow microphone access in your browser and try again.';}
      finally{button.disabled=false;}
    };
    try{await inputs();}catch(_){error.textContent='Microphone device list is unavailable.';}
  },
  async connect(connection, onDisconnected, publish = true) {
    if (!window.LivekitClient?.Room) throw new Error('The calling library could not load. Refresh the page.');
    const room = new LivekitClient.Room({
      // Wait for the server's RTC settings before creating the peer connections.
      // Embedded browsers can reject the single-connection fast join's setConfiguration().
      singlePeerConnection: false,
      audioCaptureDefaults:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},
    });
    const elements = new Set();
    const captions = document.createElement('section');
    captions.className = 'live-captions'; captions.setAttribute('aria-label', 'Live captions');
    captions.hidden = true;
    const captionHost = document.querySelector('[data-live-caption-host]') || document.querySelector('[data-microphone-panel]');
    captionHost?.append(captions);
    const captionRows = new Map();
    room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant, kind, topic) => {
      if (topic !== 'resolveai.caption' || participant?.identity !== `agent:${connection.room.replace('resolveai-', '').toUpperCase()}`) return;
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (!['Customer','Technician'].includes(data.speaker) || typeof data.text !== 'string' || typeof data.segment !== 'string') return;
        captions.hidden = false;
        let row = captionRows.get(data.segment);
        if (!row) { row = document.createElement('p'); captions.append(row); captionRows.set(data.segment, row); }
        row.textContent = `${data.speaker}: ${data.text.slice(0, 4000)}${data.final ? '' : ' …'}`;
        row.className = data.final ? 'small' : 'small sec';
        while (captionRows.size > 4) { const key = captionRows.keys().next().value; captionRows.get(key).remove(); captionRows.delete(key); }
      } catch (_) {}
    });
    room.on(LivekitClient.RoomEvent.TrackSubscribed, track => {
      if (track.kind !== LivekitClient.Track.Kind.Audio) return;
      const element = track.attach(); element.autoplay = true;
      document.getElementById('remoteAudio').appendChild(element); elements.add(element);
      element.play().catch(() => { document.getElementById('resumeAudioButton').hidden = false; });
    });
    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, track => track.detach().forEach(element => {elements.delete(element);element.remove();}));
    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      elements.forEach(element => element.remove()); elements.clear(); captions.remove(); onDisconnected?.();
    });
    try {
      await room.startAudio();
      await room.connect(connection.url, connection.token);
      if (publish) await room.localParticipant.setMicrophoneEnabled(true);
      ResolveAIVoice.monitorMicrophone(room);
      return room;
    } catch(error) { await room.disconnect(); throw error; }
  },
};
