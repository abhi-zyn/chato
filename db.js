// PopChats — Data layer (profiles, chats, messages, realtime)
window.PopChatsDB = (function () {
  function client() { return window.sb; }

  // Read session directly from localStorage to bypass supabase-js auth lock
  function getSessionSync() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('sb-') && k.includes('auth-token')) {
          const raw = localStorage.getItem(k);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (parsed.access_token) return parsed;
          if (parsed.currentSession) return parsed.currentSession;
        }
      }
    } catch (e) {}
    return null;
  }

  function getSessionTokenSync() {
    const s = getSessionSync();
    return s ? s.access_token : null;
  }

  function getUserIdSync() {
    const s = getSessionSync();
    return s && s.user ? s.user.id : null;
  }

  // Direct fetch helper - bypasses supabase-js client lock issues
  async function rawSelect(table, query) {
    const token = getSessionTokenSync();
    if (!token) return { data: null, error: new Error('no session') };
    try {
      const url = `${window.SUPABASE_URL}/rest/v1/${table}?${query}`;
      const res = await fetch(url, {
        headers: {
          'apikey': window.SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      });
      if (!res.ok) {
        return { data: null, error: new Error(`HTTP ${res.status}`) };
      }
      return { data: await res.json(), error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  }

  async function uid() {
    // Prefer sync read from localStorage (no lock contention)
    const syncId = getUserIdSync();
    if (syncId) return syncId;
    // Fallback to client (slow path)
    try {
      const { data } = await client().auth.getUser();
      return data.user ? data.user.id : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- profiles ----------
  async function getMyProfile(userId) {
    const id = userId || await uid(); 
    if (!id) return null;
    
    // Use raw fetch to bypass any client-side auth lock issues
    const token = getSessionTokenSync();
    if (token) {
      try {
        const url = `${window.SUPABASE_URL}/rest/v1/profiles?id=eq.${id}&select=*`;
        const res = await fetch(url, {
          headers: {
            'apikey': window.SUPABASE_PUBLISHABLE_KEY,
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });
        if (res.ok) {
          const arr = await res.json();
          return Array.isArray(arr) && arr.length ? arr[0] : null;
        }
        console.error('[getMyProfile] HTTP', res.status);
      } catch (e) {
        console.error('[getMyProfile] fetch error:', e);
      }
    }
    
    // Fallback to client query (slower but more reliable)
    try {
      const { data, error } = await client().from('profiles').select('*').eq('id', id).maybeSingle();
      if (error) console.error('[getMyProfile] client error:', error);
      return data;
    } catch (e) {
      console.error('[getMyProfile] all failed:', e);
      return null;
    }
  }

  async function upsertMyProfile(patch) {
    const id = await uid(); if (!id) return null;
    const { data, error } = await client().from('profiles').upsert({ id, ...patch }).select().single();
    if (error) throw error;
    return data;
  }

  async function updateMyProfile(patch) {
    const id = await uid(); if (!id) return null;
    const { data, error } = await client().from('profiles').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async function getProfile(userId) {
    const { data, error } = await client().from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) console.error('[getProfile]', error);
    return data;
  }

  async function searchProfiles(q) {
    const safe = String(q).replace(/[%,]/g, '');
    const { data, error } = await client().from('profiles')
      .select('*')
      .or(`username.ilike.%${safe}%,display_name.ilike.%${safe}%`)
      .limit(10);
    if (error) { console.error('[searchProfiles]', error); return []; }
    return data || [];
  }

  async function markOnline(online) {
    const id = getUserIdSync();
    if (!id) return;
    const token = getSessionTokenSync();
    if (!token) return;
    // Use raw fetch to avoid client lock issues
    try {
      const url = `${window.SUPABASE_URL}/rest/v1/profiles?id=eq.${id}`;
      await fetch(url, {
        method: 'PATCH',
        headers: {
          'apikey': window.SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          online: !!online,
          last_seen: new Date().toISOString()
        })
      });
    } catch (e) {
      console.error('[markOnline]', e);
    }
  }

  // Get last_seen for a list of user IDs (used to compute "online" status)
  async function getPresence(userIds) {
    if (!userIds || !userIds.length) return {};
    const ids = `(${userIds.join(',')})`;
    const r = await rawSelect('profiles', `id=in.${ids}&select=id,online,last_seen`);
    if (r.error || !r.data) return {};
    const out = {};
    const now = Date.now();
    r.data.forEach(p => {
      const last = p.last_seen ? new Date(p.last_seen).getTime() : 0;
      // Consider user online if explicitly online OR last_seen within 45s
      const isOnline = p.online === true && (now - last) < 45000;
      out[p.id] = { online: isOnline, last_seen: p.last_seen };
    });
    return out;
  }

  async function countOnline() {
    const { count, error } = await client().from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('online', true);
    if (error) return 0;
    return count || 0;
  }

  // ---------- avatar upload ----------
  async function uploadAvatar(file) {
    const id = await uid(); if (!id) throw new Error('Not signed in');
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${id}/avatar_${Date.now()}.${ext}`;
    const { error: upErr } = await client().storage.from('avatars').upload(path, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type || undefined
    });
    if (upErr) throw upErr;
    const { data: pub } = client().storage.from('avatars').getPublicUrl(path);
    return pub.publicUrl;
  }

  async function isUsernameAvailable(username, exceptId) {
    const q = client().from('profiles').select('id').eq('username', username).limit(1);
    const { data } = await q;
    if (!data || !data.length) return true;
    if (exceptId && data[0].id === exceptId) return true;
    return false;
  }

  async function emailExists(email) {
    const { data, error } = await client().rpc('email_exists', { p_email: email });
    if (error) { console.error('[emailExists]', error); return null; }
    return !!data;
  }

  // ---------- friendships ----------
  async function friendshipState(otherId) {
    const id = await uid(); if (!id || id === otherId) return 'self';
    const { data, error } = await client().rpc('friendship_state', { other: otherId });
    if (error) { console.error('[friendshipState]', error); return 'none'; }
    return data || 'none';
  }

  // Returns { uid: 'none' | 'outgoing' | 'incoming' | 'friends' | 'declined' | 'blocked' | 'self' }
  async function friendshipStatesFor(otherIds) {
    if (!otherIds || !otherIds.length) return {};
    const { data, error } = await client().rpc('friendship_states_for', { other_ids: otherIds });
    if (error) { console.error('[friendshipStatesFor]', error); return {}; }
    const out = {};
    (data || []).forEach(r => { out[r.other_id] = r.state; });
    return out;
  }

  async function sendFriendRequest(otherId) {
    const { data, error } = await client().rpc('send_friend_request', { other: otherId });
    if (error) throw error;
    return data; // 'pending' | 'friends'
  }

  async function acceptFriendRequest(otherId) {
    const { data, error } = await client().rpc('accept_friend_request', { other: otherId });
    if (error) throw error;
    return data; // chat_id
  }

  async function declineFriendRequest(otherId) {
    const { error } = await client().rpc('decline_friend_request', { other: otherId });
    if (error) throw error;
  }

  async function cancelFriendRequest(otherId) {
    const { error } = await client().rpc('cancel_friend_request', { other: otherId });
    if (error) throw error;
  }

  async function unfriend(otherId) {
    const { error } = await client().rpc('unfriend', { other: otherId });
    if (error) throw error;
  }

  async function listFriendRequests() {
    const { data, error } = await client().rpc('list_friend_requests');
    if (error) { console.error('[listFriendRequests]', error); return []; }
    return data || [];
  }

  async function listFriends() {
    const { data, error } = await client().rpc('list_friends');
    if (error) { console.error('[listFriends]', error); return []; }
    return data || [];
  }

  async function friendSince(otherId) {
    const { data, error } = await client().rpc('friend_since', { other: otherId });
    if (error) { console.error('[friendSince]', error); return null; }
    return data || null;
  }

  // Realtime: friend-request inbox + accepted notifications
  function subscribeToFriendActivity(onChange) {
    const id = (typeof onChange === 'object' ? onChange.userId : null);
    const handler = (typeof onChange === 'function' ? onChange : onChange.handler);
    const ch = client()
      .channel('friend-activity')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' },
          (payload) => handler && handler(payload))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications',
                                filter: id ? ('user_id=eq.' + id) : undefined },
          (payload) => {
            const k = payload.new && payload.new.kind;
            if (k === 'friend_request' || k === 'friend_accepted') handler && handler(payload);
          })
      .subscribe();
    return ch;
  }

  // ---------- chats ----------
  async function listMyChats() {
    const id = getUserIdSync();
    if (!id) return [];

    // Use raw fetch for all queries to bypass supabase-js client lock
    const m1 = await rawSelect('chat_members', `user_id=eq.${id}&select=chat_id`);
    if (m1.error) { console.error('[listMyChats memberships]', m1.error); return []; }
    const chatIds = (m1.data || []).map(m => m.chat_id);
    if (!chatIds.length) return [];
    const inList = `(${chatIds.join(',')})`;

    const m2 = await rawSelect('chats', `id=in.${inList}&select=*`);
    if (m2.error) { console.error('[listMyChats chats]', m2.error); return []; }
    const chats = m2.data || [];

    const m3 = await rawSelect('chat_members', `chat_id=in.${inList}&select=chat_id,user_id`);
    const allMembers = m3.data || [];

    const otherIds = [...new Set(allMembers
      .filter(m => m.user_id !== id).map(m => m.user_id))];

    let profiles = [];
    if (otherIds.length) {
      const p = await rawSelect('profiles', `id=in.(${otherIds.join(',')})&select=*`);
      profiles = p.data || [];
    }
    const profileMap = Object.fromEntries(profiles.map(p => [p.id, p]));

    const m4 = await rawSelect('messages', 
      `chat_id=in.${inList}&select=chat_id,text,text_enc,created_at&order=created_at.desc`);
    let msgsList = m4.data;
    if (m4.error) {
      // Fallback if text_enc column doesn't exist
      const m4b = await rawSelect('messages',
        `chat_id=in.${inList}&select=chat_id,text,created_at&order=created_at.desc`);
      msgsList = m4b.data || [];
    }
    const lastMsg = {};
    (msgsList || []).forEach(m => { if (!lastMsg[m.chat_id]) lastMsg[m.chat_id] = m; });

    // Decrypt previews for any encrypted last-messages (in parallel)
    const encChatIds = Object.entries(lastMsg)
      .filter(([, m]) => m && m.text_enc)
      .map(([cid]) => cid);
    if (encChatIds.length) {
      await Promise.all(encChatIds.map(async (cid) => {
        try {
          const preview = await lastMessagePreview(cid);
          if (preview) lastMsg[cid] = { ...lastMsg[cid], text: preview.text };
        } catch (_) {}
      }));
    }

    return chats.map(c => {
      const others = (allMembers || [])
        .filter(m => m.chat_id === c.id && m.user_id !== id)
        .map(m => profileMap[m.user_id])
        .filter(Boolean);
      const last = lastMsg[c.id];
      return {
        ...c,
        other: others[0] || null,
        last_text: last ? last.text : '',
        last_time: last ? last.created_at : c.created_at
      };
    })
    // Dedupe DM chats by other-user id: keep the most recent one per user.
    .reduce((acc, chat) => {
      // Keep stranger chats untouched (each is its own session)
      if (chat.is_stranger || !chat.other) {
        acc.push(chat);
        return acc;
      }
      const key = chat.other.id;
      const existingIdx = acc.findIndex(c =>
        !c.is_stranger && c.other && c.other.id === key);
      if (existingIdx === -1) {
        acc.push(chat);
      } else {
        // Keep the newest by last_time
        if (new Date(chat.last_time) > new Date(acc[existingIdx].last_time)) {
          acc[existingIdx] = chat;
        }
      }
      return acc;
    }, [])
    .sort((a, b) => new Date(b.last_time) - new Date(a.last_time));
  }

  async function getChatMembers(chatId) {
    const { data: members } = await client()
      .from('chat_members').select('user_id').eq('chat_id', chatId);
    if (!members || !members.length) return [];
    const ids = members.map(m => m.user_id);
    const { data: profiles } = await client().from('profiles').select('*').in('id', ids);
    return profiles || [];
  }

  async function getOrCreateDM(otherUserId) {
    const { data, error } = await client().rpc('get_or_create_dm', { other_user_id: otherUserId });
    if (error) throw error;
    return data;
  }

  async function startStrangerChat(otherUserId) {
    const { data, error } = await client().rpc('start_stranger_chat', { other_user_id: otherUserId });
    if (error) throw error;
    return data;
  }

  async function pickRandomStranger() {
    const { data, error } = await client().rpc('pick_random_stranger');
    if (error) throw error;
    return data;
  }

  // ---------- messages ----------
  // Raw RPC helper - bypasses supabase-js client lock
  async function rawRpc(fnName, params) {
    const token = getSessionTokenSync();
    if (!token) return { data: null, error: new Error('no session') };
    try {
      const url = `${window.SUPABASE_URL}/rest/v1/rpc/${fnName}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': window.SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(params || {})
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { data: null, error: new Error(`HTTP ${res.status}: ${txt}`) };
      }
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      return { data, error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  }

  async function listMessages(chatId) {
    // Try encrypted RPC first via raw fetch (bypasses client lock)
    const r1 = await rawRpc('list_messages_decrypted', { _chat_id: chatId });
    if (!r1.error && r1.data) return r1.data;
    
    // Fallback to direct table query (also raw)
    const r2 = await rawSelect('messages',
      `chat_id=eq.${chatId}&select=*&order=created_at.asc&limit=200`);
    if (r2.error) {
      console.error('[listMessages]', r2.error);
      // Last resort: client query
      try {
        const { data } = await client().from('messages')
          .select('*').eq('chat_id', chatId)
          .order('created_at', { ascending: true })
          .limit(200);
        return data || [];
      } catch (e) {
        return [];
      }
    }
    return r2.data || [];
  }

  async function sendMessage(chatId, text) {
    const id = await uid(); if (!id) throw new Error('Not signed in');
    // Try encrypted RPC first; fall back to direct insert if migration not run
    const { data, error } = await client().rpc('send_message_encrypted',
      { _chat_id: chatId, _text: text });
    if (!error) {
      if (Array.isArray(data) && data.length) return data[0];
      return data;
    }
    console.warn('[sendMessage] RPC failed, falling back to direct insert:', error.message);
    const { data: d2, error: e2 } = await client().from('messages')
      .insert({ chat_id: chatId, sender_id: id, text })
      .select().single();
    if (e2) throw e2;
    return d2;
  }

  async function decryptMessage(id) {
    const { data, error } = await client().rpc('decrypt_message_text', { _id: id });
    if (error) { console.error('[decryptMessage]', error); return null; }
    return data;
  }

  async function lastMessagePreview(chatId) {
    const { data, error } = await client().rpc('last_message_preview', { _chat_id: chatId });
    if (error) { console.error('[lastMessagePreview]', error); return null; }
    if (Array.isArray(data) && data.length) return data[0];
    return null;
  }

  function subscribeToChat(chatId, onMessage) {
    const ch = client()
      .channel('chat:' + chatId)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: 'chat_id=eq.' + chatId },
        async (payload) => {
          const row = payload.new;
          // If encrypted, fetch decrypted text via RPC; otherwise pass through
          if (row && row.text_enc) {
            try {
              const plain = await decryptMessage(row.id);
              row.text = plain || row.text || '';
            } catch (e) { console.error('decrypt realtime', e); }
          }
          onMessage(row);
        }
      )
      .subscribe();
    return ch;
  }

  // GLOBAL message subscription — listens to all messages across the user's chats.
  // Used for unread counters and surfacing notifications even when a chat isn't open.
  function subscribeToAllMyMessages(onMessage) {
    const c = client();
    
    // Ensure realtime client has the current auth token (critical for RLS-protected channels)
    try {
      const token = getSessionTokenSync();
      if (token && c.realtime && c.realtime.setAuth) {
        c.realtime.setAuth(token);
      }
    } catch (e) {}
    
    // We can't filter by chat_id list in postgres_changes, so we subscribe to ALL
    // messages and filter client-side using the chat IDs we know about.
    const ch = c
      .channel('my-messages')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        async (payload) => {
          console.log('[db] postgres_changes INSERT received:', payload);
          const row = payload.new;
          if (!row) return;
          // Decrypt if needed
          if (row.text_enc) {
            try {
              const plain = await decryptMessage(row.id);
              row.text = plain || row.text || '';
            } catch (e) {}
          }
          onMessage(row);
        }
      )
      .subscribe((status) => {
        console.log('[db] my-messages channel status:', status);
      });
    return ch;
  }

  // POLLING fallback — checks for new messages every N seconds.
  // Runs alongside realtime so we catch messages even if websocket is dropped
  // (mobile networks, background tabs, etc.)
  //
  // lastSeenAt is persisted in localStorage so on page refresh we resume from
  // where we left off and pick up any messages that arrived while the page was
  // closed. Without this, refresh would silently drop those messages and the
  // unread badges would stay at 0 even though new messages exist.
  function startMessagePolling(onNewMessage, intervalMs = 5000) {
    const LS_KEY = 'popchats.poll.lastSeenAt';
    let lastSeenAt;
    try {
      const stored = localStorage.getItem(LS_KEY);
      if (stored) {
        // Cap the lookback window to avoid replaying ancient history if the
        // user hasn't opened the app in a long time. 7 days is a sane upper bound.
        const storedMs = new Date(stored).getTime();
        const maxLookbackMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        lastSeenAt = new Date(Math.max(storedMs, maxLookbackMs)).toISOString();
      } else {
        // First run on this device — start from "now" so we don't try to
        // replay the entire chat history on initial install.
        lastSeenAt = new Date().toISOString();
        localStorage.setItem(LS_KEY, lastSeenAt);
      }
    } catch (_) {
      lastSeenAt = new Date().toISOString();
    }
    let cancelled = false;

    function persistLastSeen() {
      try { localStorage.setItem(LS_KEY, lastSeenAt); } catch (_) {}
    }

    async function poll() {
      if (cancelled) return;
      const id = getUserIdSync();
      if (!id) {
        if (!cancelled) setTimeout(poll, intervalMs);
        return;
      }
      try {
        // Get my chat IDs first
        const m1 = await rawSelect('chat_members', `user_id=eq.${id}&select=chat_id`);
        const chatIds = (m1.data || []).map(m => m.chat_id);
        if (!chatIds.length) {
          setTimeout(poll, intervalMs);
          return;
        }
        const inList = `(${chatIds.join(',')})`;
        // Fetch messages newer than last seen
        const r = await rawSelect('messages',
          `chat_id=in.${inList}&created_at=gt.${encodeURIComponent(lastSeenAt)}&select=*&order=created_at.asc&limit=50`);
        if (r.data && r.data.length) {
          // Update lastSeenAt to the most recent message
          lastSeenAt = r.data[r.data.length - 1].created_at;
          persistLastSeen();
          // Process each new message
          for (const msg of r.data) {
            if (msg.text_enc && !msg.text) {
              try {
                const plain = await decryptMessage(msg.id);
                msg.text = plain || '';
              } catch (e) {}
            }
            onNewMessage(msg);
          }
        }
      } catch (e) {
        console.error('[poll] error:', e);
      }
      if (!cancelled) setTimeout(poll, intervalMs);
    }

    // First poll: run immediately on startup so we catch any messages that
    // arrived while the page was closed. Subsequent polls run on intervalMs.
    setTimeout(poll, 0);

    return {
      cancel: () => { cancelled = true; }
    };
  }

  function unsubscribe(ch) {
    if (ch) client().removeChannel(ch);
  }

  // ---------- notifications / calls (history) ----------
  async function listNotifications() {
    const id = await uid(); if (!id) return [];
    const { data } = await client().from('notifications')
      .select('*').eq('user_id', id)
      .order('created_at', { ascending: false }).limit(50);
    return data || [];
  }

  async function listCalls() {
    const id = await uid(); if (!id) return [];
    const { data } = await client().from('calls')
      .select('*').or(`caller_id.eq.${id},callee_id.eq.${id}`)
      .order('created_at', { ascending: false }).limit(50);
    return data || [];
  }

  return {
    getMyProfile, upsertMyProfile, updateMyProfile, getProfile,
    searchProfiles, markOnline, countOnline, getPresence,
    uploadAvatar, isUsernameAvailable, emailExists,
    friendshipState, friendshipStatesFor,
    sendFriendRequest, acceptFriendRequest, declineFriendRequest,
    cancelFriendRequest, unfriend,
    listFriendRequests, listFriends, friendSince,
    subscribeToFriendActivity,
    listMyChats, getChatMembers,
    getOrCreateDM, startStrangerChat, pickRandomStranger,
    listMessages, sendMessage, subscribeToChat, subscribeToAllMyMessages, startMessagePolling, unsubscribe,
    decryptMessage, lastMessagePreview,
    listNotifications, listCalls
  };
})();
