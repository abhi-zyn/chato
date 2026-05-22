// =====================================================================
// PopChats — main app script (Supabase-backed)
// Depends on: supabase-js CDN, supabase-config.js, supabase-client.js,
//             auth.js, db.js (loaded in that order in index.html).
// =====================================================================

// ---------- DOM refs ----------
const sChats         = document.getElementById('screenChats');
const sConv          = document.getElementById('screenConv');
const sProfile       = document.getElementById('screenProfile');
const sSettings      = document.getElementById('screenSettings');
const sNotifications = document.getElementById('screenNotifications');
const sCalls         = document.getElementById('screenCalls');
const sLogin         = document.getElementById('screenLogin');
const screenStranger = document.getElementById('screenStranger');

const msgBox   = document.getElementById('messagesBox');
const convAv   = document.getElementById('convAvatar');
const convNm   = document.getElementById('convName');
const convSt   = document.getElementById('convStatus');
const msgInput = document.getElementById('msgInput');
const sendBtn  = document.getElementById('sendBtn');
const chatList = document.getElementById('chatList');

let me = null;          // current profile row from public.profiles
let activeChat = null;  // { id, other }
let messageSub = null;  // realtime channel for active chat
let allMessagesSub = null; // global realtime channel for ALL my chats
let messagePoller = null;  // polling fallback handle
let friendActivitySub = null;  // realtime channel for friend requests
let onlineHeartbeatId = null;  // setInterval id for online heartbeat
let presenceWatcherId = null;  // setInterval id for refreshing other users' online status
let pendingRequestCount = 0;   // incoming pending requests, for badge
let activeRequestTab = 'incoming';
const _seenMessageIds = new Set(); // dedupe between realtime + polling

// Online heartbeat — keeps last_seen fresh while tab is open
function startOnlineHeartbeat() {
  stopOnlineHeartbeat();
  // Mark online immediately
  PopChatsDB.markOnline(true).catch(() => {});
  // Then every 20 seconds
  onlineHeartbeatId = setInterval(() => {
    if (document.visibilityState === 'visible' && me) {
      PopChatsDB.markOnline(true).catch(() => {});
    }
  }, 20000);
}
function stopOnlineHeartbeat() {
  if (onlineHeartbeatId) {
    clearInterval(onlineHeartbeatId);
    onlineHeartbeatId = null;
  }
}

// Presence watcher — refreshes online status of other users in my chat list every 15s
function startPresenceWatcher() {
  stopPresenceWatcher();
  presenceWatcherId = setInterval(refreshPresence, 15000);
  // Also run immediately
  setTimeout(refreshPresence, 500);
  // Run again after a few seconds in case chats just loaded
  setTimeout(refreshPresence, 3000);
}
function stopPresenceWatcher() {
  if (presenceWatcherId) {
    clearInterval(presenceWatcherId);
    presenceWatcherId = null;
  }
}

async function refreshPresence() {
  if (!_cache.chats || !_cache.chats.length) return;
  if (document.visibilityState !== 'visible') return; // save bandwidth
  const otherIds = _cache.chats
    .map(c => c.other && c.other.id)
    .filter(Boolean);
  if (!otherIds.length) return;
  try {
    const presence = await PopChatsDB.getPresence(otherIds);
    // Update cached chat list
    _cache.chats.forEach(c => {
      if (c.other && presence[c.other.id]) {
        c.other.online = presence[c.other.id].online;
        c.other.last_seen = presence[c.other.id].last_seen;
      }
    });
    _cache.chats = _cache.chats; // persist
    // Update online dots in chat list
    _cache.chats.forEach(c => updateChatCardOnline(c.id, c.other && c.other.online));
    // Update conv header if active
    if (activeChat && activeChat.other && presence[activeChat.other.id]) {
      const p = presence[activeChat.other.id];
      activeChat.other.online = p.online;
      activeChat.other.last_seen = p.last_seen;
      if (convSt) convSt.textContent = p.online ? 'Online' : 'Offline';
      const friendBtn = document.getElementById('convFriendBtn');
      if (friendBtn) friendBtn.setAttribute('data-online', p.online ? 'true' : 'false');
    }
  } catch (e) {
    console.error('[refreshPresence]', e);
  }
}

// Update just the online dot on a chat card (no full re-render)
function updateChatCardOnline(chatId, isOnline) {
  if (!chatList) return;
  const card = chatList.querySelector(`.chat-card[data-id="${chatId}"]`);
  if (!card) return;
  const meta = card.querySelector('.chat-meta');
  if (!meta) return;
  const existingDot = meta.querySelector('.online');
  if (isOnline && !existingDot) {
    const dot = document.createElement('div');
    dot.className = 'online';
    meta.appendChild(dot);
  } else if (!isOnline && existingDot) {
    existingDot.remove();
  }
}

// Unread counts per chat (persisted in localStorage)
const _unread = {
  get map() {
    if (this._m !== undefined) return this._m;
    try {
      const raw = localStorage.getItem('popchats.unread');
      this._m = raw ? JSON.parse(raw) : {};
    } catch (_) { this._m = {}; }
    return this._m;
  },
  save() {
    try {
      localStorage.setItem('popchats.unread', JSON.stringify(this._m || {}));
    } catch (_) {}
  },
  get(chatId) { return (this.map[chatId] || 0); },
  inc(chatId) {
    this._m = this.map;
    this._m[chatId] = (this._m[chatId] || 0) + 1;
    this.save();
  },
  clear(chatId) {
    this._m = this.map;
    if (this._m[chatId]) {
      delete this._m[chatId];
      this.save();
    }
  },
  total() {
    const m = this.map;
    return Object.values(m).reduce((a, b) => a + b, 0);
  }
};

// Per-chat "last read" timestamp (persisted) — survives refresh so we don't
// re-count already-read messages when the polling fallback replays history.
// This is purely client-side (no server schema for read receipts).
const _readState = {
  get map() {
    if (this._m !== undefined) return this._m;
    try {
      const raw = localStorage.getItem('popchats.lastRead');
      this._m = raw ? JSON.parse(raw) : {};
    } catch (_) { this._m = {}; }
    return this._m;
  },
  save() {
    try {
      localStorage.setItem('popchats.lastRead', JSON.stringify(this._m || {}));
    } catch (_) {}
  },
  get(chatId) { return this.map[chatId] || ''; },
  // Advance read pointer to `at` (ISO string) only if it's newer than current.
  mark(chatId, at) {
    if (!chatId || !at) return;
    this._m = this.map;
    const cur = this._m[chatId];
    if (!cur || new Date(at) > new Date(cur)) {
      this._m[chatId] = at;
      this.save();
    }
  },
  // True if this message has already been read (created_at <= lastRead).
  alreadyRead(chatId, createdAt) {
    if (!createdAt) return false;
    const last = this.get(chatId);
    if (!last) return false;
    return new Date(createdAt) <= new Date(last);
  }
};

// ---------- helpers ----------
const AVATAR_FALLBACK = 'https://api.dicebear.com/7.x/initials/svg?seed=';
function avatarOf(p) {
  if (!p) return AVATAR_FALLBACK + '?';
  return p.avatar_url || (AVATAR_FALLBACK + encodeURIComponent(p.display_name || p.username || '?'));
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function formatTime(ts) {
  const d = new Date(ts);
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2,'0');
}
function toast(text) {
  let t = document.getElementById('popchatsToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'popchatsToast';
    t.style.cssText =
      'position:fixed;bottom:88px;left:50%;transform:translateX(-50%);' +
      'background:rgba(20,20,20,0.92);color:#fff;padding:11px 20px;border-radius:100px;' +
      "font-family:'Geist',sans-serif;font-size:13px;z-index:9999;opacity:0;" +
      'transition:opacity .25s;pointer-events:none;max-width:80%;text-align:center;';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3500);
}

// ---------- App splash (full-screen "Loading…") ----------
function showOAuthSplash(isAuth) {
  document.body.classList.add('oauth-splash-on');
  document.documentElement.classList.add('oauth-callback');
  const t = document.getElementById('oauthSplashTitle');
  const s = document.getElementById('oauthSplashSub');
  if (isAuth) {
    if (t) t.textContent = 'Signing you in';
    if (s) s.textContent = 'Hang tight, finishing up your session';
  } else {
    if (t) t.textContent = "That didn't work";
    if (s) s.textContent = 'Sending you back to the login screen…';
  }
}
function hideOAuthSplash() {
  document.body.classList.remove('oauth-splash-on');
  document.documentElement.classList.remove('oauth-callback');
  document.documentElement.classList.remove('is-loading');
  document.documentElement.classList.remove('has-session');
}

// ---------- themes ----------
const themes = {
  lavender: { bg:'linear-gradient(135deg,#f3e7ff 0%,#ffeef8 50%,#e8e0ff 100%)',
              orb1:'rgba(212,196,251,0.8)', orb2:'rgba(248,205,218,0.7)', orb3:'rgba(224,195,252,0.6)',
              bar:'#f3e7ff' },
  ocean:    { bg:'linear-gradient(135deg,#e0f7fa 0%,#b2ebf2 50%,#80deea 100%)',
              orb1:'rgba(128,222,234,0.8)', orb2:'rgba(178,235,242,0.7)', orb3:'rgba(224,247,250,0.6)',
              bar:'#e0f7fa' },
  sunset:   { bg:'linear-gradient(135deg,#fff3e0 0%,#ffe0b2 50%,#ffcc80 100%)',
              orb1:'rgba(255,204,128,0.8)', orb2:'rgba(255,224,178,0.7)', orb3:'rgba(255,243,224,0.6)',
              bar:'#fff3e0' },
  offwhite: { bg:'linear-gradient(135deg,#fafaf8 0%,#f5f3ef 50%,#edeae4 100%)',
              orb1:'rgba(230,225,215,0.7)', orb2:'rgba(240,235,225,0.6)', orb3:'rgba(220,215,205,0.5)',
              bar:'#fafaf8' },
  midnight: { bg:'linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%)',
              orb1:'rgba(15,52,96,0.8)', orb2:'rgba(22,33,62,0.7)', orb3:'rgba(26,26,46,0.6)',
              bar:'#1a1a2e' },
  rose:     { bg:'linear-gradient(135deg,#fff0f3 0%,#ffd6e0 50%,#ffb3c6 100%)',
              orb1:'rgba(255,179,198,0.8)', orb2:'rgba(255,214,224,0.7)', orb3:'rgba(255,240,243,0.6)',
              bar:'#fff0f3' },
  mint:     { bg:'linear-gradient(135deg,#f0fff4 0%,#c6f6d5 50%,#9ae6b4 100%)',
              orb1:'rgba(154,230,180,0.8)', orb2:'rgba(198,246,213,0.7)', orb3:'rgba(240,255,244,0.6)',
              bar:'#f0fff4' },
};
const THEME_STORAGE_KEY = 'popchats.theme';

function applyTheme(name, persist = true) {
  const t = themes[name]; if (!t) return;
  document.body.style.background = t.bg;
  const orbs = document.querySelectorAll('.orb');
  if (orbs[0]) orbs[0].style.background = t.orb1;
  if (orbs[1]) orbs[1].style.background = t.orb2;
  if (orbs[2]) orbs[2].style.background = t.orb3;
  // Sync mobile status bar / PWA title bar color with theme
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.bar);
  document.querySelectorAll('.theme-card').forEach(c =>
    c.classList.toggle('active', c.dataset.theme === name));
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, name); } catch (_) {}
  }
}

