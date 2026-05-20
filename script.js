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

// ---------- themes ----------
const themes = {
  lavender: { bg:'linear-gradient(135deg,#f3e7ff 0%,#ffeef8 50%,#e8e0ff 100%)',
              orb1:'rgba(212,196,251,0.8)', orb2:'rgba(248,205,218,0.7)', orb3:'rgba(224,195,252,0.6)' },
  ocean:    { bg:'linear-gradient(135deg,#e0f7fa 0%,#b2ebf2 50%,#80deea 100%)',
              orb1:'rgba(128,222,234,0.8)', orb2:'rgba(178,235,242,0.7)', orb3:'rgba(224,247,250,0.6)' },
  sunset:   { bg:'linear-gradient(135deg,#fff3e0 0%,#ffe0b2 50%,#ffcc80 100%)',
              orb1:'rgba(255,204,128,0.8)', orb2:'rgba(255,224,178,0.7)', orb3:'rgba(255,243,224,0.6)' },
};
function applyTheme(name, persist = true) {
  const t = themes[name]; if (!t) return;
  document.body.style.background = t.bg;
  const orbs = document.querySelectorAll('.orb');
  if (orbs[0]) orbs[0].style.background = t.orb1;
  if (orbs[1]) orbs[1].style.background = t.orb2;
  if (orbs[2]) orbs[2].style.background = t.orb3;
  document.querySelectorAll('.theme-card').forEach(c =>
    c.classList.toggle('active', c.dataset.theme === name));
  if (persist && me) {
    PopChatsDB.updateMyProfile({ theme: name }).catch(err => console.error(err));
    me.theme = name;
  }
}

// ---------- screen routing ----------
function setNavActive(view) {
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
}
function showScreen(name, navView) {
  [sLogin, sChats, sConv, sProfile, sSettings, sNotifications, sCalls]
    .forEach(s => s && s.classList.remove('active'));
  const map = { login:sLogin, chats:sChats, conv:sConv, profile:sProfile,
                settings:sSettings, notifications:sNotifications, calls:sCalls };
  if (map[name]) map[name].classList.add('active');
  if (navView) setNavActive(navView);
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = (name === 'login') ? 'none' : 'flex';
}

// ---------- chat list ----------
async function loadChatList() {
  if (!chatList) return;
  chatList.innerHTML = '<div style="padding:24px;text-align:center;color:#9a9488;font-size:13px;">Loading…</div>';
  const chats = await PopChatsDB.listMyChats();
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
    const name = escapeHtml(other ? (other.display_name || other.username) : 'Unknown');
    const sub  = escapeHtml(c.last_text || (c.is_stranger ? 'Stranger chat' : 'Say hi'));
    const dot  = other && other.online ? '<div class="online"></div>' : '';
    card.innerHTML =
      `<div class="avatar"><img src="${avatarOf(other)}" alt=""/></div>` +
      `<div class="chat-info">` +
        `<div class="chat-name">${name}</div>` +
        `<div class="chat-sub">${sub}</div>` +
      `</div>` +
      `<div class="chat-meta">${dot}</div>`;
    card.addEventListener('click', () => openChat(c.id, other));
    chatList.appendChild(card);
    setTimeout(() => card.classList.add('show'), i * 60);
  });
}

// ---------- conversation ----------
async function openChat(chatId, otherProfile) {
  let other = otherProfile;
  if (!other) {
    const members = await PopChatsDB.getChatMembers(chatId);
    other = members.find(m => m.id !== (me && me.id)) || null;
  }
  activeChat = { id: chatId, other };
  convAv.src = avatarOf(other);
  convAv.alt = other ? (other.display_name || other.username) : '';
  convNm.textContent = other ? (other.display_name || other.username) : 'Unknown';
  convSt.textContent = other && other.online ? 'Online' : 'Offline';
  showScreen('conv');
  await renderMessages(chatId);
  if (messageSub) { PopChatsDB.unsubscribe(messageSub); messageSub = null; }
  messageSub = PopChatsDB.subscribeToChat(chatId, (m) => appendMessage(m));
}

async function renderMessages(chatId) {
  msgBox.innerHTML = '';
  const list = await PopChatsDB.listMessages(chatId);
  list.forEach((m, i) => appendMessage(m, false, i));
  requestAnimationFrame(() => { msgBox.scrollTop = msgBox.scrollHeight; });
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
}

