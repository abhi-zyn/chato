// PopChats — Data layer (profiles, chats, messages, realtime)
window.PopChatsDB = (function () {
  function client() { return window.sb; }

  async function uid() {
    const { data } = await client().auth.getUser();
    return data.user ? data.user.id : null;
  }

  // ---------- profiles ----------
  async function getMyProfile() {
    const id = await uid(); if (!id) return null;
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

    const { data: msgs } = await client()
      .from('messages').select('chat_id,text,created_at')
      .in('chat_id', chatIds)
      .order('created_at', { ascending: false });
    const lastMsg = {};
    (msgs || []).forEach(m => { if (!lastMsg[m.chat_id]) lastMsg[m.chat_id] = m; });

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
    }).sort((a, b) => new Date(b.last_time) - new Date(a.last_time));
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
    const { data, error } = await client().from('messages')
      .select('*').eq('chat_id', chatId)
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) { console.error('[listMessages]', error); return []; }
    return data || [];
  }

  async function sendMessage(chatId, text) {
    const id = await uid(); if (!id) throw new Error('Not signed in');
    const { data, error } = await client().from('messages')
      .insert({ chat_id: chatId, sender_id: id, text })
      .select().single();
    if (error) throw error;
    return data;
  }

  function subscribeToChat(chatId, onMessage) {
    const ch = client()
      .channel('chat:' + chatId)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: 'chat_id=eq.' + chatId },
        (payload) => { onMessage(payload.new); }
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
    listMyChats, getChatMembers,
    getOrCreateDM, startStrangerChat, pickRandomStranger,
    listMessages, sendMessage, subscribeToChat, unsubscribe,
    listNotifications, listCalls
  };
})();