// ---------- screen routing ----------
function setNavActive(view) {
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  // Mirror to desktop sidebar
  document.querySelectorAll('.sb-icon-btn[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.sb-item[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
}

function navTo(v) {
  setNavActive(v);
  if (v === 'chats')              { showScreen('chats', 'chats'); loadChatList(); }
  else if (v === 'profile')       { showScreen('profile', 'profile'); refreshProfileScreen(); }
  else if (v === 'notifications') { showScreen('notifications', 'notifications'); loadNotificationsScreen(); }
  else if (v === 'calls')         { showScreen('calls', 'calls'); loadCallsScreen(); }
  else if (v === 'add')           openModal();
}
function showScreen(name, navView) {
  const isDesktop = window.innerWidth >= 768;

  if (isDesktop && name === 'conv') {
    // Desktop: keep chat list visible, show conv alongside
    const sRequests = document.getElementById('screenRequests');
    [sProfile, sSettings, sNotifications, sCalls, sRequests].forEach(s => s && s.classList.remove('active'));
    sConv.classList.add('active');
    document.body.classList.add('desktop-conv-open');
    document.body.classList.remove('show-other-screen');
    if (navView) setNavActive(navView);
    document.body.classList.add('is-authed');
    return;
  }

  // Remove active from all screens
  const sRequests = document.getElementById('screenRequests');
  [sLogin, sChats, sConv, sProfile, sSettings, sNotifications, sCalls, sRequests]
    .forEach(s => s && s.classList.remove('active'));
  const map = { login:sLogin, chats:sChats, conv:sConv, profile:sProfile,
                settings:sSettings, notifications:sNotifications, calls:sCalls,
                requests: sRequests };
  if (map[name]) map[name].classList.add('active');
  if (navView) setNavActive(navView);
  const nav = document.querySelector('.bottom-nav');
  const hideNavOn = ['login', 'conv', 'requests'];
  if (nav) nav.style.display = hideNavOn.includes(name) ? 'none' : 'flex';
  document.body.classList.toggle('is-authed', name !== 'login');
  document.body.classList.remove('desktop-conv-open');

  // Desktop: toggle class to hide chat list when showing other screens
  if (isDesktop) {
    const otherScreens = ['profile', 'settings', 'notifications', 'calls'];
    document.body.classList.toggle('show-other-screen', otherScreens.includes(name));
  }
}

// ---------- chat list ----------
async function loadChatList() {
  if (!chatList) return;
  // Show cached chat list instantly
  if (_cache.chats && _cache.chats.length) {
    renderChatListDOM(_cache.chats);
    // Background refresh
    PopChatsDB.listMyChats().then(chats => {
      _cache.chats = chats;
      renderChatListDOM(chats);
    }).catch(e => console.error('loadChatList bg:', e));
    return;
  }
  chatList.innerHTML = '<div style="padding:24px;text-align:center;color:#9a9488;font-size:13px;">Loading…</div>';
  try {
    const chats = await PopChatsDB.listMyChats();
    _cache.chats = chats;
    renderChatListDOM(chats);
  } catch (e) {
    console.error('loadChatList:', e);
    chatList.innerHTML =
      '<div style="padding:30px;text-align:center;color:#9a9488;font-size:13px;line-height:1.6;">' +
      'Could not load chats.<br/>Pull down to retry.' +
      '</div>';
  }
}

function renderChatListDOM(chats) {
  if (!chatList) return;
  chatList.innerHTML = '';
  if (!chats.length) {
    chatList.innerHTML =
      '<div style="padding:30px;text-align:center;color:#9a9488;font-size:13px;line-height:1.6;">' +
      'No chats yet.<br/>Tap <strong>+</strong> below to start one.' +
      '</div>';
    return;
  }
  chats.forEach((c, i) => {
    const other = c.other;
    const card = document.createElement('div');
    card.className = 'chat-card';
    card.dataset.id = c.id;
    const name = escapeHtml(other ? (other.full_name || other.display_name || other.username) : 'Unknown');
    const sub  = escapeHtml(c.last_text || (c.is_stranger ? 'Stranger chat' : 'Say hi'));
    const dot  = other && other.online ? '<div class="online"></div>' : '';
    const unreadCount = _unread.get(c.id);
    const unreadBadge = unreadCount > 0
      ? `<div class="unread-badge">${unreadCount > 99 ? '99+' : unreadCount}</div>`
      : '';
    card.innerHTML =
      `<div class="avatar"><img src="${avatarOf(other)}" alt=""/></div>` +
      `<div class="chat-info">` +
        `<div class="chat-name">${name}</div>` +
        `<div class="chat-sub">${sub}</div>` +
      `</div>` +
      `<div class="chat-meta">${unreadBadge}${dot}</div>`;
    if (unreadCount > 0) card.classList.add('has-unread');
    // Store data on the card for delegation
    card._chatData = { id: c.id, other, isStranger: c.is_stranger };
    chatList.appendChild(card);
    setTimeout(() => card.classList.add('show'), i * 60);
  });
  updateGlobalUnreadBadge();
}

// Update unread badge for a specific chat card (no full re-render)
function updateChatCardUnread(chatId) {
  if (!chatList) return;
  const card = chatList.querySelector(`.chat-card[data-id="${chatId}"]`);
  if (!card) return;
  const meta = card.querySelector('.chat-meta');
  if (!meta) return;
  const dot = meta.querySelector('.online');
  const dotHtml = dot ? dot.outerHTML : '';
  const count = _unread.get(chatId);
  const badge = count > 0
    ? `<div class="unread-badge">${count > 99 ? '99+' : count}</div>`
    : '';
  meta.innerHTML = badge + dotHtml;
  card.classList.toggle('has-unread', count > 0);
}

function updateGlobalUnreadBadge() {
  // Update any global unread counter in nav/header here if needed
  const total = _unread.total();
  document.title = total > 0 ? `(${total}) PopChats` : 'PopChats';
}

// Handle incoming message from global realtime subscription
function handleIncomingMessage(msg) {
  if (!msg || !msg.chat_id || !msg.sender_id || !msg.id) return;
  // Dedupe: realtime + polling may both deliver the same message
  if (_seenMessageIds.has(msg.id)) return;
  _seenMessageIds.add(msg.id);
  // Keep set bounded
  if (_seenMessageIds.size > 500) {
    const arr = Array.from(_seenMessageIds);
    arr.slice(0, 250).forEach(id => _seenMessageIds.delete(id));
  }

  // My own messages: just advance read pointer; never count as unread.
  if (me && msg.sender_id === me.id) {
    _readState.mark(msg.chat_id, msg.created_at);
    if (_cache.chats) {
      const chat = _cache.chats.find(c => c.id === msg.chat_id);
      if (chat) {
        chat.last_text = msg.text || '';
        chat.last_at = msg.created_at;
        _cache.chats = _cache.chats;
      }
    }
    updateChatCardPreview(msg.chat_id, msg.text || '');
    return;
  }

  // Cross-refresh dedupe: if this message was already seen/read in a previous
  // session (per persisted _readState), skip the unread bump. Otherwise, on
  // page refresh the polling fallback would replay history and over-count.
  const alreadyRead = _readState.alreadyRead(msg.chat_id, msg.created_at);

  // Update last message in cached chat list for instant preview
  if (_cache.chats) {
    const chat = _cache.chats.find(c => c.id === msg.chat_id);
    if (chat) {
      chat.last_text = msg.text || '';
      chat.last_at = msg.created_at;
    }
    _cache.chats = _cache.chats; // persist to localStorage
  }

  // Update the preview text on the card directly (instant, no re-render)
  updateChatCardPreview(msg.chat_id, msg.text || '');

  // If this chat is currently open, append message directly (no unread bump)
  if (activeChat && activeChat.id === msg.chat_id) {
    appendMessage(msg);
    _readState.mark(msg.chat_id, msg.created_at);
    return;
  }

  if (alreadyRead) return;

  // Bump unread counter
  _unread.inc(msg.chat_id);
  updateChatCardUnread(msg.chat_id);
  updateGlobalUnreadBadge();

  // Move this chat to the top of the cached list and re-render
  if (_cache.chats) {
    const idx = _cache.chats.findIndex(c => c.id === msg.chat_id);
    if (idx > 0) {
      const [chat] = _cache.chats.splice(idx, 1);
      _cache.chats.unshift(chat);
      _cache.chats = _cache.chats; // persist
      renderChatListDOM(_cache.chats);
    }
  }

  // Subtle ping sound (optional, only if permitted)
  playMessagePing();
}

// Update just the preview text on a chat card (no full re-render)
function updateChatCardPreview(chatId, text) {
  if (!chatList) return;
  const card = chatList.querySelector(`.chat-card[data-id="${chatId}"]`);
  if (!card) return;
  const sub = card.querySelector('.chat-sub');
  if (sub) {
    sub.textContent = text || '';
  }
}

// Subtle audio ping for new messages
let _pingAudio = null;
function playMessagePing() {
  try {
    if (!_pingAudio) {
      // Encode a short tone using Web Audio
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      _pingAudio = ctx;
    }
    const ctx = _pingAudio;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch (_) {}
}

// Event delegation for chat card clicks (more robust than per-card handlers)
function setupChatListDelegation() {
  if (!chatList || chatList._delegated) return;
  chatList._delegated = true;
  // Use both 'click' and 'pointerup' for max reliability across devices
  const handler = (e) => {
    const card = e.target.closest('.chat-card');
    if (!card || !card._chatData) return;
    e.preventDefault();
    e.stopPropagation();
    const d = card._chatData;
    openChat(d.id, d.other, d.isStranger);
  };
  chatList.addEventListener('click', handler);
}
setupChatListDelegation();
// Also retry after DOM may have new content
document.addEventListener('DOMContentLoaded', setupChatListDelegation);

// GLOBAL capture — catches clicks even if something else is intercepting them
// Uses capture phase to run BEFORE other handlers
document.addEventListener('click', (e) => {
  const card = e.target.closest('.chat-card');
  if (card && card._chatData && !card._opening) {
    card._opening = true;
    setTimeout(() => { card._opening = false; }, 500); // debounce
    const d = card._chatData;
    openChat(d.id, d.other, d.isStranger);
  }
}, true);

// ---------- conversation ----------
async function openChat(chatId, otherProfile, isStranger) {
  let other = otherProfile;
  if (!other) {
    const members = await PopChatsDB.getChatMembers(chatId);
    other = members.find(m => m.id !== (me && me.id)) || null;
  }
  activeChat = { id: chatId, other, isStranger: !!isStranger, friendState: 'none' };
  
  // Clear unread count for this chat
  _unread.clear(chatId);
  // Advance the per-chat read pointer to "now" so any historical messages
  // replayed by the polling fallback after a future refresh won't re-bump unread.
  _readState.mark(chatId, new Date().toISOString());
  updateChatCardUnread(chatId);
  updateGlobalUnreadBadge();
  
  convAv.src = avatarOf(other);
  convAv.alt = other ? (other.full_name || other.display_name || other.username) : '';
  convNm.textContent = other ? (other.full_name || other.display_name || other.username) : 'Unknown';
  convSt.textContent = other && other.online ? 'Online' : 'Offline';
  const friendBtn = document.getElementById('convFriendBtn');
  if (friendBtn) friendBtn.setAttribute('data-online', other && other.online ? 'true' : 'false');
  showScreen('conv');
  await renderMessages(chatId);
  if (messageSub) { PopChatsDB.unsubscribe(messageSub); messageSub = null; }
  messageSub = PopChatsDB.subscribeToChat(chatId, (m) => appendMessage(m));

  // Determine friendship state to gate input and show banner
  await refreshConvFriendGate();
}

async function refreshConvFriendGate() {
  const banner = document.getElementById('convBanner');
  if (!activeChat || !activeChat.other || activeChat.isStranger) {
    if (banner) banner.hidden = true;
    setSendDisabled(false);
    return;
  }
  const other = activeChat.other;
  const state = await PopChatsDB.friendshipState(other.id);
  activeChat.friendState = state;

  // Stranger chats are not friend-gated
  // We don't have is_stranger here; infer from chat list or assume DM
  // Friends can chat freely
  if (state === 'friends' || state === 'self') {
    if (banner) banner.hidden = true;
    setSendDisabled(false);
    return;
  }

  // Render banner based on state
  if (banner) {
    let html = '';
    if (state === 'incoming') {
      html =
        `<div class="conv-banner-text">${escapeHtml(other.full_name || other.display_name || other.username)} sent you a friend request.</div>` +
        `<div class="conv-banner-actions">` +
          `<button class="btn-ghost" data-act="decline">Decline</button>` +
          `<button class="btn-primary" data-act="accept">Accept</button>` +
        `</div>`;
    } else if (state === 'outgoing') {
      html =
        `<div class="conv-banner-text">Friend request sent. You can chat once it's accepted.</div>` +
        `<div class="conv-banner-actions">` +
          `<button class="btn-ghost" data-act="cancel">Cancel request</button>` +
        `</div>`;
    } else if (state === 'blocked') {
      html = `<div class="conv-banner-text">You can't message this person.</div>`;
    } else {
      html =
        `<div class="conv-banner-text">Send a friend request to start chatting.</div>` +
        `<div class="conv-banner-actions">` +
          `<button class="btn-primary" data-act="add">Add friend</button>` +
        `</div>`;
    }
    banner.innerHTML = html;
    banner.hidden = false;
    banner.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        try {
          if (act === 'add')      await PopChatsDB.sendFriendRequest(other.id);
          if (act === 'cancel')   await PopChatsDB.cancelFriendRequest(other.id);
          if (act === 'accept')   await PopChatsDB.acceptFriendRequest(other.id);
          if (act === 'decline')  await PopChatsDB.declineFriendRequest(other.id);
          await refreshConvFriendGate();
          if (act === 'accept' || act === 'add') loadChatList();
        } catch (e) { toast(e.message || 'Action failed'); }
      });
    });
  }
  setSendDisabled(true);
}

