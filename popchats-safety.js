// PopChats — safety & privacy enhancements (loaded via supabase-config.js)
// 1) Stranger chats show username only (real/full name hidden)
// 2) Calls gated to friends (server also enforces via migration 019). The call
//    icon stays visible; a non-friend tap shows a friendly toast instead.
// 3) Profile-picture uploads are scanned by the moderate-avatar Edge Function
// 4) Delete-account UI wired to the delete-account Edge Function
(function () {
  'use strict';

  // ---------- tiny toast ----------
  function toast(text) {
    var t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#1a1a18;color:#fff;padding:12px 18px;border-radius:14px;font-size:13px;font-family:Geist,system-ui,sans-serif;z-index:99999;box-shadow:0 8px 30px rgba(0,0,0,0.3);max-width:80%;text-align:center;opacity:0;transition:opacity .2s;';
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 250); }, 2600);
  }

  function maskStranger(p) {
    if (!p) return p;
    var uname = p.username || p.display_name || 'stranger';
    return Object.assign({}, p, { full_name: uname, display_name: uname });
  }

  function wrapDB() {
    if (!window.PopChatsDB) return false;
    if (window.PopChatsDB.__safetyWrapped) return true;
    var D = window.PopChatsDB;
    D.__safetyWrapped = true;

    // Stranger chat list: hide real name
    if (typeof D.listMyChats === 'function') {
      var _list = D.listMyChats.bind(D);
      D.listMyChats = async function () {
        var chats = await _list.apply(null, arguments);
        (chats || []).forEach(function (c) {
          if (c && c.is_stranger && c.other) c.other = maskStranger(c.other);
        });
        return chats;
      };
    }

    // Stranger conversation header: hide real name
    if (typeof D.getChatMembers === 'function') {
      var _members = D.getChatMembers.bind(D);
      D.getChatMembers = async function (chatId) {
        var members = await _members(chatId);
        try {
          if (window.sb && chatId) {
            var res = await window.sb.from('chats').select('is_stranger').eq('id', chatId).maybeSingle();
            var isStranger = res && res.data && res.data.is_stranger;
            if (isStranger && Array.isArray(members)) {
              var myId = (window.me && window.me.id) || null;
              return members.map(function (m) { return (m && m.id !== myId) ? maskStranger(m) : m; });
            }
          }
        } catch (e) {}
        return members;
      };
    }

    // Profile-picture moderation: scan each avatar after upload; reject on block
    if (typeof D.uploadAvatar === 'function') {
      var _upload = D.uploadAvatar.bind(D);
      D.uploadAvatar = async function (file) {
        var url = await _upload(file);
        try {
          var marker = '/object/public/avatars/';
          var path = (url && url.indexOf(marker) !== -1) ? url.split(marker)[1] : null;
          if (path && window.sb) {
            var sess = await window.sb.auth.getSession();
            var token = sess && sess.data && sess.data.session && sess.data.session.access_token;
            if (token) {
              var res = await fetch(window.SUPABASE_URL + '/functions/v1/moderate-avatar', {
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer ' + token,
                  'apikey': window.SUPABASE_PUBLISHABLE_KEY,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ path: path })
              });
              if (res.ok) {
                var out = await res.json().catch(function () { return null; });
                if (out && out.allowed === false) {
                  throw new Error('MODERATION_BLOCKED');
                }
              }
              // If the function is not deployed yet (e.g. 404) we do not block.
            }
          }
        } catch (e) {
          if (e && e.message === 'MODERATION_BLOCKED') {
            toast('That photo was rejected. Please choose another one.');
            throw new Error('This image was rejected by moderation. Please choose another photo.');
          }
          // Network/other errors: do not hard-block the avatar upload.
        }
        return url;
      };
    }

    return true;
  }

  function wrapCalls() {
    if (!window.WebRTCCall) return false;
    if (window.WebRTCCall.__safetyWrapped) return true;
    var W = window.WebRTCCall;
    W.__safetyWrapped = true;
    if (typeof W.startCall === 'function') {
      var _start = W.startCall.bind(W);
      W.startCall = async function (friendOrId, video) {
        try {
          var otherId = (friendOrId && typeof friendOrId === 'object') ? friendOrId.id : friendOrId;
          if (otherId && window.PopChatsDB && window.PopChatsDB.friendshipState) {
            var state = await window.PopChatsDB.friendshipState(otherId);
            if (state !== 'friends') {
              toast('Only friends can call. Send a friend request first.');
              return false;
            }
          }
        } catch (e) {}
        return _start(friendOrId, video);
      };
    }
    return true;
  }

  var tries = 0;
  var iv = setInterval(function () {
    var a = wrapDB();
    var b = wrapCalls();
    if ((a && b) || ++tries > 150) clearInterval(iv);
  }, 20);

  function injectDeleteUI() {
    if (document.getElementById('deleteAccountItem')) return;
    var signOut = document.getElementById('signOutBtn');
    if (!signOut || !signOut.parentNode) return;

    var item = document.createElement('div');
    item.className = 'menu-item';
    item.id = 'deleteAccountItem';
    item.innerHTML = `<div class='menu-item-left'><div class='menu-icon' style='color:#c14040;'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><polyline points='3 6 5 6 21 6'/><path d='M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'/><path d='M10 11v6M14 11v6'/><path d='M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2'/></svg></div><span class='menu-label' style='color:#c14040;'>Delete account</span></div><svg class='menu-chevron' viewBox='0 0 24 24'><polyline points='9 18 15 12 9 6'/></svg>`;
    signOut.parentNode.insertBefore(item, signOut.nextSibling);

    var modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'deleteAccountModal';
    modal.style.zIndex = '1400';
    modal.innerHTML = `<div class='modal-sheet' style='max-width:340px;padding:28px 24px 24px;text-align:center;'><div class='modal-handle'></div><div style='width:60px;height:60px;margin:4px auto 14px;background:#f9e3e3;border-radius:50%;display:flex;align-items:center;justify-content:center;'><svg viewBox='0 0 24 24' fill='none' stroke='#c14040' stroke-width='2' style='width:28px;height:28px;'><path d='M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'/><line x1='12' y1='9' x2='12' y2='13'/><line x1='12' y1='17' x2='12.01' y2='17'/></svg></div><h2 style='font-size:18px;margin-bottom:8px;color:#1a1a18;'>Delete your account?</h2><p style='font-size:13px;color:#6b665d;line-height:1.55;margin-bottom:16px;'>This permanently deletes your profile, messages, friends and photos. It cannot be undone. Type DELETE to confirm.</p><div class='login-input-wrap' style='margin-bottom:12px;'><input type='text' id='deleteConfirmInput' placeholder='Type DELETE' autocomplete='off' autocapitalize='characters'/></div><button class='login-submit-btn' id='deleteConfirmBtn' style='margin-top:2px;background:#c14040;'>Delete forever</button><p id='deleteMsg' style='font-size:12px;color:#9a9488;text-align:center;margin-top:12px;min-height:16px;'></p><button id='deleteCancelBtn' style='display:block;margin:6px auto 0;background:none;border:none;font-size:13px;color:#9a9488;cursor:pointer;'>Cancel</button></div>`;
    document.body.appendChild(modal);

    function openModal() { modal.classList.add('active'); modal.style.display = 'flex'; }
    function closeModal() {
      modal.classList.remove('active'); modal.style.display = 'none';
      var i = document.getElementById('deleteConfirmInput'); if (i) i.value = '';
      var m = document.getElementById('deleteMsg'); if (m) m.textContent = '';
    }
    closeModal();

    item.addEventListener('click', openModal);
    document.getElementById('deleteCancelBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

    document.getElementById('deleteConfirmBtn').addEventListener('click', async function () {
      var input = document.getElementById('deleteConfirmInput');
      var msg = document.getElementById('deleteMsg');
      if (!input || input.value.trim().toUpperCase() !== 'DELETE') {
        if (msg) msg.textContent = 'Please type DELETE to confirm.';
        return;
      }
      if (msg) msg.textContent = 'Deleting your account…';
      try {
        var sess = await window.sb.auth.getSession();
        var token = sess && sess.data && sess.data.session && sess.data.session.access_token;
        if (!token) { if (msg) msg.textContent = 'You are not signed in.'; return; }
        var res = await fetch(window.SUPABASE_URL + '/functions/v1/delete-account', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'apikey': window.SUPABASE_PUBLISHABLE_KEY,
            'Content-Type': 'application/json'
          }
        });
        if (!res.ok) {
          var t = await res.text().catch(function () { return ''; });
          if (msg) msg.textContent = 'Failed: ' + (t || ('HTTP ' + res.status));
          return;
        }
        try { if (window.PopChatsAuth) await window.PopChatsAuth.signOut(); } catch (e) {}
        location.href = '/';
      } catch (e) {
        if (msg) msg.textContent = 'Error: ' + (e && e.message ? e.message : e);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectDeleteUI);
  } else {
    injectDeleteUI();
  }
  document.addEventListener('click', function () { setTimeout(injectDeleteUI, 60); }, true);
})();
