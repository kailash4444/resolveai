const $ = selector => document.querySelector(selector);
let room, session, poll, busy = false, callStatus = '';
function updateListeningIndicator() {
  const connected = !!session && room?.state === 'connected';
  const microphoneOn = connected && room.localParticipant.isMicrophoneEnabled;
  const assistantSpeaking = connected && [...room.remoteParticipants.values()].some(participant =>
    participant.identity.startsWith('agent:') && participant.isSpeaking);
  const listening = microphoneOn && ['Triage','AI','Connected'].includes(callStatus) && !assistantSpeaking;
  $('.voice-orb').classList.toggle('is-listening', listening);
  const label = $('#listeningStatus');
  label.textContent = !connected ? 'Connecting audio…' : !microphoneOn ? 'Microphone muted' :
    assistantSpeaking ? 'AI speaking…' : listening ? 'Listening…' : 'Waiting for a technician';
  label.hidden = !session;
}
async function request(path, options={}) {
  const response = await fetch(path,{...options,headers:{'Content-Type':'application/json',...(session?{'X-Support-Token':session.access_token}:{}),...options.headers}});
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'The call could not be started. Please try again.');
  return result;
}
async function finish(message='Your call has ended. Thank you for contacting support.', send=true) {
  clearInterval(poll);
  const previous=session; session=null; callStatus=''; updateListeningIndicator();
  const previousRoom=room; room=null;
  if(previousRoom) await previousRoom.disconnect();
  if(send && previous) fetch(`/api/support/calls/${previous.call_id}/end`,{method:'POST',headers:{'X-Support-Token':previous.access_token},keepalive:true}).catch(()=>{});
  $('#activeCall').hidden=true; $('#supportForm').hidden=false; $('#startSupportCall').disabled=false;
  $('#supportMessage').textContent=message; $('#resumeAudioButton').hidden=true;
}
async function refresh() {
  if(!session || busy) return;
  busy=true;
  try {
    const call=await request(`/api/support/calls/${session.call_id}`);
    callStatus=call.status;
    updateListeningIndicator();
    const labels={Triage:['Tell us what happened','Our AI assistant is listening.'],AI:['Speaking with the AI assistant','Describe what you see and follow the suggested steps.'],Queued:['Finding a technician','Please stay on the call while we find someone available.'],Ringing:['Contacting a technician','Your support request is being offered to a technician.'],Connected:[`Connected to ${call.technician_name || 'your technician'}`,'You can now speak with your technician.']};
    if(['Completed','Failed','Callback requested'].includes(call.status)) {
      await finish(call.status==='Callback requested'?'No technician is available at the moment. Please try again later.':call.status==='Failed'?'The call was interrupted. Please start another call.':undefined,false);return;
    }
    const label=labels[call.status] || ['Connecting…','Please stay on the call.'];
    $('#callState').textContent=label[0]; $('#callExplanation').textContent=label[1];
    $('#askTechnician').hidden=!['Triage','AI'].includes(call.status);
    if(call.last_error) $('#supportMessage').textContent=call.last_error;
  } catch(error) { $('#supportMessage').textContent=error.message; }
  finally {busy=false;}
}
$('#supportForm').addEventListener('submit',async event=>{
  event.preventDefault(); $('#startSupportCall').disabled=true; $('#supportMessage').textContent='Connecting your microphone…';
  try {
    await ResolveAIVoice.microphonePermission();
    session=await request('/api/support/calls',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});
    room=await ResolveAIVoice.connect(session,()=>{if(session) finish('The voice connection ended. You can start another call.');});
    callStatus='Triage';
    for (const event of [LivekitClient.RoomEvent.ActiveSpeakersChanged, LivekitClient.RoomEvent.TrackMuted,
      LivekitClient.RoomEvent.TrackUnmuted, LivekitClient.RoomEvent.ConnectionStateChanged]) {
      room.on(event, updateListeningIndicator);
    }
    await ResolveAIVoice.microphonePanel(room);
    updateListeningIndicator();
    $('#supportForm').hidden=true; $('#activeCall').hidden=false; $('#supportMessage').textContent='';
    $('#muteSupportCall').textContent='Mute';
    await refresh(); poll=setInterval(refresh,2000);
  } catch(error) {await finish(error.message);}
});
$('#endSupportCall').addEventListener('click',()=>finish());
$('#muteSupportCall').addEventListener('click',async()=>{
  if(!room) return;
  const enabled=!room.localParticipant.isMicrophoneEnabled;
  try {await room.localParticipant.setMicrophoneEnabled(enabled);$('#muteSupportCall').textContent=enabled?'Mute':'Unmute';updateListeningIndicator();}
  catch(error){$('#supportMessage').textContent=error.message;}
});
$('#askTechnician').addEventListener('click',async()=>{
  if(!session) return;
  $('#askTechnician').disabled=true;
  try{await request(`/api/support/calls/${session.call_id}/technician`,{method:'POST'});await refresh();}
  catch(error){$('#supportMessage').textContent=error.message;}
  finally{$('#askTechnician').disabled=false;}
});
$('#resumeAudioButton').addEventListener('click',async()=>{await room?.startAudio();$('#resumeAudioButton').hidden=true;});
window.addEventListener('pagehide',()=>{if(session) fetch(`/api/support/calls/${session.call_id}/end`,{method:'POST',headers:{'X-Support-Token':session.access_token},keepalive:true}).catch(()=>{});});
request('/api/support/status').then(config=>{if(!config.configured){$('#startSupportCall').disabled=true;$('#supportMessage').textContent='Calling is not connected yet. Please contact your support team.';}}).catch(()=>{$('#supportMessage').textContent='Could not reach the support server.';});

request('/api/auth/status').then(auth=>{if(!auth.user){location.href='/?next=support';return;}$('#customerName').value=auth.user.name;$('#customerName').readOnly=true;}).catch(()=>{});