function setSendDisabled(disabled) {
  if (sendBtn) sendBtn.disabled = !!disabled;
  if (msgInput) {
    msgInput.disabled = !!disabled;
    msgInput.placeholder = disabled ? 'You need to be friends to chat…' : 'Type your message...';
  }
}

// ---------- Session cache (reduces network on repeated views) ----------
// Cache: in-memory + localStorage persistence so refreshes show data instantly
const _cacheKey = (name) => `popchats.cache.${name}`;
const _cache = {
  get chats() {
    if (this._chats !== undefined) return this._chats;
    try {
      const raw = localStorage.getItem(_cacheKey('chats'));
      this._chats = raw ? JSON.parse(raw) : null;
    } catch (_) { this._chats = null; }
    return this._chats;
  },
  set chats(v) {
    this._chats = v;
    try {
      if (v) localStorage.setItem(_cacheKey('chats'), JSON.stringify(v));
      else localStorage.removeItem(_cacheKey('chats'));
    } catch (_) {}
  },
  get messages() {
    if (this._messages) return this._messages;
    try {
      const raw = localStorage.getItem(_cacheKey('messages'));
      this._messages = raw ? JSON.parse(raw) : {};
    } catch (_) { this._messages = {}; }
    return this._messages;
  },
  set messages(v) {
    this._messages = v;
    try {
      localStorage.setItem(_cacheKey('messages'), JSON.stringify(v));
    } catch (_) {}
  },
  saveMessages() {
    // Call after mutating _cache.messages[chatId] in place
    try {
      localStorage.setItem(_cacheKey('messages'), JSON.stringify(this._messages || {}));
    } catch (_) {}
  },
  clearAll() {
    this._chats = undefined;
    this._messages = null;
    try {
      localStorage.removeItem(_cacheKey('chats'));
      localStorage.removeItem(_cacheKey('messages'));
    } catch (_) {}
  }
};

async function renderMessages(chatId) {
  msgBox.innerHTML = '';
  // Show cached messages instantly, then refresh in background
  const cached = _cache.messages[chatId];
  if (cached && cached.length) {
    cached.forEach((m, i) => appendMessage(m, false, i));
    requestAnimationFrame(() => { msgBox.scrollTop = msgBox.scrollHeight; });
    // Background refresh — but DON'T clear messages on transient failure
    PopChatsDB.listMessages(chatId).then(list => {
      // If fetch returned empty/null, don't clobber cached messages
      if (!list || !list.length) return;
      _cache.messages[chatId] = list;
      _cache.saveMessages();
      // Only re-render if user is STILL on this chat AND messages changed
      if (activeChat && activeChat.id === chatId &&
          (list.length !== cached.length || list[list.length-1].id !== cached[cached.length-1].id)) {
        msgBox.innerHTML = '';
        list.forEach((m, i) => appendMessage(m, false, i));
        requestAnimationFrame(() => { msgBox.scrollTop = msgBox.scrollHeight; });
      }
    }).catch(e => console.error('renderMessages bg:', e));
  } else {
    const list = await PopChatsDB.listMessages(chatId);
    _cache.messages[chatId] = list;
    _cache.saveMessages();
    list.forEach((m, i) => appendMessage(m, false, i));
    requestAnimationFrame(() => { msgBox.scrollTop = msgBox.scrollHeight; });
  }
}

function appendMessage(m, animate = true, idx = 0) {
  if (document.getElementById('msg-' + m.id)) return; // de-dupe realtime echoes
  const isMine = me && m.sender_id === me.id;
  const r = document.createElement('div');
  r.id = 'msg-' + m.id;
  r.className = 'msg-row ' + (isMine ? 'sent' : 'received');
  if (animate) r.style.animationDelay = (idx * 0.05) + 's';
  r.innerHTML =
    `<div class="msg-bubble">${escapeHtml(m.text)}</div>` +
    `<div class="msg-time">${formatTime(m.created_at)}</div>`;
  msgBox.appendChild(r);
  requestAnimationFrame(() => { msgBox.scrollTop = msgBox.scrollHeight; });
  // Keep cache in sync for realtime messages
  if (animate && activeChat) {
    const chatId = activeChat.id;
    if (!_cache.messages[chatId]) _cache.messages[chatId] = [];
    if (!_cache.messages[chatId].find(x => x.id === m.id)) {
      _cache.messages[chatId].push(m);
      _cache.saveMessages();
    }
  }
}

async function sendMsg() {
  const txt = msgInput.value.trim();
  if (!txt || !activeChat) return;
  // Hard guard: if input is disabled (non-friend / non-stranger), don't send
  if (msgInput.disabled || (sendBtn && sendBtn.disabled)) {
    toast('You need to be friends to send messages.');
    return;
  }
  msgInput.value = '';

  // Optimistic local echo with pop animation
  const tempId = 'temp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const r = document.createElement('div');
  r.id = 'msg-' + tempId;
  r.className = 'msg-row sent just-sent';
  r.innerHTML =
    `<div class="msg-bubble">${escapeHtml(txt)}</div>` +
    `<div class="msg-time">${formatTime(new Date().toISOString())}</div>`;
  msgBox.appendChild(r);
  requestAnimationFrame(() => { msgBox.scrollTop = msgBox.scrollHeight; });
  // Settle the pop highlight after the animation
  setTimeout(() => r.classList.add('settled'), 500);

  try {
    const saved = await PopChatsDB.sendMessage(activeChat.id, txt);
    // Replace temp row id with the real DB id so realtime echo dedupes
    if (saved && saved.id) r.id = 'msg-' + saved.id;
    // Update chat list preview with my own message text
    if (_cache.chats) {
      const chat = _cache.chats.find(c => c.id === activeChat.id);
      if (chat) {
        chat.last_text = txt;
        chat.last_at = new Date().toISOString();
        _cache.chats = _cache.chats;
      }
    }
    updateChatCardPreview(activeChat.id, txt);
  } catch (e) {
    console.error(e);
    r.remove();
    msgInput.value = txt; // restore so user can retry
    toast('Failed to send: ' + (e.message || 'unknown error'));
  }
}

// ---------- New chat modal (search) ----------
const modal         = document.getElementById('newChatModal');
const userIdInput   = document.getElementById('userIdInput');
const modalResult   = document.getElementById('modalResult');

function openModal() {
  modal.classList.add('open');
  userIdInput.value = '';
  modalResult.innerHTML = '';
  setTimeout(() => userIdInput.focus(), 400);
}
function closeModal() {
  modal.classList.remove('open');
  setNavActive('chats');
}

async function searchUser() {
  const q = userIdInput.value.trim().replace(/^@/, '');
  if (!q) { modalResult.innerHTML = '<p class="result-msg">Type a username to search.</p>'; return; }
  modalResult.innerHTML = '<p class="result-msg">Searching…</p>';
  const users = await PopChatsDB.searchProfiles(q);
  const filtered = users.filter(u => u.id !== (me && me.id));
  if (!filtered.length) {
    modalResult.innerHTML = '<p class="result-msg">No user found. Try another username.</p>';
    return;
  }
  const states = await PopChatsDB.friendshipStatesFor(filtered.slice(0, 5).map(u => u.id));
  modalResult.innerHTML = filtered.slice(0, 5).map(u => {
    const st = states[u.id] || 'none';
    return `<div class="result-card" data-uid="${u.id}">
      <div class="result-avatar"><img src="${avatarOf(u)}" alt=""/></div>
      <div class="result-info">
        <div class="result-name">${escapeHtml(u.full_name || u.display_name || u.username)}</div>
        <div class="result-handle">@${escapeHtml(u.username)}</div>
      </div>
      ${friendActionButtonHTML(st)}
    </div>`;
  }).join('');
  modalResult.querySelectorAll('.result-card').forEach(card => {
    const uid = card.dataset.uid;
    const u = filtered.find(x => x.id === uid);
    card.querySelectorAll('button[data-friend-act]').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleFriendAction(btn.dataset.friendAct, u, async () => {
          // Re-render this row only
          const newState = await PopChatsDB.friendshipState(uid);
          card.querySelector('.result-action-slot').outerHTML = friendActionButtonHTML(newState);
          // Re-bind
          card.querySelectorAll('button[data-friend-act]').forEach(nb =>
            nb.addEventListener('click', (ev) => {
              ev.stopPropagation();
              handleFriendAction(nb.dataset.friendAct, u, () => searchUser());
            }));
        });
      }));
  });
}

// Renders the action area for a user given a friendship state
function friendActionButtonHTML(state) {
  if (state === 'friends') {
    return `<div class="result-action-slot"><button class="result-start-btn" data-friend-act="message">Message</button></div>`;
  }
  if (state === 'outgoing') {
    return `<div class="result-action-slot"><button class="result-start-btn ghost" data-friend-act="cancel">Requested</button></div>`;
  }
  if (state === 'incoming') {
    return `<div class="result-action-slot">
      <button class="result-start-btn ghost" data-friend-act="decline">Decline</button>
      <button class="result-start-btn" data-friend-act="accept">Accept</button>
    </div>`;
  }
  if (state === 'blocked' || state === 'self') {
    return `<div class="result-action-slot"></div>`;
  }
  return `<div class="result-action-slot"><button class="result-start-btn" data-friend-act="add">Add Friend</button></div>`;
}

async function handleFriendAction(action, user, onDone) {
  try {
    if (action === 'add')     { await PopChatsDB.sendFriendRequest(user.id);    toast('Friend request sent'); }
    if (action === 'cancel')  { await PopChatsDB.cancelFriendRequest(user.id);  toast('Request cancelled'); }
    if (action === 'decline') { await PopChatsDB.declineFriendRequest(user.id); toast('Declined'); }
    if (action === 'accept')  {
      const chatId = await PopChatsDB.acceptFriendRequest(user.id);
      toast("You're now friends with @" + (user.username || ''));
      closeModal();
      await loadChatList();
      openChat(chatId, user, false);
      return;
    }
    if (action === 'message') {
      const chatId = await PopChatsDB.getOrCreateDM(user.id);
      closeModal();
      await loadChatList();
      openChat(chatId, user, false);
      return;
    }
    if (typeof onDone === 'function') await onDone();
  } catch (e) {
    toast(e.message || 'Action failed');
  }
}

// ---------- Stranger chat ----------
const strangerStatus = document.getElementById('strangerStatus');
const strangerSub    = document.getElementById('strangerSub');
let strangerTimer = null;
let strangerDotTimer = null;

