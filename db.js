// PopChats — Data layer (profiles, chats, messages, realtime)
window.PopChatsDB = (function () {
  function client() { return window.sb; }

  async function uid() {
    const { data } = await client().auth.getUser();
    return data.user ? data.user.id : null;
  }

  // ---------- profiles ----------
  async function getMyProfile(userId) {
    const id = userId || await uid(); 
    if (!id) return null;
    const { data, error } = await client().from('profiles').select('*').eq('id', id).maybeSingle();
    if (error) console.error('[getMyProfile]', error);
    return data;
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
    const id = await uid(); if (!id) return;
    await client().from('profiles')
      .update({ online, last_seen: new Date().toISOString() })
      .eq('id', id);
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
    const id = await uid(); if (!id) return [];

    const { data: memberships, error: e1 } = await client()
      .from('chat_members').select('chat_id').eq('user_id', id);
    if (e1) { console.error('[listMyChats memberships]', e1); return []; }
    const chatIds = (memberships || []).map(m => m.chat_id);
    if (!chatIds.length) return [];

    const { data: chats, error: e2 } = await client()
      .from('chats').select('*').in('id', chatIds);
    if (e2) { console.error('[listMyChats chats]', e2); return []; }

    const { data: allMembers } = await client()
      .from('chat_members').select('chat_id,user_id').in('chat_id', chatIds);

    const otherIds = [...new Set((allMembers || [])
      .filter(m => m.user_id !== id).map(m => m.user_id))];

    let profiles = [];
    if (otherIds.length) {
      const { data } = await client().from('profiles').select('*').in('id', otherIds);
      profiles = data || [];
    }
    const profileMap = Object.fromEntries(profiles.map(p => [p.id, p]));

    const { data: msgs, error: msgsErr } = await client()
      .from('messages').select('chat_id,text,text_enc,created_at')
      .in('chat_id', chatIds)
      .order('created_at', { ascending: false });
    // Fallback if text_enc column doesn't exist yet (migration not run)
    let msgsList = msgs;
    if (msgsErr) {
      const { data: msgs2 } = await client()
        .from('messages').select('chat_id,text,created_at')
        .in('chat_id', chatIds)
        .order('created_at', { ascending: false });
      msgsList = msgs2;
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
  async function listMessages(chatId) {
    // Try encrypted RPC first; fall back to direct query if migration not run
    const { data, error } = await client().rpc('list_messages_decrypted', { _chat_id: chatId });
    if (!error) return data || [];
    console.warn('[listMessages] RPC failed, falling back to direct query:', error.message);
    const { data: d2, error: e2 } = await client().from('messages')
      .select('*').eq('chat_id', chatId)
      .order('created_at', { ascending: true })
      .limit(200);
    if (e2) { console.error('[listMessages]', e2); return []; }
    return d2 || [];
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
    searchProfiles, markOnline, countOnline,
    uploadAvatar, isUsernameAvailable, emailExists,
    friendshipState, friendshipStatesFor,
    sendFriendRequest, acceptFriendRequest, declineFriendRequest,
    cancelFriendRequest, unfriend,
    listFriendRequests, listFriends, friendSince,
    subscribeToFriendActivity,
    listMyChats, getChatMembers,
    getOrCreateDM, startStrangerChat, pickRandomStranger,
    listMessages, sendMessage, subscribeToChat, unsubscribe,
    decryptMessage, lastMessagePreview,
    listNotifications, listCalls
  };
})();
