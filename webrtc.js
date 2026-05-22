// WebRTC calling — uses Supabase signaling table for offer/answer/ICE exchange
// Spec: signaling table with room_id, sender_id, type, payload
//
// v7 — professional UI: caller info, ringtones, speaker toggle, deferred-media on answer
window.WebRTCCall = (function () {
  // Each tab gets its own sender_id so we can ignore our own broadcasts
  const SENDER_ID = (crypto.randomUUID && crypto.randomUUID()) ||
    ('sid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));

  let pc = null;
  let localStream = null;
  let remoteStream = null;
  // currentCall: { roomId, friendId, video, initiator, startTime, friend, _pendingOffer, _timer, _ringtone }
  let currentCall = null;
  let signalChannel = null;
  let pendingIce = []; // ICE candidates received before remote description set
  let controlsHideTimer = null;

  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // ============================================================
  // Ringtone (WebAudio — no audio file needed)
  // ============================================================
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtx = new Ctx();
      } catch (_) {}
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }
  function makeRingtone(kind) {
    // kind: 'incoming' = classic 2-tone phone ring (480 + 620 Hz)
    //       'outgoing' = ringback (440 + 480 Hz, US standard)
    const ctx = getAudioCtx();
    if (!ctx) return { stop: () => {} };

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    const freqs = kind === 'incoming' ? [480, 620] : [440, 480];
    const oscs = freqs.map(f => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(master);
      o.start();
      return o;
    });

    // Cadence: incoming 2s on / 4s off; outgoing 1s on / 3s off
    const onMs  = kind === 'incoming' ? 2000 : 1000;
    const offMs = kind === 'incoming' ? 4000 : 3000;
    const peakGain = kind === 'incoming' ? 0.20 : 0.12;

    let stopped = false;
    function pulse() {
      if (stopped) return;
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(peakGain, now + 0.05);
      master.gain.setValueAtTime(peakGain, now + onMs / 1000 - 0.05);
      master.gain.exponentialRampToValueAtTime(0.0001, now + onMs / 1000);
      setTimeout(pulse, onMs + offMs);
    }
    pulse();

    return {
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          const now = ctx.currentTime;
          master.gain.cancelScheduledValues(now);
          master.gain.setValueAtTime(master.gain.value, now);
          master.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
          oscs.forEach(o => { try { o.stop(now + 0.1); } catch (_) {} });
          setTimeout(() => { try { master.disconnect(); } catch (_) {} }, 200);
        } catch (_) {}
      }
    };
  }
  function startRingtone(kind) {
    stopRingtone();
    if (!currentCall) return;
    currentCall._ringtone = makeRingtone(kind);
  }
  function stopRingtone() {
    if (currentCall && currentCall._ringtone) {
      try { currentCall._ringtone.stop(); } catch (_) {}
      currentCall._ringtone = null;
    }
  }

  // ============================================================
  // Signaling helpers
  // ============================================================
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

  // ============================================================
  // Media
  // ============================================================
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

  // ============================================================
  // Peer connection
  // ============================================================
  function createPeerConnection(roomId) {
    const conn = new RTCPeerConnection(config);

    remoteStream = new MediaStream();
    conn.ontrack = (e) => {
      e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
      const remoteVideo = document.getElementById('remoteVideo');
      if (remoteVideo) {
        remoteVideo.srcObject = remoteStream;
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
        if (currentCall) currentCall._answered = true;
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

  // ============================================================
  // Friend profile lookup (best-effort)
  // ============================================================
  async function fetchFriendProfile(friendId) {
    if (!friendId) return null;
    if (window.PopChatsDB && PopChatsDB.getProfile) {
      try { return await PopChatsDB.getProfile(friendId); } catch (_) {}
    }
    if (window.sb) {
      try {
        const { data } = await window.sb.from('profiles').select('*').eq('id', friendId).maybeSingle();
        return data || null;
      } catch (_) {}
    }
    return null;
  }
  function avatarUrl(p) {
    if (!p) return 'https://api.dicebear.com/7.x/initials/svg?seed=?';
    return p.avatar_url ||
      ('https://api.dicebear.com/7.x/initials/svg?seed=' +
        encodeURIComponent(p.display_name || p.username || p.full_name || '?'));
  }
  function displayName(p) {
    if (!p) return 'Unknown';
    return p.full_name || p.display_name || p.username || 'Unknown';
  }
  function applyFriendToUI(p) {
    const av = document.getElementById('callAvatar');
    const nm = document.getElementById('callName');
    const hd = document.getElementById('callHandle');
    const bg = document.getElementById('callBg');
    const url = avatarUrl(p);
    if (av) av.src = url;
    if (bg) bg.style.backgroundImage = "url('" + url.replace(/'/g, "\\'") + "')";
    if (nm) nm.textContent = displayName(p);
    if (hd) hd.textContent = p && p.username ? '@' + p.username : '';
  }

  // ============================================================
  // Public API
  // ============================================================
  function getMyUserId() {
    if (window.me && window.me.id) return window.me.id;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('sb-') && k.includes('auth-token')) {
          const raw = localStorage.getItem(k);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          const session = parsed.access_token ? parsed : (parsed.currentSession || null);
          if (session && session.user && session.user.id) return session.user.id;
        }
      }
    } catch (_) {}
    return null;
  }

  // Start a call — friendOrId may be a friend object (preferred, for instant UI) or just an id
  async function startCall(friendOrId, video = false) {
    console.log('[startCall] called, friendOrId:', friendOrId, 'video:', video);
    _callLogged = false;
    try {
      const friend = (friendOrId && typeof friendOrId === 'object') ? friendOrId : null;
      const friendId = friend ? friend.id : friendOrId;

      const myId = getMyUserId();
      if (!myId)    { alert('You must be signed in to start a call.'); return false; }
      if (!friendId){ alert('Cannot start call: friend ID missing.'); return false; }

      // Deterministic room ID (both peers compute the same)
      const roomId = 'call:' + [myId, friendId].sort().join('_');
      currentCall = {
        roomId, friendId, video, initiator: true,
        startTime: Date.now(),
        friend: friend || null
      };

      // Apply friend info immediately, hydrate from DB if we only had an id
      applyFriendToUI(friend);
      showCallUI('outgoing');
      if (!friend) {
        fetchFriendProfile(friendId).then(p => {
          if (currentCall && currentCall.friendId === friendId) {
            currentCall.friend = p;
            applyFriendToUI(p);
          }
        });
      }

      // Clean stale signaling rows
      try { await window.sb.from('signaling').delete().eq('room_id', roomId); }
      catch (e) { console.warn('[startCall] cleanup failed', e); }

      // Request media (caller asks immediately — they initiated)
      try {
        localStream = await getMedia(video);
      } catch (e) {
        setTimeout(() => endCall(), 1500);
        return false;
      }

      const localVideo = document.getElementById('localVideo');
      if (localVideo) localVideo.srcObject = localStream;

      pc = createPeerConnection(roomId);
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

      // Listen for inbound signals before sending offer
      listenSignals(roomId, handleSignal);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal(roomId, 'offer', { offer, video });

      // Ringback tone for caller until remote answers
      startRingtone('outgoing');
      return true;
    } catch (e) {
      console.error('[startCall]', e);
      const status = document.getElementById('callStatus');
      if (status) status.textContent = 'Call failed: ' + (e.message || e.name || 'unknown');
      setTimeout(() => endCall(), 1500);
      return false;
    }
  }

  // Receiver accepts: now we request media + create PC + send answer
  async function answerCall() {
    if (!currentCall || currentCall.initiator) return;
    if (!currentCall._pendingOffer) return;
    stopRingtone();

    try {
      const status = document.getElementById('callStatus');
      if (status) status.textContent = 'Connecting…';

      localStream = await getMedia(currentCall.video);
      const localVideo = document.getElementById('localVideo');
      if (localVideo) localVideo.srcObject = localStream;

      pc = createPeerConnection(currentCall.roomId);
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

      await pc.setRemoteDescription(currentCall._pendingOffer);
      await flushPendingIce();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(currentCall.roomId, 'answer', { answer });

      currentCall._pendingOffer = null;
      // Stay in 'incoming' visually until pc.connectionState === 'connected'
    } catch (e) {
      console.error('[answerCall]', e);
      endCall();
    }
  }

  function declineCall() {
    if (currentCall && !currentCall.initiator) {
      currentCall._declined = true;
      sendSignal(currentCall.roomId, 'bye', { reason: 'declined' });
    }
    endCall();
  }

  let _callLogged = false;

  async function endCall() {
    console.log('[endCall] called, currentCall:', !!currentCall);
    const wasInCall = !!currentCall;
    const roomId = currentCall && currentCall.roomId;
    const callMeta = currentCall ? {
      initiator: currentCall.initiator,
      friendId: currentCall.friendId,
      answered: !!currentCall._answered,
      video: !!currentCall.video
    } : null;
    const shouldLog = wasInCall && callMeta && callMeta.friendId && callMeta.initiator && !_callLogged;
    if (shouldLog) _callLogged = true;

    stopRingtone();
    if (currentCall && currentCall._timer) {
      clearInterval(currentCall._timer);
      currentCall._timer = null;
    }
    if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }

    if (wasInCall && roomId) {
      sendSignal(roomId, 'bye', {}).catch(() => {});
    }

    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (pc) { try { pc.close(); } catch (_) {} }
    if (signalChannel) { try { window.sb.removeChannel(signalChannel); } catch (_) {} }

    pc = null;
    localStream = null;
    remoteStream = null;
    currentCall = null;
    signalChannel = null;
    pendingIce = [];

    if (roomId) {
      window.sb.from('signaling').delete().eq('room_id', roomId).then(() => {}).catch(() => {});
    }

    // Log call to database (only initiator logs, only once)
    if (shouldLog) {
      const myId = getMyUserId();
      if (myId) {
        const kind = callMeta.answered ? 'voice' : 'missed';
        window.sb.from('calls').insert([{
          caller_id: myId,
          callee_id: callMeta.friendId,
          kind
        }]).then(({ error }) => {
          if (error) console.error('[call log] insert failed:', error.message);
        }).catch(e => console.error('[call log]', e));
      }
    }

    hideCallUI();
  }

  async function flushPendingIce() {
    while (pendingIce.length && pc && pc.remoteDescription) {
      const c = pendingIce.shift();
      try { await pc.addIceCandidate(c); } catch (e) { console.error('[ice flush]', e); }
    }
  }

  // ============================================================
  // Signal router
  // ============================================================
  async function handleSignal(row) {
    const type = row.type;
    const payload = row.payload || {};

    try {
      if (type === 'offer') {
        if (currentCall && currentCall.initiator) return; // we're the offerer
        if (currentCall) return; // already in a call

        const myId = getMyUserId();
        const parts = row.room_id.replace(/^call:/, '').split('_');
        const friendId = parts.find(p => p !== myId) || parts[0];

        currentCall = {
          roomId: row.room_id,
          friendId,
          video: !!payload.video,
          initiator: false,
          startTime: Date.now(),
          friend: null,
          _pendingOffer: payload.offer
        };

        // Hydrate friend info & ring; do NOT request media until user accepts
        const profile = await fetchFriendProfile(friendId);
        if (currentCall) currentCall.friend = profile;
        applyFriendToUI(profile);

        showCallUI('incoming');
        startRingtone('incoming');
      } else if (type === 'answer') {
        if (!pc || !pc.localDescription) return;
        stopRingtone();
        await pc.setRemoteDescription(payload.answer);
        await flushPendingIce();
        showCallUI('active');
      } else if (type === 'ice-candidate') {
        if (!pc) {
          pendingIce.push(payload.candidate);
          return;
        }
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

  // ============================================================
  // Mute / Video / Speaker toggles
  // ============================================================
  function toggleMute() {
    if (!localStream) return null;
    const audio = localStream.getAudioTracks()[0];
    if (audio) audio.enabled = !audio.enabled;
    return audio ? audio.enabled : null;
  }

  function toggleVideo() {
    if (!localStream) return null;
    const video = localStream.getVideoTracks()[0];
    if (video) {
      video.enabled = !video.enabled;
      if (currentCall) {
        currentCall.video = video.enabled;
        const overlay = document.getElementById('callUI');
        if (overlay) overlay.dataset.video = video.enabled ? 'true' : 'false';
      }
      return video.enabled;
    }
    // No video track — can't enable from voice-call mid-flight (requires renegotiation).
    return null;
  }

  // Toggle speakerphone-style audio output (best effort — uses setSinkId where supported)
  async function toggleSpeaker(forceState) {
    const remoteVideo = document.getElementById('remoteVideo');
    if (!remoteVideo || typeof remoteVideo.setSinkId !== 'function') {
      // Not supported — fall back to volume boost on remote element
      const next = forceState != null ? forceState : !(remoteVideo && remoteVideo.dataset.speaker === 'true');
      if (remoteVideo) {
        remoteVideo.dataset.speaker = next ? 'true' : 'false';
        remoteVideo.volume = next ? 1.0 : 0.7;
      }
      return next;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === 'audiooutput');
      const isSpeaker = remoteVideo.dataset.speaker === 'true';
      const wantSpeaker = forceState != null ? forceState : !isSpeaker;

      // Default device = earpiece on phones, speaker on desktops; pick alternate when toggling
      let target = outputs.find(o => /speaker|headphone|external/i.test(o.label));
      if (!target) target = outputs[0];
      const earpiece = outputs.find(o => /earpiece|receiver/i.test(o.label)) || outputs[0];

      await remoteVideo.setSinkId(wantSpeaker ? (target ? target.deviceId : 'default') : (earpiece ? earpiece.deviceId : 'default'));
      remoteVideo.dataset.speaker = wantSpeaker ? 'true' : 'false';
      return wantSpeaker;
    } catch (e) {
      console.warn('[toggleSpeaker]', e);
      return null;
    }
  }

  // ============================================================
  // UI helpers
  // ============================================================
  function showCallUI(state) {
    const ui = document.getElementById('callUI');
    if (!ui) return;
    ui.classList.add('active');
    ui.classList.remove('controls-hidden');
    ui.dataset.state = state;
    ui.dataset.video = currentCall && currentCall.video ? 'true' : 'false';

    const status = document.getElementById('callStatus');
    const callType = document.getElementById('callType');

    if (callType) {
      callType.textContent = currentCall && currentCall.video ? 'Video call' : 'Voice call';
    }

    if (state === 'outgoing') {
      if (status) status.textContent = 'Calling…';
    } else if (state === 'incoming') {
      if (status) status.textContent = currentCall && currentCall.video
        ? 'Incoming video call' : 'Incoming voice call';
    } else if (state === 'active') {
      if (status) status.textContent = 'Connected';
      const localVideo = document.getElementById('localVideo');
      const remoteVideo = document.getElementById('remoteVideo');
      if (localVideo && localStream) localVideo.srcObject = localStream;
      if (remoteVideo && remoteStream) remoteVideo.srcObject = remoteStream;
      startCallTimer();
      // Auto-hide controls after 4s in video mode (tap to show again)
      if (currentCall && currentCall.video) scheduleControlsHide();
    }
  }

  function hideCallUI() {
    const ui = document.getElementById('callUI');
    if (!ui) return;
    ui.classList.remove('active', 'controls-hidden');
    ui.dataset.state = 'idle';
    ui.dataset.video = 'false';
    const lv = document.getElementById('localVideo');
    const rv = document.getElementById('remoteVideo');
    if (lv) { lv.srcObject = null; }
    if (rv) { rv.srcObject = null; }
    // Reset toggle button states
    const muteBtn = document.getElementById('muteBtn');
    const speakerBtn = document.getElementById('speakerBtn');
    const videoBtn = document.getElementById('videoBtn');
    if (muteBtn) {
      muteBtn.dataset.on = 'false';
      const lbl = muteBtn.querySelector('.call-btn-label');
      if (lbl) lbl.textContent = 'Mute';
    }
    if (speakerBtn) speakerBtn.dataset.on = 'false';
    if (videoBtn) videoBtn.dataset.on = 'false';
  }

  function startCallTimer() {
    if (!currentCall) return;
    if (currentCall._timer) return; // already running
    currentCall.startTime = Date.now();
    const status = document.getElementById('callStatus');
    if (!status) return;
    currentCall._timer = setInterval(() => {
      if (!currentCall) return;
      const elapsed = Math.floor((Date.now() - currentCall.startTime) / 1000);
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const s = elapsed % 60;
      const pad = (n) => String(n).padStart(2, '0');
      status.textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }, 1000);
  }

  function scheduleControlsHide() {
    if (controlsHideTimer) clearTimeout(controlsHideTimer);
    controlsHideTimer = setTimeout(() => {
      const ui = document.getElementById('callUI');
      if (ui && ui.dataset.state === 'active' && ui.dataset.video === 'true') {
        ui.classList.add('controls-hidden');
      }
    }, 4000);
  }
  function showControlsTemporarily() {
    const ui = document.getElementById('callUI');
    if (!ui) return;
    ui.classList.remove('controls-hidden');
    if (ui.dataset.state === 'active' && ui.dataset.video === 'true') scheduleControlsHide();
  }
  // Wire tap-to-show once
  document.addEventListener('click', (e) => {
    const ui = document.getElementById('callUI');
    if (!ui || !ui.classList.contains('active')) return;
    if (ui.dataset.state !== 'active' || ui.dataset.video !== 'true') return;
    // Ignore clicks on controls themselves
    if (e.target.closest('.call-btn, .call-incoming-btn, .call-controls, .call-incoming-actions, .call-topbar')) return;
    showControlsTemporarily();
  }, true);

  // ============================================================
  // Inbound listener (per-user) — fires before user opens any chat
  // ============================================================
  let inboundListener = null;
  function startInboundListener() {
    stopInboundListener();
    if (!window.sb) return;
    const myId = getMyUserId();
    if (!myId) return;
    inboundListener = window.sb
      .channel('inbound:' + myId)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'signaling' },
        (payload) => {
          const row = payload && payload.new;
          if (!row) return;
          if (row.sender_id === SENDER_ID) return;
          if (row.type !== 'offer') return;
          if (currentCall) return;
          if (!row.room_id || !row.room_id.startsWith('call:')) return;
          if (!row.room_id.includes(myId)) return;

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
    toggleSpeaker,
    isInCall: () => !!currentCall,
    startInboundListener,
    stopInboundListener,
    SENDER_ID
  };
})();