async function startStrangerMatch() {
  closeModal();
  [sChats, sConv, sProfile, sSettings, sNotifications, sCalls]
    .forEach(s => s && s.classList.remove('active'));
  screenStranger.classList.add('active');
  strangerStatus.textContent = 'Finding someone...';
  strangerSub.textContent = 'Matching you with a stranger nearby';

  let dots = 0;
  strangerDotTimer = setInterval(() => {
    dots = (dots + 1) % 4;
    strangerStatus.textContent = 'Finding someone' + '.'.repeat(dots);
  }, 500);

  strangerTimer = setTimeout(async () => {
    clearInterval(strangerDotTimer);
    try {
      const strangerId = await PopChatsDB.pickRandomStranger();
      if (!strangerId) {
        strangerStatus.textContent = 'No one available';
        strangerSub.textContent = 'Try again in a bit';
        return;
      }
      const stranger = await PopChatsDB.getProfile(strangerId);
      strangerStatus.textContent = 'Match found!';
      strangerSub.textContent = 'Connected with ' + (stranger.display_name || stranger.username);
      const chatId = await PopChatsDB.startStrangerChat(strangerId);
      setTimeout(async () => {
        screenStranger.classList.remove('active');
        await loadChatList();
        openChat(chatId, stranger, true);
      }, 900);
    } catch (e) {
      strangerStatus.textContent = 'Error';
      strangerSub.textContent = e.message || 'Something went wrong';
    }
  }, 2400);
}

// ---------- Login screen ----------
let loginMode = 'login';

function setTab(mode) {
  loginMode = mode;
  const loginTab     = document.getElementById('loginTab');
  const signupTab    = document.getElementById('signupTab');
  const usernameWrap = document.getElementById('usernameWrap');
  const forgotBtn    = document.getElementById('forgotBtn');
  const disclaimer   = document.getElementById('loginDisclaimer');
  const consumeText  = document.getElementById('consumeText');
  const signupLink   = document.querySelector('.signup-link');
  const btnLabel     = document.getElementById('loginBtnLabel');

  if (mode === 'signup') {
    loginTab.classList.remove('active');
    signupTab.classList.add('active');
    usernameWrap.style.display = 'flex';
    if (forgotBtn) forgotBtn.style.display = 'none';
    signupLink.textContent = 'Log in';
    signupLink.setAttribute('onclick', "setTab('login')");
    disclaimer.textContent = 'By signing up you agree to our terms and privacy policy.';
    consumeText.textContent = 'Join the conversation!';
    if (btnLabel) btnLabel.textContent = 'Sign up';
  } else {
    loginTab.classList.add('active');
    signupTab.classList.remove('active');
    usernameWrap.style.display = 'none';
    if (forgotBtn) forgotBtn.style.display = '';
    signupLink.textContent = 'Sign up';
    signupLink.setAttribute('onclick', "setTab('signup')");
    disclaimer.textContent = 'Connect with people around you. By continuing you agree to our terms and privacy policy.';
    consumeText.textContent = 'Please chat responsibly!';
    if (btnLabel) btnLabel.textContent = 'Log in';
  }
}
window.setTab = setTab;

// ---------- Eye toggle (password visibility) ----------
function initEyeToggle() {
  const toggle = document.getElementById('eyeToggle');
  const passInput = document.getElementById('loginPassword');
  if (!toggle || !passInput) return;
  toggle.addEventListener('click', () => {
    const isHidden = passInput.type === 'password';
    passInput.type = isHidden ? 'text' : 'password';
    toggle.querySelector('.eye-open').style.display = isHidden ? 'none' : '';
    toggle.querySelector('.eye-closed').style.display = isHidden ? '' : 'none';
  });
}

function shakeLogin() {
  const card = document.getElementById('loginCard');
  if (!card) return;
  card.style.animation = 'none';
  // force reflow
  void card.offsetHeight;
  card.style.animation = 'shake 0.4s ease';
}

async function handleAuthSubmit() {
  const email    = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) { shakeLogin(); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast('Enter a valid email address.');
    shakeLogin();
    return;
  }
  const goBtn = document.getElementById('loginGoBtn');
  goBtn.disabled = true;
  goBtn.classList.add('is-loading');

  // Watchdog: force-release the button if anything stalls (network, hung query, etc.)
  const watchdog = setTimeout(() => {
    if (goBtn.classList.contains('is-loading')) {
      goBtn.disabled = false;
      goBtn.classList.remove('is-loading');
      toast('Network is slow. Please try again.');
    }
  }, 15000);

  try {
    // Pre-check: does this email exist? (best-effort, ignore failure)
    let exists = null;
    try { exists = await PopChatsDB.emailExists(email); } catch (_) { exists = null; }

    if (loginMode === 'signup') {
      if (exists === true) {
        toast('This email is already registered. Try logging in instead.');
        shakeLogin();
        setTab('login');
        document.getElementById('loginPassword').value = '';
        document.getElementById('loginPassword').focus();
        return;
      }
      const username = document.getElementById('loginUsername').value.trim();
      if (!username) { shakeLogin(); return; }
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        toast('Username: 3–24 chars, letters/numbers/underscore.');
        shakeLogin();
        return;
      }
      if (password.length < 6) {
        toast('Password must be at least 6 characters.');
        shakeLogin();
        return;
      }
      const res = await PopChatsAuth.signUp(email, password, username);
      if (res.error) throw res.error;
      if (!res.data.session) {
        showVerifyEmailDialog(email);
        setTab('login');
        return;
      }
      // Don't await bootAuthed — release button now; auth listener handles boot.
      bootAuthed(res.data.user).catch(err => console.error('bootAuthed:', err));
    } else {
      // Login mode
      if (exists === false) {
        toast('No account found with this email. Sign up first.');
        shakeLogin();
        setTab('signup');
        document.getElementById('loginPassword').value = '';
        return;
      }
      const res = await PopChatsAuth.signIn(email, password);
      if (res.error) {
        const msg = (res.error.message || '').toLowerCase();
        if (msg.includes('invalid login') || msg.includes('credentials')) {
          throw new Error('Wrong password. Check and try again.');
        }
        if (msg.includes('email not confirmed')) {
          throw new Error('Please verify your email first. Check your inbox.');
        }
        throw res.error;
      }
      // Don't await bootAuthed — release button now; auth listener handles boot.
      if (res.data && res.data.user) {
        bootAuthed(res.data.user).catch(err => console.error('bootAuthed:', err));
      }
    }
  } catch (e) {
    const m = (e.message || '').toLowerCase();
    let friendly = e.message || 'Authentication failed';
    if (m.includes('user already registered') || m.includes('already exists')) {
      friendly = 'This email is already registered. Try logging in.';
      setTab('login');
    } else if (m.includes('rate limit')) {
      friendly = 'Too many attempts. Wait a minute and try again.';
    } else if (m.includes('weak password') || m.includes('password should be')) {
      friendly = 'Password too weak. Use at least 6 characters.';
    }
    toast(friendly);
    shakeLogin();
  } finally {
    clearTimeout(watchdog);
    goBtn.disabled = false;
    goBtn.classList.remove('is-loading');
  }
}

// ---------- Google OAuth ----------
async function handleGoogleSignIn() {
  const btn = document.getElementById('googleBtn');
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.style.cursor = 'wait';
  }
  try {
    const { error } = await window.sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.POPCHATS_SITE_URL }
    });
    if (error) throw error;
  } catch (e) {
    toast(e.message || 'Google sign-in failed');
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor = '';
    }
  }
}

// ---------- Verify email dialog ----------
function showVerifyEmailDialog(email) {
  const m = document.getElementById('verifyModal');
  if (!m) return;
  document.getElementById('verifyEmailAddr').textContent = email;
  m.classList.add('open');
}
function closeVerifyEmailDialog() {
  const m = document.getElementById('verifyModal');
  if (m) m.classList.remove('open');
}

// ---------- Forgot password modal ----------
function openForgotModal() {
  const m = document.getElementById('forgotModal');
  if (!m) return;
  m.classList.add('open');
  const emailField = document.getElementById('forgotEmail');
  emailField.value = document.getElementById('loginEmail').value || '';
  document.getElementById('forgotMsg').textContent = '';
  setTimeout(() => emailField.focus(), 250);
}
function closeForgotModal() {
  const m = document.getElementById('forgotModal');
  if (m) m.classList.remove('open');
}
async function submitForgot() {
  const email = document.getElementById('forgotEmail').value.trim();
  const msgEl = document.getElementById('forgotMsg');
  msgEl.style.color = '#9a9488';
  if (!email) { msgEl.textContent = 'Enter your email.'; return; }
  msgEl.textContent = 'Sending…';
  const res = await PopChatsAuth.resetPassword(email);
  if (res.error) {
    msgEl.style.color = '#c14040';
    msgEl.textContent = res.error.message;
    return;
  }
  msgEl.style.color = '#2a7a2a';
  msgEl.textContent = 'Check your inbox for the reset link.';
}

// ---------- Profile screen ----------
function refreshProfileScreen() {
  if (!me) return;
  document.querySelectorAll('.profile-name').forEach(el =>
    el.textContent = me.full_name || me.display_name || me.username);
  document.querySelectorAll('.profile-handle').forEach(el =>
    el.textContent = '@' + me.username);
  document.querySelectorAll('.profile-avatar img').forEach(el =>
    el.src = avatarOf(me));
  // Bio
  const bioEl = document.getElementById('profileBio');
  if (bioEl) {
    if (me.bio && me.bio.trim()) {
      bioEl.textContent = me.bio;
      bioEl.style.display = 'block';
    } else {
      bioEl.style.display = 'none';
    }
  }
  // Sidebar user card + mini avatar
  const sbName = document.getElementById('sbUserName');
  const sbAv = document.getElementById('sbUserAvatar');
  const sbMini = document.getElementById('sbMiniAvatarImg');
  if (sbName) sbName.textContent = me.full_name || me.display_name || me.username;
  if (sbAv) sbAv.src = avatarOf(me);
  if (sbMini) sbMini.src = avatarOf(me);
}

// ---------- Onboarding modal ----------
let onboardingState = { gender: null, avatarFile: null, avatarUrl: null, usernameOk: false };

function openOnboardingModal(authUser) {
  const m = document.getElementById('onboardModal');
  if (!m) return;
  // Pre-fill from existing profile / auth user metadata
  const meta = (authUser && authUser.user_metadata) || {};
  const seed = me && me.username ? me.username : 'PopChats';
  document.getElementById('onboardAvatarPreview').src =
    (me && me.avatar_url) || meta.avatar_url ||
    ('https://api.dicebear.com/7.x/initials/svg?seed=' + encodeURIComponent(seed));

  document.getElementById('onboardUsername').value = (me && me.username) || '';
  document.getElementById('onboardFullName').value =
    (me && me.full_name) || meta.full_name || meta.name || (me && me.display_name) || '';
  document.getElementById('onboardDob').value = (me && me.dob) || '';
  const bioField = document.getElementById('onboardBio');
  if (bioField) {
    bioField.value = (me && me.bio) || '';
    document.getElementById('onboardBioCounter').textContent = bioField.value.length + ' / 160';
  }

  onboardingState = {
    gender: (me && me.gender) || null,
    avatarFile: null,
    avatarUrl: (me && me.avatar_url) || meta.avatar_url || null,
    usernameOk: true,
    isFirstTime: !(me && me.onboarded)
  };
  document.querySelectorAll('.gender-chip').forEach(c =>
    c.classList.toggle('active', c.dataset.gender === onboardingState.gender));
  document.getElementById('onboardMsg').textContent = '';
  document.getElementById('onboardUsernameStatus').textContent = '';

  // Show/hide skip button based on whether onboarding is required
  const closeBtn = document.getElementById('onboardCloseBtn');
  if (closeBtn) closeBtn.style.display = onboardingState.isFirstTime ? 'none' : 'block';

  document.body.classList.add('modal-open');
  m.classList.add('open');
}

function closeOnboardingModal() {
  const m = document.getElementById('onboardModal');
  if (m) m.classList.remove('open');
  document.body.classList.remove('modal-open');
}

