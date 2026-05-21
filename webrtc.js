// WebRTC calling — uses Supabase signaling table for offer/answer/ICE exchange
// Spec: signaling table with room_id, sender_id, type, payload
window.WebRTCCall = (function () {
  // Each tab gets its own sender_id so we can ignore our own broadcasts
  const SENDER_ID = (crypto.randomUUID && crypto.randomUUID()) ||
    ('sid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));

  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let currentCall = null;       // { roomId, friendId, video, initiator, startTime }
  let signalChannel = null;
  let pendingIce = [];          // ICE candidates received before remote description set

  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // -------- Signaling helpers --------
  async function sendSignal(roomId, type, payload) {
    if (!window.sb) return;
    try {
      await window.sb.from('signaling').insert({
        room_id: roomId,
        sender_id: SENDER_ID,
        type,
        payload: payload || {}
      });
    } catch (e) {
      console.error('[sendSignal]', e);
    }
  }

  function listenSignals(roomId, callback) {
    if (signalChannel) {
      try { window.sb.removeChannel(signalChannel); } catch (_) {}
    }
    signalChannel = window.sb
      .channel('signaling:' + roomId)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'signaling',
          filter: 'room_id=eq.' + roomId
        },
        (payload) => {
          const row = payload && payload.new;
          if (!row) return;
          if (row.sender_id === SENDER_ID) return; // skip own
          callback(row);
        }
      )
      .subscribe();
    return signalChannel;
  }

  // -------- Media --------
  async function getMedia(video) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video ? { width: 1280, height: 720 } : false
      });
    } catch (e) {
      const status = document.getElementById('callStatus');
      if (status) {
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
          status.textContent = 'Camera/mic permission denied';
        } else if (e.name === 'NotFoundError') {
          status.textContent = 'No camera/mic found';
        } else {
          status.textContent = 'Media error: ' + (e.message || e.name);
        }
      }
      throw e;
    }
  }

  // -------- Peer connection --------
  function createPeerConnection(roomId) {
    const conn = new RTCPeerConnection(config);

    remoteStream = new MediaStream();
    conn.ontrack = (e) => {
      e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
      const remoteVideo = document.getElementById('remoteVideo');
      if (remoteVideo) {
        remoteVideo.srcObject = remoteStream;
        remoteVideo.style.display = 'block';
      }
    };

    conn.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal(roomId, 'ice-candidate', { candidate: e.candidate });
      }
    };

    conn.onconnectionstatechange = () => {
      console.log('[pc] state:', conn.connectionState);
      if (conn.connectionState === 'connected') {
        showCallUI('active');
      } else if (conn.connectionState === 'failed' ||
                 conn.connectionState === 'disconnected' ||
                 conn.connectionState === 'closed') {
        // Other side dropped — auto end
        if (currentCall) endCall();
      }
    };

    return conn;
  }

  // -------- Public API --------
  // Start a call to a friend (creates the room, sends offer)
  async function startCall(friendId, video = false) {
    try {
      const myId = window.me && window.me.id;
      if (!myId) {
        alert('You must be signed in to start a call.');
        return false;
      }
      if (!friendId) {
        alert('Cannot start call: friend ID missing.');
        return false;
      }
      
      // Deterministic room ID from sorted user IDs so both sides agree
      const roomId = 'call:' + [myId, friendId].sort().join('_');
      currentCall = { roomId, friendId, video, initiator: true, startTime: Date.now() };

      // Show outgoing UI immediately so user knows something happened
      showCallUI('outgoing');

      // Request media permissions
      try {
        localStream = await getMedia(video);
      } catch (e) {
        // getMedia already showed a status message
        setTimeout(() => endCall(), 2000);
        return false;
      }
      
      const localVideo = document.getElementById('localVideo');
      if (localVideo) {
        localVideo.srcObject = localStream;
        if (video) localVideo.style.display = 'block';
      }

      pc = createPeerConnection(roomId);
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

      // Listen for signals before sending offer
      listenSignals(roomId, handleSignal);

      // Check if there's already an offer for this room (we're the second peer)
      let existing = null;
      try {
        const res = await window.sb
          .from('signaling')
          .select('*')
          .eq('room_id', roomId)
          .eq('type', 'offer')
          .order('created_at', { ascending: false })
          .limit(1);
        existing = res.data;
        if (res.error) {
          // Likely the migration hasn't been run yet
          const status = document.getElementById('callStatus');
          if (status) status.textContent = 'Signaling not configured. Run migrations/009_signaling.sql in Supabase.';
          console.error('[startCall] signaling query failed:', res.error);
          setTimeout(() => endCall(), 4000);
          return false;
        }
      } catch (e) {
        const status = document.getElementById('callStatus');
        if (status) status.textContent = 'Cannot reach signaling server.';
        console.error('[startCall]', e);
        setTimeout(() => endCall(), 3000);
        return false;
      }

      if (existing && existing.length && existing[0].sender_id !== SENDER_ID) {
        // Second peer flow — answer the existing offer
        const offerRow = existing[0];
        await pc.setRemoteDescription(offerRow.payload.offer);
        await flushPendingIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal(roomId, 'answer', { answer });
        showCallUI('active');
      } else {
        // First peer flow — create offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal(roomId, 'offer', { offer, video });
        // UI already showing outgoing
      }
      return true;
    } catch (e) {
      console.error('[startCall]', e);
      const status = document.getElementById('callStatus');
      if (status) status.textContent = 'Call failed: ' + (e.message || e.name || 'unknown');
      setTimeout(() => endCall(), 2000);
      return false;
    }
  }

  async function answerCall() {
    // For incoming-call UI flow (friend started the call, we got an offer)
    if (!currentCall || currentCall.initiator) return;
    try {
      // localStream + pc already set up in handleSignal('offer')
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(currentCall.roomId, 'answer', { answer });
      showCallUI('active');
    } catch (e) {
      console.error('[answerCall]', e);
      endCall();
    }
  }

  function declineCall() {
    if (currentCall && !currentCall.initiator) {
      sendSignal(currentCall.roomId, 'bye', { reason: 'declined' });
    }
    endCall();
  }

  async function endCall() {
    const wasInCall = !!currentCall;
    const roomId = currentCall && currentCall.roomId;

    if (wasInCall && roomId) {
      sendSignal(roomId, 'bye', {}).catch(() => {});
    }

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
    }
    if (pc) {
      try { pc.close(); } catch (_) {}
    }
    if (signalChannel) {
      try { window.sb.removeChannel(signalChannel); } catch (_) {}
    }

    pc = null;
    localStream = null;
    remoteStream = null;
    currentCall = null;
    signalChannel = null;
    pendingIce = [];

    // Clean up signaling rows for this room
    if (roomId) {
      window.sb.from('signaling').delete().eq('room_id', roomId).then(() => {}).catch(() => {});
    }

    hideCallUI();
  }

  async function flushPendingIce() {
    while (pendingIce.length && pc && pc.remoteDescription) {
      const c = pendingIce.shift();
      try { await pc.addIceCandidate(c); } catch (e) { console.error('[ice flush]', e); }
    }
  }

  // -------- Signal router --------
  async function handleSignal(row) {
    const type = row.type;
    const payload = row.payload || {};

    try {
      if (type === 'offer') {
        // Inbound call from another peer
        if (currentCall && currentCall.initiator) return; // we're the offerer
        if (currentCall) return; // already in a call

        const myId = window.me && window.me.id;
        // Extract friend id from room_id ("call:<a>_<b>")
        const parts = row.room_id.replace(/^call:/, '').split('_');
        const friendId = parts.find(p => p !== myId) || parts[0];

        currentCall = {
          roomId: row.room_id,
          friendId,
          video: !!payload.video,
          initiator: false,
          startTime: Date.now()
        };

        // Set up PC + media now (auto-answer mode — request mic/cam permission)
        localStream = await getMedia(payload.video);
        const localVideo = document.getElementById('localVideo');
        if (localVideo) {
          localVideo.srcObject = localStream;
          if (payload.video) localVideo.style.display = 'block';
        }

        pc = createPeerConnection(row.room_id);
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

        await pc.setRemoteDescription(payload.offer);
        await flushPendingIce();

        showCallUI('incoming');
      } else if (type === 'answer') {
        if (!pc || !pc.localDescription) return;
        await pc.setRemoteDescription(payload.answer);
        await flushPendingIce();
      } else if (type === 'ice-candidate') {
        if (!pc) return;
        if (pc.remoteDescription) {
          await pc.addIceCandidate(payload.candidate);
        } else {
          pendingIce.push(payload.candidate);
        }
      } else if (type === 'bye') {
        endCall();
      }
    } catch (e) {
      console.error('[handleSignal]', type, e);
    }
  }

  // -------- Mute/Video toggles --------
  function toggleMute() {
    if (!localStream) return null;
    const audio = localStream.getAudioTracks()[0];
    if (audio) audio.enabled = !audio.enabled;
    return audio ? audio.enabled : null;
  }

  function toggleVideo() {
    if (!localStream) return null;
    const video = localStream.getVideoTracks()[0];
    if (video) video.enabled = !video.enabled;
    return video ? video.enabled : null;
  }

  // -------- UI helpers --------
  function showCallUI(state) {
    const ui = document.getElementById('callUI');
    if (!ui) return;
    ui.classList.add('active');

    const status = document.getElementById('callStatus');
    const controls = document.getElementById('callControls');
    const incomingBtns = document.getElementById('incomingCallBtns');
    const localVideo = document.getElementById('localVideo');
    const remoteVideo = document.getElementById('remoteVideo');

    if (state === 'outgoing') {
      if (status) status.textContent = 'Calling...';
      if (controls) controls.style.display = 'flex';
      if (incomingBtns) incomingBtns.style.display = 'none';
    } else if (state === 'incoming') {
      if (status) status.textContent = currentCall && currentCall.video
        ? 'Incoming video call' : 'Incoming voice call';
      if (controls) controls.style.display = 'none';
      if (incomingBtns) incomingBtns.style.display = 'flex';
    } else if (state === 'active') {
      if (status) status.textContent = 'Connected';
      if (controls) controls.style.display = 'flex';
      if (incomingBtns) incomingBtns.style.display = 'none';
      if (localVideo && localStream) localVideo.srcObject = localStream;
      if (remoteVideo && remoteStream) remoteVideo.srcObject = remoteStream;
      if (currentCall && currentCall.video) {
        if (localVideo) localVideo.style.display = 'block';
        if (remoteVideo) remoteVideo.style.display = 'block';
      }
      startCallTimer();
    }
  }

  function hideCallUI() {
    const ui = document.getElementById('callUI');
    if (!ui) return;
    ui.classList.remove('active');
    const lv = document.getElementById('localVideo');
    const rv = document.getElementById('remoteVideo');
    if (lv) { lv.srcObject = null; lv.style.display = 'none'; }
    if (rv) { rv.srcObject = null; rv.style.display = 'none'; }
  }

  function startCallTimer() {
    const status = document.getElementById('callStatus');
    if (!status) return;
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

  // -------- Auto-listen for inbound calls (so users get notified before they tap anything) --------
  // Keep a per-user channel that listens for ANY signaling row addressed to them.
  // The room_id format includes both user IDs, so we filter rows that include our user id.
  let inboundListener = null;
  function startInboundListener() {
    stopInboundListener();
    if (!window.sb || !window.me || !window.me.id) return;
    const myId = window.me.id;
    inboundListener = window.sb
      .channel('inbound:' + myId)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'signaling' },
        (payload) => {
          const row = payload && payload.new;
          if (!row) return;
          if (row.sender_id === SENDER_ID) return;
          // Only handle offers addressed to me
          if (row.type !== 'offer') return;
          if (currentCall) return; // already in a call
          if (!row.room_id || !row.room_id.startsWith('call:')) return;
          if (!row.room_id.includes(myId)) return;

          // Set up signal listener for this room and process the offer
          listenSignals(row.room_id, handleSignal);
          handleSignal(row);
        }
      )
      .subscribe();
  }
  function stopInboundListener() {
    if (inboundListener) {
      try { window.sb.removeChannel(inboundListener); } catch (_) {}
      inboundListener = null;
    }
  }

  return {
    startCall,
    answerCall,
    declineCall,
    endCall,
    toggleMute,
    toggleVideo,
    isInCall: () => !!currentCall,
    startInboundListener,
    stopInboundListener,
    SENDER_ID
  };
})();
