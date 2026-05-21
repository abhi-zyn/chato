// WebRTC calling
const WebRTCCall = (() => {
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let currentCall = null;
  let signalChannel = null;

  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  async function startCall(friendId, video = false) {
    try {
      currentCall = { friendId, video, initiator: true, startTime: Date.now() };
      
      localStream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: video ? { width: 1280, height: 720 } : false 
      });
      
      pc = new RTCPeerConnection(config);
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      
      remoteStream = new MediaStream();
      pc.ontrack = e => e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
      
      pc.onicecandidate = e => {
        if (e.candidate) sendSignal({ type: 'ice', candidate: e.candidate });
      };
      
      setupSignaling(friendId);
      
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', offer, video });
      
      showCallUI('outgoing');
      return true;
    } catch (e) {
      console.error('startCall failed:', e);
      endCall();
      return false;
    }
  }

  async function answerCall() {
    try {
      if (!currentCall || currentCall.initiator) return;
      
      localStream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: currentCall.video 
      });
      
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', answer });
      
      showCallUI('active');
    } catch (e) {
      console.error('answerCall failed:', e);
      endCall();
    }
  }

  function declineCall() {
    if (currentCall && !currentCall.initiator) {
      sendSignal({ type: 'decline' });
    }
    endCall();
  }

  function endCall() {
    if (currentCall) sendSignal({ type: 'end' });
    
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (pc) pc.close();
    if (signalChannel) signalChannel.unsubscribe();
    
    pc = null;
    localStream = null;
    remoteStream = null;
    currentCall = null;
    signalChannel = null;
    
    hideCallUI();
  }

  function setupSignaling(friendId) {
    const channelName = [window.me.id, friendId].sort().join('_');
    signalChannel = window.sb.channel(`call:${channelName}`)
      .on('broadcast', { event: 'signal' }, async ({ payload }) => {
        if (payload.from === window.me.id) return;
        await handleSignal(payload);
      })
      .subscribe();
  }

  async function handleSignal(signal) {
    try {
      if (signal.type === 'offer') {
        if (currentCall) return; // Already in a call
        
        currentCall = { 
          friendId: signal.from, 
          video: signal.video, 
          initiator: false,
          startTime: Date.now()
        };
        
        pc = new RTCPeerConnection(config);
        remoteStream = new MediaStream();
        
        pc.ontrack = e => e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
        pc.onicecandidate = e => {
          if (e.candidate) sendSignal({ type: 'ice', candidate: e.candidate });
        };
        
        await pc.setRemoteDescription(signal.offer);
        setupSignaling(signal.from);
        showCallUI('incoming');
        
      } else if (signal.type === 'answer') {
        if (!pc) return;
        await pc.setRemoteDescription(signal.answer);
        showCallUI('active');
        
      } else if (signal.type === 'ice') {
        if (pc && signal.candidate) await pc.addIceCandidate(signal.candidate);
        
      } else if (signal.type === 'decline' || signal.type === 'end') {
        endCall();
      }
    } catch (e) {
      console.error('handleSignal failed:', e);
    }
  }

  function sendSignal(data) {
    if (!signalChannel) return;
    signalChannel.send({
      type: 'broadcast',
      event: 'signal',
      payload: { ...data, from: window.me.id }
    });
  }

  function toggleMute() {
    if (!localStream) return;
    const audio = localStream.getAudioTracks()[0];
    if (audio) audio.enabled = !audio.enabled;
    return audio?.enabled;
  }

  function toggleVideo() {
    if (!localStream) return;
    const video = localStream.getVideoTracks()[0];
    if (video) video.enabled = !video.enabled;
    return video?.enabled;
  }

  function showCallUI(state) {
    // state: 'outgoing' | 'incoming' | 'active'
    const ui = document.getElementById('callUI');
    const status = document.getElementById('callStatus');
    const controls = document.getElementById('callControls');
    const incomingBtns = document.getElementById('incomingCallBtns');
    const localVideo = document.getElementById('localVideo');
    const remoteVideo = document.getElementById('remoteVideo');
    
    ui.classList.add('active');
    
    if (state === 'outgoing') {
      status.textContent = 'Calling...';
      controls.style.display = 'none';
      incomingBtns.style.display = 'none';
    } else if (state === 'incoming') {
      status.textContent = currentCall.video ? 'Incoming video call' : 'Incoming voice call';
      controls.style.display = 'none';
      incomingBtns.style.display = 'flex';
    } else if (state === 'active') {
      status.textContent = '00:00';
      controls.style.display = 'flex';
      incomingBtns.style.display = 'none';
      
      if (localStream) localVideo.srcObject = localStream;
      if (remoteStream) remoteVideo.srcObject = remoteStream;
      
      if (currentCall.video) {
        localVideo.style.display = 'block';
        remoteVideo.style.display = 'block';
      }
      
      startCallTimer();
    }
  }

  function hideCallUI() {
    const ui = document.getElementById('callUI');
    ui.classList.remove('active');
    document.getElementById('localVideo').srcObject = null;
    document.getElementById('remoteVideo').srcObject = null;
  }

  function startCallTimer() {
    const status = document.getElementById('callStatus');
    const interval = setInterval(() => {
      if (!currentCall) {
        clearInterval(interval);
        return;
      }
      const elapsed = Math.floor((Date.now() - currentCall.startTime) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toString().padStart(2, '0');
      status.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  return {
    startCall,
    answerCall,
    declineCall,
    endCall,
    toggleMute,
    toggleVideo,
    isInCall: () => !!currentCall
  };
})();

window.WebRTCCall = WebRTCCall;