function initOnboardingHandlers() {
  // Avatar file picker
  const fileInput = document.getElementById('onboardAvatarFile');
  if (fileInput) {
    fileInput.addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        document.getElementById('onboardMsg').textContent = 'Image must be under 5 MB.';
        return;
      }
      onboardingState.avatarFile = file;
      const reader = new FileReader();
      reader.onload = ev => {
        document.getElementById('onboardAvatarPreview').src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Gender chips
  document.querySelectorAll('.gender-chip').forEach(c => {
    c.addEventListener('click', () => {
      onboardingState.gender = c.dataset.gender;
      document.querySelectorAll('.gender-chip').forEach(x =>
        x.classList.toggle('active', x === c));
    });
  });

  // Username live availability check (debounced)
  const userInput = document.getElementById('onboardUsername');
  const userStatus = document.getElementById('onboardUsernameStatus');
  let usernameTimer = null;
  if (userInput) {
    userInput.addEventListener('input', () => {
      const v = userInput.value.trim();
      userStatus.textContent = '';
      userStatus.className = 'onboard-status';
      onboardingState.usernameOk = false;
      if (!v) return;
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(v)) {
        userStatus.textContent = 'invalid';
        userStatus.classList.add('err');
        return;
      }
      clearTimeout(usernameTimer);
      userStatus.textContent = 'checking…';
      usernameTimer = setTimeout(async () => {
        const ok = await PopChatsDB.isUsernameAvailable(v.toLowerCase(), me && me.id);
        if (userInput.value.trim() !== v) return; // stale
        onboardingState.usernameOk = ok;
        userStatus.textContent = ok ? 'available' : 'taken';
        userStatus.classList.add(ok ? 'ok' : 'err');
      }, 350);
    });
  }

  // Submit
  const submitBtn = document.getElementById('onboardSubmit');
  if (submitBtn) submitBtn.addEventListener('click', submitOnboarding);

  // Bio counter
  const bioField = document.getElementById('onboardBio');
  const bioCounter = document.getElementById('onboardBioCounter');
  if (bioField && bioCounter) {
    bioField.addEventListener('input', () => {
      bioCounter.textContent = bioField.value.length + ' / 160';
    });
  }

  // Close button (only shown when editing existing profile)
  const closeBtn = document.getElementById('onboardCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeOnboardingModal);

  // Tap outside to close (only when NOT first-time onboarding)
  const modal = document.getElementById('onboardModal');
  if (modal) modal.addEventListener('click', e => {
    if (e.target === modal && !onboardingState.isFirstTime) closeOnboardingModal();
  });
}

async function submitOnboarding() {
  const msgEl = document.getElementById('onboardMsg');
  const submitBtn = document.getElementById('onboardSubmit');
  msgEl.textContent = '';
  msgEl.style.color = '#c14040';

  const username = document.getElementById('onboardUsername').value.trim().toLowerCase();
  const fullName = document.getElementById('onboardFullName').value.trim();
  const dob      = document.getElementById('onboardDob').value || null;
  const gender   = onboardingState.gender;
  const bio      = (document.getElementById('onboardBio').value || '').trim();

  if (!username || !/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
    msgEl.textContent = 'Enter a valid username (3–24 chars, letters/numbers/_).';
    return;
  }
  if (!fullName) {
    msgEl.textContent = 'Enter your full name.';
    return;
  }
  if (!onboardingState.usernameOk && username !== (me && me.username)) {
    msgEl.textContent = 'Pick an available username.';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';
  try {
    let avatarUrl = onboardingState.avatarUrl;
    if (onboardingState.avatarFile) {
      msgEl.style.color = '#9a9488';
      msgEl.textContent = 'Uploading photo…';
      avatarUrl = await PopChatsDB.uploadAvatar(onboardingState.avatarFile);
    }
    const patch = {
      username,
      full_name: fullName,
      display_name: fullName,
      dob,
      gender,
      bio: bio || null,
      onboarded: true
    };
    if (avatarUrl) patch.avatar_url = avatarUrl;

    me = await PopChatsDB.updateMyProfile(patch);
    closeOnboardingModal();
    refreshProfileScreen();
    toast('Profile saved!');
  } catch (e) {
    console.error(e);
    msgEl.style.color = '#c14040';
    msgEl.textContent = e.message || 'Could not save profile.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Complete profile';
  }
}

// ---------- Chats-screen search (chats + users) ----------
function initChatsSearch() {
  const input = document.querySelector('#screenChats .search-bar input');
  if (!input) return;
  let searchTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    searchTimer = setTimeout(() => runChatsSearch(q), 250);
  });
}

async function runChatsSearch(q) {
  if (!chatList) return;
  if (!q) { await loadChatList(); return; }

  // Filter local chats by other-user name
  const allChats = await PopChatsDB.listMyChats();
  const lq = q.toLowerCase().replace(/^@/, '');
  const matchedChats = allChats.filter(c => {
    const o = c.other;
    if (!o) return false;
    return (o.username || '').toLowerCase().includes(lq) ||
           (o.display_name || '').toLowerCase().includes(lq) ||
           (o.full_name || '').toLowerCase().includes(lq);
  });

  // Search all users (excluding myself & those already in chats)
  const existingIds = new Set(allChats.map(c => c.other && c.other.id).filter(Boolean));
  const found = await PopChatsDB.searchProfiles(lq);
  const newUsers = found.filter(u => u.id !== (me && me.id) && !existingIds.has(u.id));

  let html = '';
  if (matchedChats.length) {
    html += '<div class="search-section-label">Your chats</div>';
    html += matchedChats.map(c => renderChatRow(c)).join('');
  }
  if (newUsers.length) {
    const states = await PopChatsDB.friendshipStatesFor(newUsers.slice(0, 10).map(u => u.id));
    html += '<div class="search-section-label">People</div>';
    html += newUsers.slice(0, 10).map(u => {
      const st = states[u.id] || 'none';
      return `
      <div class="chat-item" data-newuid="${u.id}">
        <div class="chat-avatar"><img src="${avatarOf(u)}" alt=""/></div>
        <div class="chat-info">
          <div class="chat-name">${escapeHtml(u.full_name || u.display_name || u.username)}</div>
          <div class="chat-last">@${escapeHtml(u.username)}</div>
        </div>
        <div class="chat-meta">${friendActionButtonHTML(st)}</div>
      </div>`;
    }).join('');
  }
  if (!html) {
    chatList.innerHTML =
      '<div style="padding:30px;text-align:center;color:#9a9488;font-size:13px;">' +
      'No matches.</div>';
    return;
  }
  chatList.innerHTML = html;

  // Wire new-user rows: row click is a no-op when there's a button; friend action buttons handle their own clicks
  chatList.querySelectorAll('[data-newuid] button[data-friend-act]').forEach(btn => {
    const row = btn.closest('[data-newuid]');
    const uid = row && row.dataset.newuid;
    const profile = newUsers.find(u => u.id === uid);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleFriendAction(btn.dataset.friendAct, profile, () => runChatsSearch(q));
    });
  });
  chatList.querySelectorAll('[data-newuid]').forEach(el => {
    el.addEventListener('click', () => {
      const uid = el.dataset.newuid;
      const profile = newUsers.find(u => u.id === uid);
      if (profile) openFriendSheet(profile);
    });
  });
}

function renderChatRow(c) {
  const o = c.other;
  return `
    <div class="chat-item" data-chatid="${c.id}">
      <div class="chat-avatar"><img src="${avatarOf(o)}" alt=""/></div>
      <div class="chat-info">
        <div class="chat-name">${escapeHtml((o && (o.full_name || o.display_name || o.username)) || 'Unknown')}</div>
        <div class="chat-last">${escapeHtml(c.last_text || '')}</div>
      </div>
      <div class="chat-meta"><div class="chat-time">${c.last_time ? formatTime(c.last_time) : ''}</div></div>
    </div>`;
}

// ---------- Notifications & Calls (history) ----------
async function loadNotificationsScreen() {
  const container = document.querySelector('#screenNotifications .notif-list');
  if (!container) return;
  const items = await PopChatsDB.listNotifications();
  if (!items.length) {
    container.innerHTML =
      '<div style="padding:30px;text-align:center;color:#9a9488;font-size:13px;">' +
      'No notifications yet.</div>';
    return;
  }
  container.innerHTML = items.map(n => `
    <div class="notif-item${n.read ? '' : ' unread'}">
      <div class="notif-info">
        <div class="notif-text">${escapeHtml((n.payload && n.payload.text) || n.kind || 'Notification')}</div>
        <div class="notif-time">${formatTime(n.created_at)}</div>
      </div>
      ${n.read ? '' : '<div class="notif-dot"></div>'}
    </div>
  `).join('');
}

async function loadCallsScreen() {
  const container = document.querySelector('#screenCalls .notif-list');
  if (!container || !me) return;
  const calls = await PopChatsDB.listCalls();
  if (!calls.length) {
    container.innerHTML =
      '<div style="padding:30px;text-align:center;color:#9a9488;font-size:13px;">' +
      'No calls yet.</div>';
    return;
  }
  // fetch counterparts
  const otherIds = [...new Set(calls.map(c => c.caller_id === me.id ? c.callee_id : c.caller_id))];
  const profilesMap = {};
  await Promise.all(otherIds.map(async id => { profilesMap[id] = await PopChatsDB.getProfile(id); }));
  container.innerHTML = calls.map(c => {
    const otherId = c.caller_id === me.id ? c.callee_id : c.caller_id;
    const other = profilesMap[otherId] || {};
    const arrow = c.kind === 'missed' ? 'missed' : (c.caller_id === me.id ? 'outgoing' : 'incoming');
    const sym   = arrow === 'outgoing' ? '&#8599;' : '&#8601;';
    return `
      <div class="notif-item">
        <div class="avatar"><img src="${avatarOf(other)}" alt=""/></div>
        <div class="notif-info">
          <div class="notif-text">
            <strong>${escapeHtml(other.full_name || other.display_name || other.username || 'Unknown')}</strong>
            <div class="call-meta ${arrow}">${sym} ${arrow}</div>
          </div>
          <div class="notif-time">${formatTime(c.created_at)}</div>
        </div>
      </div>`;
  }).join('');
}

// ---------- Friend requests screen ----------
function setRequestsBadge(n) {
  pendingRequestCount = n || 0;
  const badge = document.getElementById('requestsBadge');
  if (!badge) return;
  if (pendingRequestCount > 0) {
    badge.textContent = pendingRequestCount > 99 ? '99+' : String(pendingRequestCount);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

async function loadRequestsScreen() {
  const container = document.getElementById('requestsList');
  if (!container) return;
  container.innerHTML = '<div style="padding:24px;text-align:center;color:#9a9488;font-size:13px;">Loading…</div>';
  const items = await PopChatsDB.listFriendRequests();
  const incoming = items.filter(x => x.direction === 'incoming');
  const outgoing = items.filter(x => x.direction === 'outgoing');
  setRequestsBadge(incoming.length);
  document.getElementById('reqInCount').textContent  = incoming.length;
  document.getElementById('reqOutCount').textContent = outgoing.length;

  const list = activeRequestTab === 'incoming' ? incoming : outgoing;
  if (!list.length) {
    container.innerHTML =
      '<div style="padding:30px;text-align:center;color:#9a9488;font-size:13px;line-height:1.6;">' +
      (activeRequestTab === 'incoming'
        ? 'No incoming requests.<br/>When someone wants to be your friend, they\'ll show up here.'
        : 'No pending sent requests.') +
      '</div>';
    return;
  }

  container.innerHTML = list.map(r => {
    const name = escapeHtml(r.full_name || r.display_name || r.username);
    const avatar = r.avatar_url || (AVATAR_FALLBACK + encodeURIComponent(r.display_name || r.username || '?'));
    const actions = activeRequestTab === 'incoming'
      ? `<button class="req-btn ghost" data-act="decline" data-uid="${r.other_id}">Decline</button>
         <button class="req-btn primary" data-act="accept" data-uid="${r.other_id}">Accept</button>`
      : `<button class="req-btn ghost" data-act="cancel" data-uid="${r.other_id}">Cancel</button>`;
    return `
      <div class="req-card" data-uid="${r.other_id}">
        <div class="req-avatar"><img src="${avatar}" alt=""/></div>
        <div class="req-info">
          <div class="req-name">${name}</div>
          <div class="req-handle">@${escapeHtml(r.username)}</div>
          ${r.bio ? `<div class="req-bio">${escapeHtml(r.bio)}</div>` : ''}
        </div>
        <div class="req-actions">${actions}</div>
      </div>`;
  }).join('');

  container.querySelectorAll('.req-card').forEach(card => {
    const uid = card.dataset.uid;
    const profile = list.find(x => x.other_id === uid);
    // Tap card body opens friend profile sheet
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openFriendSheet({
        id: uid,
        username: profile.username,
        display_name: profile.display_name,
        full_name: profile.full_name,
        avatar_url: profile.avatar_url,
        bio: profile.bio
      });
    });
    card.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        try {
          if (act === 'accept')  {
            const chatId = await PopChatsDB.acceptFriendRequest(uid);
            toast("You're now friends with @" + (profile.username || ''));
            // animate row out
            card.style.transition = 'opacity .25s, transform .25s';
            card.style.opacity = '0';
            card.style.transform = 'translateX(20px)';
            setTimeout(async () => {
              await loadRequestsScreen();
              await loadChatList();
            }, 250);
            return;
          }
          if (act === 'decline') {
            await PopChatsDB.declineFriendRequest(uid);
            await loadRequestsScreen();
            return;
          }
          if (act === 'cancel') {
            await PopChatsDB.cancelFriendRequest(uid);
            await loadRequestsScreen();
            return;
          }
        } catch (err) { toast(err.message || 'Action failed'); }
      });
    });
  });
}