async function sendMsg() {
  const txt = msgInput.value.trim();
  if (!txt || !activeChat) return;
  msgInput.value = '';
  try {
    await PopChatsDB.sendMessage(activeChat.id, txt);
  } catch (e) {
    console.error(e);
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
  modalResult.innerHTML = filtered.slice(0, 5).map(u =>
    `<div class="result-card">
      <div class="result-avatar"><img src="${avatarOf(u)}" alt=""/></div>
      <div class="result-info">
        <div class="result-name">${escapeHtml(u.display_name || u.username)}</div>
        <div class="result-handle">@${escapeHtml(u.username)}</div>
      </div>
      <button class="result-start-btn" data-uid="${u.id}">Chat</button>
    </div>`
  ).join('');
  modalResult.querySelectorAll('.result-start-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.dataset.uid;
      const other = filtered.find(x => x.id === uid);
      try {
        const chatId = await PopChatsDB.getOrCreateDM(uid);
        closeModal();
        await loadChatList();
        openChat(chatId, other);
      } catch (e) {
        toast('Could not start chat: ' + (e.message || 'error'));
      }
    });
  });
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
        openChat(chatId, stranger);
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

  if (mode === 'signup') {
    loginTab.classList.remove('active');
    signupTab.classList.add('active');
    usernameWrap.style.display = 'flex';
    if (forgotBtn) forgotBtn.style.display = 'none';
    signupLink.textContent = 'Log in';
    signupLink.setAttribute('onclick', "setTab('login')");
    disclaimer.textContent = 'By signing up you agree to our terms and privacy policy.';
    consumeText.textContent = 'Join the conversation!';
  } else {
    loginTab.classList.add('active');
    signupTab.classList.remove('active');
    usernameWrap.style.display = 'none';
    if (forgotBtn) forgotBtn.style.display = '';
    signupLink.textContent = 'Sign up';
    signupLink.setAttribute('onclick', "setTab('signup')");
    disclaimer.textContent = 'Connect with people around you. By continuing you agree to our terms and privacy policy.';
    consumeText.textContent = 'Please chat responsibly!';
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
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) { shakeLogin(); return; }
  const goBtn = document.getElementById('loginGoBtn');
  goBtn.disabled = true;
  try {
    if (loginMode === 'signup') {
      const username = document.getElementById('loginUsername').value.trim();
      if (!username) { shakeLogin(); goBtn.disabled = false; return; }
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        toast('Username: 3–24 chars, letters/numbers/underscore.');
        shakeLogin();
        goBtn.disabled = false;
        return;
      }
      const res = await PopChatsAuth.signUp(email, password, username);
      if (res.error) throw res.error;
      if (!res.data.session) {
        showVerifyEmailDialog(email);
        setTab('login');
        return;
      }
      await bootAuthed(res.data.user);
    } else {
      const res = await PopChatsAuth.signIn(email, password);
      if (res.error) throw res.error;
      if (res.data && res.data.user) await bootAuthed(res.data.user);
    }
  } catch (e) {
    toast(e.message || 'Authentication failed');
    shakeLogin();
  } finally {
    goBtn.disabled = false;
  }
}

// ---------- Google OAuth ----------
async function handleGoogleSignIn() {
  try {
    const { error } = await window.sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.POPCHATS_SITE_URL }
    });
    if (error) throw error;
  } catch (e) {
    toast(e.message || 'Google sign-in failed');
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

  onboardingState = {
    gender: (me && me.gender) || null,
    avatarFile: null,
    avatarUrl: (me && me.avatar_url) || meta.avatar_url || null,
    usernameOk: true
  };
  document.querySelectorAll('.gender-chip').forEach(c =>
    c.classList.toggle('active', c.dataset.gender === onboardingState.gender));
  document.getElementById('onboardMsg').textContent = '';
  document.getElementById('onboardUsernameStatus').textContent = '';

  m.classList.add('open');
}

