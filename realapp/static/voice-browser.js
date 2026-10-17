// Shared LiveKit audio client. Project secrets never enter the browser.
window.ResolveAIVoice = {
  async microphonePermission() {
    const stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    stream.getTracks().forEach(track => track.stop());
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
    room.on(LivekitClient.RoomEvent.TrackSubscribed, track => {
      if (track.kind !== LivekitClient.Track.Kind.Audio) return;
      const element = track.attach(); element.autoplay = true;
      document.getElementById('remoteAudio').appendChild(element); elements.add(element);
      element.play().catch(() => { document.getElementById('resumeAudioButton').hidden = false; });
    });
    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, track => track.detach().forEach(element => {elements.delete(element);element.remove();}));
    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      elements.forEach(element => element.remove()); elements.clear(); onDisconnected?.();
    });
    try {
      await room.startAudio();
      await room.connect(connection.url, connection.token);
      if (publish) await room.localParticipant.setMicrophoneEnabled(true);
      return room;
    } catch(error) { await room.disconnect(); throw error; }
  },
};