async function refreshRequestsBadge() {
  try {
    const items = await PopChatsDB.listFriendRequests();
    const incoming = items.filter(x => x.direction === 'incoming').length;
    setRequestsBadge(incoming);
  } catch (_) {}
}

// ---------- Friend Profile Sheet ----------
function openFriendSheet(profile) {
  const sheet = document.getElementById('friendSheet');
  if (!sheet || !profile) return;
  sheet.dataset.uid = profile.id || '';
  document.getElementById('friendSheetAvatar').src = avatarOf(profile);
  document.getElementById('friendSheetName').textContent =
    profile.full_name || profile.display_name || profile.username || 'Unknown';
  const handleEl = document.getElementById('friendSheetHandle');
  handleEl.textContent = '@' + (profile.username || '');
  handleEl.dataset.userId = profile.id || '';
  const bioEl = document.getElementById('friendSheetBio');
  if (profile.bio && profile.bio.trim()) {
    bioEl.textContent = profile.bio;
    bioEl.hidden = false;
  } else {
    bioEl.hidden = true;
  }
  // Reset meta + list while loading
  document.getElementById('friendSheetMeta').innerHTML = '';
  document.getElementById('friendSheetList').innerHTML = '';
  sheet.classList.add('open');
  document.body.classList.add('modal-open');

  // Load full profile + state asynchronously
  hydrateFriendSheet(profile.id);
}

async function hydrateFriendSheet(userId) {
  const [full, state] = await Promise.all([
    PopChatsDB.getProfile(userId),
    PopChatsDB.friendshipState(userId)
  ]);
  if (full) {
    document.getElementById('friendSheetAvatar').src = avatarOf(full);
    document.getElementById('friendSheetName').textContent =
      full.full_name || full.display_name || full.username || 'Unknown';
    document.getElementById('friendSheetHandle').textContent = '@' + (full.username || '');
    const bioEl = document.getElementById('friendSheetBio');
    if (full.bio && full.bio.trim()) { bioEl.textContent = full.bio; bioEl.hidden = false; }
    else { bioEl.hidden = true; }
  }

  // Meta chips
  const metaEl = document.getElementById('friendSheetMeta');
  const chips = [];
  if (full && full.online) chips.push(`<div class="fs-chip"><span class="fs-dot"></span>Online</div>`);
  if (state === 'friends') {
    const since = await PopChatsDB.friendSince(userId);
    if (since) {
      const d = new Date(since);
      const fmt = d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      chips.push(`<div class="fs-chip">Friends since ${fmt}</div>`);
    } else {
      chips.push(`<div class="fs-chip">Friends</div>`);
    }
  } else if (state === 'outgoing') {
    chips.push(`<div class="fs-chip">Request sent</div>`);
  } else if (state === 'incoming') {
    chips.push(`<div class="fs-chip">Wants to be friends</div>`);
  }
  metaEl.innerHTML = chips.join('');

  // Action buttons enabled state
  const isFriend = state === 'friends';
  document.getElementById('friendSheetMessage').disabled = !isFriend;
  document.getElementById('friendSheetCall').disabled    = !isFriend;
  document.getElementById('friendSheetVideo').disabled   = !isFriend;

  // List rows depend on state
  const listEl = document.getElementById('friendSheetList');
  let rows = '';
  if (state === 'friends') {
    rows += rowHTML('Mute notifications', 'switch', 'mute');
    rows += rowHTML('Search in conversation', 'chev', 'search');
    rows += rowHTML('Media, links, docs', 'chev', 'media');
    rows += rowHTML('Block @' + (full && full.username ? full.username : 'user'), 'danger', 'block');
    rows += rowHTML('Unfriend', 'danger', 'unfriend');
  } else if (state === 'outgoing') {
    rows += rowHTML('Cancel friend request', 'danger', 'cancel');
  } else if (state === 'incoming') {
    rows += rowHTML('Accept request', 'primary', 'accept');
    rows += rowHTML('Decline', 'danger', 'decline');
  } else if (state === 'blocked') {
    rows += rowHTML('Unblock', 'primary', 'unblock');
  } else {
    rows += rowHTML('Add friend', 'primary', 'add');
  }
  listEl.innerHTML = rows;

  listEl.querySelectorAll('button[data-row-act]').forEach(btn => {
    btn.addEventListener('click', () => handleFriendSheetAction(btn.dataset.rowAct, userId, full));
  });
}

function rowHTML(label, kind, act) {
  const cls = kind === 'danger' ? 'fs-row danger' : (kind === 'primary' ? 'fs-row primary' : 'fs-row');
  const right = kind === 'switch' ? '<span class="fs-switch"></span>'
              : kind === 'chev'   ? '<span class="fs-chev">›</span>'
              : '';
  return `<button class="${cls}" data-row-act="${act}" type="button">
    <span class="fs-row-label">${escapeHtml(label)}</span>${right}
  </button>`;
}

async function handleFriendSheetAction(act, userId, profile) {
  try {
    if (act === 'add')      { await PopChatsDB.sendFriendRequest(userId);   toast('Friend request sent'); }
    else if (act === 'cancel')   { await PopChatsDB.cancelFriendRequest(userId);  toast('Request cancelled'); }
    else if (act === 'accept')   {
      const chatId = await PopChatsDB.acceptFriendRequest(userId);
      toast("You're now friends");
      closeFriendSheet();
      await loadChatList();
      openChat(chatId, profile, false);
      return;
    }
    else if (act === 'decline')  { await PopChatsDB.declineFriendRequest(userId); toast('Declined'); }
    else if (act === 'unfriend') {
      if (!confirm('Remove this friend?')) return;
      await PopChatsDB.unfriend(userId);
      toast('Removed');
    }
    else if (act === 'block' || act === 'unblock') { toast('Coming soon'); return; }
    else if (act === 'mute' || act === 'search' || act === 'media') { toast('Coming soon'); return; }
    await hydrateFriendSheet(userId);
    if (activeChat && activeChat.other && activeChat.other.id === userId) {
      await refreshConvFriendGate();
    }
  } catch (e) { toast(e.message || 'Action failed'); }
}

function closeFriendSheet() {
  const sheet = document.getElementById('friendSheet');
  if (sheet) sheet.classList.remove('open');
  document.body.classList.remove('modal-open');
}

// ---------- Boot / auth gate ----------
let bootingAuthed = false; // false | Promise<void> while a boot is in flight

// ---------- PWA install prompt ----------
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

function maybeShowInstallPrompt() {
  // Already installed as standalone — skip
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  if (navigator.standalone) return; // iOS

  const KEY = 'popchats.installPromptAt';
  const last = localStorage.getItem(KEY);
  const now = Date.now();
  const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000;

  // Show on first login (no key) or if 5+ days since last prompt
  if (last && (now - Number(last)) < FIVE_DAYS) return;

  // Delay slightly so it doesn't compete with onboarding modal
  setTimeout(() => {
    // If native prompt is available, use it
    if (deferredInstallPrompt) {
      showInstallBanner(() => {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then(() => { deferredInstallPrompt = null; });
        localStorage.setItem(KEY, String(Date.now()));
      });
    } else {
      // Fallback: show a manual instruction banner
      showInstallBanner(null);
      localStorage.setItem(KEY, String(Date.now()));
    }
  }, 2000);
}

function showInstallBanner(onInstall) {
  // Don't show if onboarding modal is open
  if (document.getElementById('onboardModal') &&
      document.getElementById('onboardModal').classList.contains('open')) {
    setTimeout(() => showInstallBanner(onInstall), 3000);
    return;
  }
  const existing = document.getElementById('installBanner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'installBanner';
  banner.innerHTML = `
    <div class="install-banner-content">
      <img src="icon.svg" alt="" class="install-banner-icon"/>
      <div class="install-banner-text">
        <strong>Install PopChats</strong>
        <span>Add to your home screen for the best experience</span>
      </div>
      <div class="install-banner-actions">
        ${onInstall ? '<button class="install-btn-yes" type="button">Install</button>' : '<button class="install-btn-yes" type="button">Install</button>'}
        <button class="install-btn-no" type="button">Not now</button>
      </div>
    </div>`;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add('show'));

  banner.querySelector('.install-btn-no').addEventListener('click', () => {
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 300);
    localStorage.setItem('popchats.installPromptAt', String(Date.now()));
  });
  const yesBtn = banner.querySelector('.install-btn-yes');
  if (yesBtn) {
    yesBtn.addEventListener('click', () => {
      if (onInstall) {
        onInstall();
      } else {
        // No native prompt — guide user
        const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
        if (isIOS) {
          toast('Tap the Share button ↑ then "Add to Home Screen"');
        } else {
          toast('Tap your browser menu ⋮ then "Install app"');
        }
      }
      banner.classList.remove('show');
      setTimeout(() => banner.remove(), 300);
      localStorage.setItem('popchats.installPromptAt', String(Date.now()));
    });
  }
  // Auto-dismiss after 15s
  setTimeout(() => {
    if (banner.parentNode) {
      banner.classList.remove('show');
      setTimeout(() => banner.remove(), 300);
    }
  }, 15000);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout: ' + label)), ms))
  ]);
}