function closeOnboardingModal() {
  const m = document.getElementById('onboardModal');
  if (m) m.classList.remove('open');
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
    html += '<div class="search-section-label">People</div>';
    html += newUsers.slice(0, 10).map(u => `
      <div class="chat-item" data-newuid="${u.id}">
        <div class="chat-avatar"><img src="${avatarOf(u)}" alt=""/></div>
        <div class="chat-info">
          <div class="chat-name">${escapeHtml(u.full_name || u.display_name || u.username)}</div>
          <div class="chat-last">@${escapeHtml(u.username)}</div>
        </div>
        <div class="chat-meta"><div class="chat-start-pill">Start</div></div>
      </div>`).join('');
  }
  if (!html) {
    chatList.innerHTML =
      '<div style="padding:30px;text-align:center;color:#9a9488;font-size:13px;">' +
      'No matches.</div>';
    return;
  }
  chatList.innerHTML = html;

  // Wire new-user rows
  chatList.querySelectorAll('[data-newuid]').forEach(el => {
    el.addEventListener('click', async () => {
      const uid = el.dataset.newuid;
      const profile = newUsers.find(u => u.id === uid);
      try {
        const chatId = await PopChatsDB.getOrCreateDM(uid);
        await loadChatList();
        openChat(chatId, profile);
      } catch (e) {
        toast('Could not start chat: ' + (e.message || 'error'));
      }
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
            <strong>${escapeHtml(other.display_name || other.username || 'Unknown')}</strong>
            <div class="call-meta ${arrow}">${sym} ${arrow}</div>
          </div>
          <div class="notif-time">${formatTime(c.created_at)}</div>
        </div>
      </div>`;
  }).join('');
}

// ---------- Boot / auth gate ----------
let bootingAuthed = false;
async function bootAuthed(user) {
  if (bootingAuthed) {
    showScreen('chats', 'chats');
    return;
  }
  bootingAuthed = true;
  try {
    me = await PopChatsDB.getMyProfile();
    if (!me) {
      const fallbackUsername = ((user && user.email) || 'user_' + Date.now()).split('@')[0]
        .replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24);
      try {
        me = await PopChatsDB.upsertMyProfile({ username: fallbackUsername, display_name: fallbackUsername });
      } catch (e) { console.error('profile init failed', e); }
    }
    try { await PopChatsDB.markOnline(true); } catch (e) { console.error(e); }
    applyTheme(me && me.theme ? me.theme : 'lavender', false);
    showScreen('chats', 'chats');
    await loadChatList();
    refreshProfileScreen();
    // First-time login: prompt for full profile
    if (me && !me.onboarded) openOnboardingModal(user);
  } catch (e) {
    console.error('bootAuthed error', e);
    showScreen('chats', 'chats');
  } finally {
    bootingAuthed = false;
  }
}

function bootUnauthed() {
  me = null;
  if (messageSub) { PopChatsDB.unsubscribe(messageSub); messageSub = null; }
  showScreen('login');
}

// ---------- Init ----------
(async function init() {
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

  // Bottom nav
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.addEventListener('click', () => {
      const v = b.dataset.view;
      setNavActive(v);
      if (v === 'chats')         { showScreen('chats', 'chats'); loadChatList(); }
      else if (v === 'profile')  { showScreen('profile', 'profile'); refreshProfileScreen(); }
      else if (v === 'notifications') { showScreen('notifications', 'notifications'); loadNotificationsScreen(); }
      else if (v === 'calls')    { showScreen('calls', 'calls'); loadCallsScreen(); }
      else if (v === 'add')      openModal();
    });
  });

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
      const { error } = await PopChatsAuth.signOut();
      if (error) {
        console.error('signOut error', error);
        toast(error.message || 'Sign out failed');
      }
      // Force unauth state immediately — don't depend on auth listener
      me = null;
      try {
        Object.keys(localStorage)
          .filter(k => k.startsWith('sb-') || k.startsWith('supabase'))
          .forEach(k => localStorage.removeItem(k));
      } catch (_) {}
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

  // Auth state
  PopChatsAuth.onAuthChange(async (event, session) => {
    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') {
      if (session) await bootAuthed(session.user); else bootUnauthed();
    } else if (event === 'SIGNED_OUT') {
      bootUnauthed();
    } else if (event === 'PASSWORD_RECOVERY') {
      // Reset flow lives on reset.html; ignore here.
    }
  });

  // Handle OAuth callback (?code=...) — manual PKCE exchange in case auto-detect missed it
  const urlObj = new URL(window.location.href);
  const oauthCode = urlObj.searchParams.get('code');
  if (oauthCode) {
    try {
      const { data, error } = await window.sb.auth.exchangeCodeForSession(window.location.href);
      if (error) {
        console.error('[OAuth] exchange failed:', error);
        toast('Sign-in failed: ' + error.message);
      } else if (data && data.session) {
        // Clean URL (remove ?code & ?state)
        urlObj.searchParams.delete('code');
        urlObj.searchParams.delete('state');
        window.history.replaceState({}, document.title, urlObj.pathname + urlObj.search + urlObj.hash);
        await bootAuthed(data.session.user);
        return; // skip the getSession check below; we just booted
      }
    } catch (e) {
      console.error('[OAuth] exchange threw:', e);
    }
  }

  const session = await PopChatsAuth.getSession();
  if (session) await bootAuthed(session.user);
  else bootUnauthed();

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