async function bootAuthed(user) {
  if (bootingAuthed) return bootingAuthed;
  // bootingAuthed holds the in-flight promise so concurrent callers can await it
  bootingAuthed = (async () => {
    try {
      // 1) Render chats screen immediately under the splash so the moment splash hides,
      //    the user sees a populated UI instead of a blank flash.
      showScreen('chats', 'chats');

      // 2) Kick off profile + chat list in PARALLEL (both are independent reads)
      const profilePromise = withTimeout(PopChatsDB.getMyProfile(user.id), 8000, 'getMyProfile')
        .catch(async (e) => {
          console.error('getMyProfile failed:', e);
          // Retry once without timeout (SW might have been blocking)
          try { return await PopChatsDB.getMyProfile(user.id); } catch (_) { return null; }
        });
      const chatsRenderPromise = loadChatList().catch(e => console.error('loadChatList:', e));

      me = await profilePromise;

      if (!me) {
        // No profile row — create one using auth metadata (Google: full_name, picture)
        const meta = (user && user.user_metadata) || {};
        const email = (user && user.email) || '';
        const fallbackUsername = (meta.username || email).split('@')[0]
          .replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24) || ('user_' + Date.now().toString(36));
        const fallbackName = meta.full_name || meta.name || meta.display_name || fallbackUsername;
        const fallbackAvatar = meta.avatar_url || meta.picture || null;
        try {
          me = await withTimeout(
            PopChatsDB.upsertMyProfile({
              username: fallbackUsername,
              display_name: fallbackName,
              full_name: fallbackName,
              avatar_url: fallbackAvatar
            }),
            8000, 'upsertMyProfile');
        } catch (e) { console.error('profile init failed', e); }
      } else {
        // Profile exists but may be missing data (older trigger version) — hydrate from auth metadata
        const meta = (user && user.user_metadata) || {};
        const patch = {};
        if (!me.full_name && (meta.full_name || meta.name)) patch.full_name = meta.full_name || meta.name;
        if (!me.avatar_url && (meta.avatar_url || meta.picture)) patch.avatar_url = meta.avatar_url || meta.picture;
        if (!me.display_name && (meta.full_name || meta.name)) patch.display_name = meta.full_name || meta.name;
        if (Object.keys(patch).length) {
          try {
            me = await PopChatsDB.updateMyProfile(patch);
          } catch (e) { console.error('hydrate profile failed', e); }
        }
      }

      // 3) Theme + profile rendering depends on `me`
      applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || (me && me.theme) || 'ocean', false);
      refreshProfileScreen();

      // 4) Wait for the chat list paint so splash hides on a fully-rendered screen
      await chatsRenderPromise;

      // 5) Fire-and-forget non-critical work (don't block splash)
      PopChatsDB.markOnline(true).catch(() => {});
      startOnlineHeartbeat();
      startPresenceWatcher();
      // Start listening for inbound WebRTC calls
      if (window.WebRTCCall && WebRTCCall.startInboundListener) {
        WebRTCCall.startInboundListener();
      }
      refreshRequestsBadge().catch(() => {});
      if (friendActivitySub) { PopChatsDB.unsubscribe(friendActivitySub); friendActivitySub = null; }
      if (me && me.id) {
        friendActivitySub = PopChatsDB.subscribeToFriendActivity({
          userId: me.id,
          handler: () => {
            refreshRequestsBadge();
            const sReq = document.getElementById('screenRequests');
            if (sReq && sReq.classList.contains('active')) loadRequestsScreen();
            if (activeChat) refreshConvFriendGate();
            loadChatList();
          }
        });
      }

      // GLOBAL realtime subscription — listens for messages on ALL my chats
      // Updates unread counters and shows toast notifications for non-active chats
      if (allMessagesSub) { PopChatsDB.unsubscribe(allMessagesSub); allMessagesSub = null; }
      if (messagePoller) { messagePoller.cancel(); messagePoller = null; }
      if (me && me.id) {
        // Try realtime first
        allMessagesSub = PopChatsDB.subscribeToAllMyMessages(handleIncomingMessage);
        // Always run polling as a fallback (every 5s) — handles cases where
        // realtime websocket is dropped, throttled, or blocked (mobile browsers)
        messagePoller = PopChatsDB.startMessagePolling(handleIncomingMessage, 5000);
      }
      if (me && !me.onboarded) openOnboardingModal(user);
      // PWA install prompt: first login + every 5 days
      maybeShowInstallPrompt();
      // Handle shared profile link (?user=...)
      const sharedUserId = new URLSearchParams(window.location.search).get('user');
      if (sharedUserId) {
        window.history.replaceState({}, document.title, window.location.pathname);
        try {
          const profile = await PopChatsDB.getProfile(sharedUserId);
          if (profile) openFriendSheet(profile);
        } catch (e) {
          console.error('Failed to load shared profile:', e);
        }
      }
    } catch (e) {
      console.error('bootAuthed error', e);
      showScreen('chats', 'chats');
    } finally {
      // Reset on next tick so a SIGNED_IN that fires right now still resolves
      setTimeout(() => { bootingAuthed = false; }, 0);
    }
  })();
  return bootingAuthed;
}

function bootUnauthed() {
  me = null;
  bootingAuthed = false;
  _cache.chats = null;
  _cache.messages = {};
  if (messageSub) { PopChatsDB.unsubscribe(messageSub); messageSub = null; }
  if (friendActivitySub) { PopChatsDB.unsubscribe(friendActivitySub); friendActivitySub = null; }
  if (allMessagesSub) { PopChatsDB.unsubscribe(allMessagesSub); allMessagesSub = null; }
  if (messagePoller) { messagePoller.cancel(); messagePoller = null; }
  // Clear per-user unread/read state so a different account on the same device
  // doesn't inherit stale badges or read pointers.
  try {
    localStorage.removeItem('popchats.unread');
    localStorage.removeItem('popchats.lastRead');
    localStorage.removeItem('popchats.poll.lastSeenAt');
  } catch (_) {}
  stopOnlineHeartbeat();
  stopPresenceWatcher();
  if (window.WebRTCCall && WebRTCCall.stopInboundListener) {
    WebRTCCall.stopInboundListener();
    if (WebRTCCall.isInCall()) WebRTCCall.endCall();
  }
  setRequestsBadge(0);
  showScreen('login');
}

// ---------- Init ----------
(async function init() {
  // Apply saved theme immediately (before auth)
  try {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme) applyTheme(savedTheme, false);
  } catch (_) {}

  // Conversation send
  if (sendBtn) sendBtn.addEventListener('click', sendMsg);
  if (msgInput) msgInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });

  // Back buttons
  document.getElementById('backBtn').addEventListener('click', () => {
    if (messageSub) { PopChatsDB.unsubscribe(messageSub); messageSub = null; }
    showScreen('chats', 'chats');
    loadChatList();
  });
  document.getElementById('settingsBackBtn').addEventListener('click',
    () => showScreen('profile', 'profile'));
  document.getElementById('settingsMenuItem').addEventListener('click',
    () => showScreen('settings'));

  // Share my profile
  document.getElementById('shareProfileMenuItem')?.addEventListener('click', async () => {
    if (!me || !me.id) {
      toast('Profile not loaded yet');
      return;
    }
    const shareUrl = `${window.location.origin}${window.location.pathname}?user=${me.id}`;
    const name = me.full_name || me.display_name || me.username || 'me';
    const shareText = `Connect with me (@${me.username || 'user'}) on PopChats!`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `${name} - PopChats`, text: shareText, url: shareUrl });
      } catch (e) {
        if (e.name !== 'AbortError') copyToClipboard(shareUrl);
      }
    } else {
      copyToClipboard(shareUrl);
    }
  });

  // Friend Requests screen
  const openReq = document.getElementById('openRequestsBtn');
  if (openReq) openReq.addEventListener('click', () => {
    showScreen('requests');
    activeRequestTab = 'incoming';
    document.querySelectorAll('.req-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.rtab === 'incoming'));
    loadRequestsScreen();
  });
  const reqBack = document.getElementById('requestsBackBtn');
  if (reqBack) reqBack.addEventListener('click', () => showScreen('chats', 'chats'));
  document.querySelectorAll('.req-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeRequestTab = tab.dataset.rtab;
      document.querySelectorAll('.req-tab').forEach(t =>
        t.classList.toggle('active', t === tab));
      loadRequestsScreen();
    });
  });

  // Friend profile sheet — open from chat header, close handlers
  const convFriendBtn = document.getElementById('convFriendBtn');
  if (convFriendBtn) convFriendBtn.addEventListener('click', () => {
    if (activeChat && activeChat.other) openFriendSheet(activeChat.other);
  });
  const fsClose = document.getElementById('friendSheetClose');
  if (fsClose) fsClose.addEventListener('click', closeFriendSheet);
  const fsOverlay = document.getElementById('friendSheet');
  if (fsOverlay) fsOverlay.addEventListener('click', e => {
    if (e.target === fsOverlay) closeFriendSheet();
  });
  // Sheet action buttons (Message / Audio / Video)
  const fsMsg = document.getElementById('friendSheetMessage');
  if (fsMsg) fsMsg.addEventListener('click', async () => {
    if (fsMsg.disabled) return;
    if (!activeChat || !activeChat.other) {
      // Sheet was opened from search; resolve DM
      const handle = document.getElementById('friendSheetHandle').textContent.replace('@','');
      // We don't have the user id at hand here without storing it — store it via dataset
    }
    // We do have it: friend sheet hydrate stores via dataset
    const uid = fsOverlay && fsOverlay.dataset.uid;
    if (!uid) { closeFriendSheet(); return; }
    try {
      const chatId = await PopChatsDB.getOrCreateDM(uid);
      closeFriendSheet();
      await loadChatList();
      openChat(chatId, null, false);
    } catch (e) { toast(e.message || 'Cannot open chat'); }
  });
  const fsCall  = document.getElementById('friendSheetCall');
  const fsVideo = document.getElementById('friendSheetVideo');
  if (fsCall)  fsCall.addEventListener('click', () => toast('Calls coming soon'));
  if (fsVideo) fsVideo.addEventListener('click', () => toast('Video coming soon'));
  // Esc to close sheet
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const s = document.getElementById('friendSheet');
      if (s && s.classList.contains('open')) closeFriendSheet();
    }
  });

  // Bottom nav
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.addEventListener('click', () => navTo(b.dataset.view));
  });

  // Desktop sidebar (icon rail + expanded items)
  document.querySelectorAll('.sb-icon-btn[data-view], .sb-item[data-view]').forEach(b => {
    b.addEventListener('click', () => navTo(b.dataset.view));
  });
  // Settings shortcut in sidebar (rail + panel)
  const sbSettings = document.getElementById('sbSettingsItem');
  if (sbSettings) sbSettings.addEventListener('click',
    () => showScreen('settings', 'profile'));
  const sbRailSettings = document.getElementById('sbRailSettings');
  if (sbRailSettings) sbRailSettings.addEventListener('click',
    () => showScreen('settings', 'profile'));

  // Information item (placeholder — could open about modal later)
  const sbInfoItem = document.getElementById('sbInfoItem');
  if (sbInfoItem) sbInfoItem.addEventListener('click',
    () => toast('PopChats v1.0 — built with Supabase'));
  const sbRailInfo = document.getElementById('sbRailInfo');
  if (sbRailInfo) sbRailInfo.addEventListener('click',
    () => toast('PopChats v1.0 — built with Supabase'));

  // Sign out shortcuts (rail + panel) — reuse the main signOutBtn handler
  function triggerSignOut() {
    const btn = document.getElementById('signOutBtn');
    if (btn) btn.click();
  }
  const sbRailSignOut = document.getElementById('sbRailSignOut');
  if (sbRailSignOut) sbRailSignOut.addEventListener('click', triggerSignOut);
  const sbPanelSignOut = document.getElementById('sbPanelSignOut');
  if (sbPanelSignOut) sbPanelSignOut.addEventListener('click', triggerSignOut);

  // Mini avatar (icon rail) opens profile
  const sbMiniAvatar = document.getElementById('sbMiniAvatar');
  if (sbMiniAvatar) sbMiniAvatar.addEventListener('click',
    () => navTo('profile'));
  // Bottom user card → profile
  const sbUserCard = document.getElementById('sbUserCard');
  if (sbUserCard) sbUserCard.addEventListener('click',
    () => navTo('profile'));
  // Sidebar search → reuses chats search
  const sbSearchInput = document.getElementById('sbPanelSearchInput');
  if (sbSearchInput) {
    let sbSearchTimer = null;
    sbSearchInput.addEventListener('input', () => {
      clearTimeout(sbSearchTimer);
      const q = sbSearchInput.value.trim();
      sbSearchTimer = setTimeout(() => {
        showScreen('chats', 'chats');
        runChatsSearch(q);
      }, 220);
    });
  }

  // Desktop sidebar: show panel after 2s hover on rail, hide on leave
  (function () {
    const rail = document.querySelector('.sb-rail');
    const panel = document.querySelector('.sb-panel');
    const sidebar = document.getElementById('desktopSidebar');
    if (!rail || !panel || !sidebar) return;
    let hoverTimer = null;
    let isOpen = false;

    function openPanel() {
      isOpen = true;
      document.body.classList.add('sb-pane-open');
    }
    function closePanel() {
      isOpen = false;
      document.body.classList.remove('sb-pane-open');
    }

    rail.addEventListener('mouseenter', () => {
      hoverTimer = setTimeout(openPanel, 2000);
    });
    rail.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
      // Don't close if mouse moved to panel
      setTimeout(() => {
        if (!sidebar.matches(':hover')) closePanel();
      }, 100);
    });
    panel.addEventListener('mouseleave', () => {
      // Close when mouse leaves the panel (and isn't on rail)
      setTimeout(() => {
        if (!sidebar.matches(':hover')) closePanel();
      }, 100);
    });
    // Also allow clicking a rail icon to instantly open panel
    rail.addEventListener('click', () => {
      clearTimeout(hoverTimer);
      if (!isOpen) openPanel();
    });
  })();

  // Theme cards
  document.querySelectorAll('.theme-card').forEach(c => {
    c.addEventListener('click', () => applyTheme(c.dataset.theme));
  });

  // New chat modal
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('searchUserBtn').addEventListener('click', searchUser);
  userIdInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchUser(); });
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // Stranger
  document.getElementById('randomChatBtn').addEventListener('click', startStrangerMatch);
  document.getElementById('strangerCancel').addEventListener('click', () => {
    clearTimeout(strangerTimer);
    clearInterval(strangerDotTimer);
    screenStranger.classList.remove('active');
    showScreen('chats', 'chats');
  });

  // Login form
  document.getElementById('loginGoBtn').addEventListener('click', handleAuthSubmit);
  document.getElementById('loginPassword').addEventListener('keydown',
    e => { if (e.key === 'Enter') handleAuthSubmit(); });
  initEyeToggle();

  // Onboarding modal
  initOnboardingHandlers();
  const editProfileItem = document.getElementById('editProfileMenuItem');
  if (editProfileItem) editProfileItem.addEventListener('click', () => openOnboardingModal());

  // Chats screen search
  initChatsSearch();

  // Google OAuth
  const googleBtn = document.getElementById('googleBtn');
  if (googleBtn) googleBtn.addEventListener('click', handleGoogleSignIn);

  // Verify email dialog
  const verifyOk = document.getElementById('verifyOk');
  if (verifyOk) verifyOk.addEventListener('click', closeVerifyEmailDialog);
  const verifyModal = document.getElementById('verifyModal');
  if (verifyModal) verifyModal.addEventListener('click', e => {
    if (e.target === verifyModal) closeVerifyEmailDialog();
  });

  // Forgot password
  const forgotBtn = document.getElementById('forgotBtn');
  if (forgotBtn) forgotBtn.addEventListener('click', openForgotModal);
  const forgotClose = document.getElementById('forgotClose');
  if (forgotClose) forgotClose.addEventListener('click', closeForgotModal);
  const forgotSubmit = document.getElementById('forgotSubmit');
  if (forgotSubmit) forgotSubmit.addEventListener('click', submitForgot);
  const forgotModal = document.getElementById('forgotModal');
  if (forgotModal) forgotModal.addEventListener('click', e => {
    if (e.target === forgotModal) closeForgotModal();
  });

  // Sign-out
  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', async () => {
    if (signOutBtn.dataset.busy === '1') return;
    signOutBtn.dataset.busy = '1';
    try {
      try { await PopChatsDB.markOnline(false); } catch (_) {}
      try { if (messageSub) { PopChatsDB.unsubscribe(messageSub); messageSub = null; } } catch (_) {}
      try { if (friendActivitySub) { PopChatsDB.unsubscribe(friendActivitySub); friendActivitySub = null; } } catch (_) {}
      await PopChatsAuth.signOut().catch(() => {});
      // Clear all cached data (in-memory + localStorage)
      _cache.clearAll();
      me = null;
      bootingAuthed = false;
      showScreen('login');
      // Reset login form to a clean state
      const emailIn = document.getElementById('loginEmail');
      const passIn  = document.getElementById('loginPassword');
      if (emailIn) emailIn.value = '';
      if (passIn)  passIn.value = '';
      setTab('login');
    } finally {
      signOutBtn.dataset.busy = '0';
    }
  });

  // Helper: snapshot the friend profile from the open friend-sheet for instant
  // call-UI render (avatar, name, handle), then hand off to WebRTCCall.
  function _friendFromSheet() {
    const handle = document.getElementById('friendSheetHandle');
    const name   = document.getElementById('friendSheetName');
    const avatar = document.getElementById('friendSheetAvatar');
    const id = handle && handle.dataset && handle.dataset.userId;
    if (!id) return null;
    return {
      id,
      username: handle && handle.textContent ? handle.textContent.replace(/^@/, '') : '',
      full_name: name && name.textContent ? name.textContent : '',
      display_name: name && name.textContent ? name.textContent : '',
      avatar_url: avatar && avatar.src ? avatar.src : ''
    };
  }

  // Call button handlers
  document.getElementById('friendSheetCall')?.addEventListener('click', async () => {
    const friend = _friendFromSheet();
    if (!friend) {
      toast('Cannot start call: user ID missing');
      return;
    }
    if (!window.WebRTCCall) {
      toast('Calling not available — WebRTC module failed to load');
      return;
    }
    closeFriendSheet();
    await WebRTCCall.startCall(friend, false);
  });

  document.getElementById('friendSheetVideo')?.addEventListener('click', async () => {
    const friend = _friendFromSheet();
    if (!friend) {
      toast('Cannot start call: user ID missing');
      return;
    }
    if (!window.WebRTCCall) {
      toast('Calling not available — WebRTC module failed to load');
      return;
    }
    closeFriendSheet();
    await WebRTCCall.startCall(friend, true);
  });

  document.getElementById('answerCallBtn')?.addEventListener('click', () => {
    WebRTCCall.answerCall();
  });

  document.getElementById('declineCallBtn')?.addEventListener('click', () => {
    WebRTCCall.declineCall();
  });

  document.getElementById('endCallBtn')?.addEventListener('click', () => {
    WebRTCCall.endCall();
  });

  document.getElementById('muteBtn')?.addEventListener('click', (e) => {
    const enabled = WebRTCCall.toggleMute();
    if (enabled == null) return;
    // enabled=true means audio is on (NOT muted) -> button shows "rest" (glass).
    // enabled=false means muted -> highlighted white pill, label switches to "Unmute".
    e.currentTarget.dataset.on = enabled ? 'false' : 'true';
    const label = e.currentTarget.querySelector('.call-btn-label');
    if (label) label.textContent = enabled ? 'Mute' : 'Unmute';
  });

  document.getElementById('videoBtn')?.addEventListener('click', async (e) => {
    const enabled = WebRTCCall.toggleVideo();
    if (enabled == null) {
      toast("Camera can't be toggled mid-call from voice mode");
      return;
    }
    e.currentTarget.dataset.on = enabled ? 'true' : 'false';
  });

  document.getElementById('speakerBtn')?.addEventListener('click', async (e) => {
    const isOn = e.currentTarget.dataset.on === 'true';
    const next = await WebRTCCall.toggleSpeaker(!isOn);
    if (next == null) {
      toast('Speaker switching not supported on this device');
      return;
    }
    e.currentTarget.dataset.on = next ? 'true' : 'false';
  });

  // Share profile button
  document.getElementById('friendSheetShare')?.addEventListener('click', async () => {
    const userId = document.getElementById('friendSheetHandle').dataset.userId;
    const username = document.getElementById('friendSheetHandle').textContent.replace('@', '');
    const name = document.getElementById('friendSheetName').textContent;
    
    if (!userId || !username) return;
    
    const shareUrl = `${window.location.origin}${window.location.pathname}?user=${userId}`;
    const shareText = `Check out ${name} (@${username}) on PopChats!`;
    
    if (navigator.share) {
      try {
        await navigator.share({ title: `${name} - PopChats`, text: shareText, url: shareUrl });
      } catch (e) {
        if (e.name !== 'AbortError') copyToClipboard(shareUrl);
      }
    } else {
      copyToClipboard(shareUrl);
    }
  });

  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast('Profile link copied!'));
    } else {
      const tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.style.position = 'fixed';
      tmp.style.opacity = '0';
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      document.body.removeChild(tmp);
      toast('Profile link copied!');
    }
  }

  // Auth state
  const hadOAuthCode = !!(new URLSearchParams(window.location.search).get('code'));
  const hadOAuthError = !!(new URLSearchParams(window.location.search).get('error'));
  let oauthFlowComplete = false;

  // Set up listener for FUTURE auth events (sign-in, sign-out, token refresh)
  // During OAuth callback, SIGNED_IN fires DURING the code exchange while Supabase
  // holds an internal lock — calling bootAuthed there causes API calls to hang.
  // We skip those events and rely on the explicit getSession() path below.
  PopChatsAuth.onAuthChange(async (event, session) => {
    if (event === 'INITIAL_SESSION') return; // handled explicitly below
    // Skip SIGNED_IN during OAuth flow — wait until explicit boot completes
    if (hadOAuthCode && !oauthFlowComplete && event === 'SIGNED_IN') return;
    if (event === 'TOKEN_REFRESHED') {
      // Just refresh internal token reference — DON'T reboot the UI or it will
      // reset the open chat / current screen.
      try {
        const c = window.sb;
        if (c && c.realtime && c.realtime.setAuth && session) {
          c.realtime.setAuth(session.access_token);
        }
      } catch (_) {}
      return;
    }
    if (event === 'SIGNED_IN') {
      // Only re-boot if we don't already have a user (e.g., manual sign-in)
      if (session && (!me || me.id !== session.user.id)) {
        await bootAuthed(session.user);
      }
    } else if (event === 'SIGNED_OUT') {
      bootUnauthed();
    }
  });

  // Handle OAuth callback + normal load via single path
  // Supabase's detectSessionInUrl:true auto-exchanges the code asynchronously.
  // Awaiting getSession() implicitly waits for that to complete.
  const splashWatchdog = setTimeout(() => hideOAuthSplash(), 12000);

  if (hadOAuthError) {
    // OAuth error — show splash briefly then fall through to login
    showOAuthSplash(false);
    setTimeout(() => {
      clearTimeout(splashWatchdog);
      hideOAuthSplash();
      toast('Sign-in cancelled or failed.');
      const u = new URL(window.location.href);
      u.searchParams.delete('error');
      u.searchParams.delete('error_description');
      window.history.replaceState({}, document.title, u.pathname);
      bootUnauthed();
    }, 600);
  } else {
    if (hadOAuthCode) showOAuthSplash(true);

    // This await waits for Supabase to finish initializing (incl. OAuth code exchange)
    let session;
    try {
      session = await PopChatsAuth.getSession();
    } catch (e) {
      console.error('getSession failed:', e);
    }

    // Clean URL AFTER Supabase has consumed the code
    if (hadOAuthCode) {
      const u = new URL(window.location.href);
      u.searchParams.delete('code');
      u.searchParams.delete('state');
      window.history.replaceState({}, document.title, u.pathname + u.search + u.hash);
    }

    clearTimeout(splashWatchdog);
    if (session) {
      await bootAuthed(session.user);
    } else {
      bootUnauthed();
    }
    oauthFlowComplete = true;
    hideOAuthSplash();
  }

  // Clock
  function updateClock() {
    const n = new Date();
    const el = document.getElementById('clockTime');
    if (el) el.textContent = n.getHours() + ':' + String(n.getMinutes()).padStart(2,'0');
  }
  updateClock(); setInterval(updateClock, 60000);

  // Orb parallax
  document.addEventListener('mousemove', e => {
    const x = (e.clientX / window.innerWidth - 0.5) * 15;
    const y = (e.clientY / window.innerHeight - 0.5) * 15;
    document.querySelectorAll('.orb').forEach((o, i) => {
      const f = (i + 1) * 0.4;
      o.style.transform = `translate(${x*f}px, ${y*f}px)`;
    });
  });

  // Mark offline on page hide
  window.addEventListener('beforeunload', () => {
    if (me) { PopChatsDB.markOnline(false); }
  });

  // Mark offline when tab is hidden (mobile-friendly), online again on focus
  document.addEventListener('visibilitychange', () => {
    if (!me) return;
    if (document.visibilityState === 'hidden') {
      PopChatsDB.markOnline(false).catch(() => {});
    } else {
      PopChatsDB.markOnline(true).catch(() => {});
      refreshPresence(); // immediate refresh of other users' status
    }
  });

  // Online count badge in random-chat card
  (function tickOnline() {
    const badge = document.getElementById('randomBadge');
    if (!badge) return;
    async function refresh() {
      const n = await PopChatsDB.countOnline();
      const span = badge.querySelectorAll('span')[1];
      if (span) span.textContent = (n || 0) + ' online';
    }
    refresh();
    setInterval(refresh, 8000);
  })();
})();
