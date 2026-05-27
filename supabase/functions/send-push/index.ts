// PopChats — Web Push fan-out Edge Function
//
// Triggered by a Supabase Database Webhook on INSERT into public.messages.
// For every recipient (chat member != sender), looks up their push
// subscriptions and dispatches a Web Push payload using VAPID.
//
// Payload is intentionally small to keep mobile bandwidth low (~150 bytes):
//   { c: chat_id, s: sender_name, b: short_preview }
//
// Required secrets (set with `supabase secrets set ...`):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
//   WEBHOOK_SECRET            shared with the database webhook header
//   SUPABASE_URL              (auto-provided)
//   SUPABASE_SERVICE_ROLE_KEY (auto-provided)

import webpush from 'npm:web-push@3.6.7';

const VAPID_PUBLIC_KEY  = Deno.env.get('VAPID_PUBLIC_KEY')  ?? '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT     = Deno.env.get('VAPID_SUBJECT')     ?? 'mailto:admin@example.com';
const WEBHOOK_SECRET    = Deno.env.get('WEBHOOK_SECRET')    ?? '';
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')      ?? '';
const SERVICE_KEY       = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Trim a string to a max length, ending with an ellipsis if cut.
function shortPreview(s: string, max = 80): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

// Handle incoming call push notification
async function handleCallPush(row: any): Promise<Response> {
  if (!row || row.type !== 'offer' || !row.room_id) {
    return new Response('ignored', { status: 200 });
  }

  const callerId = row.payload?.callerId;
  if (!callerId) return new Response('no callerId in payload', { status: 200 });

  // Extract callee from room_id (format: "call:uuid1_uuid2")
  const parts = row.room_id.replace(/^call:/, '').split('_');
  const calleeId = parts.find((p: string) => p !== callerId);
  if (!calleeId) return new Response('no callee', { status: 200 });

  // Get caller profile
  const profRes = await sb(
    `/rest/v1/profiles?id=eq.${callerId}&select=full_name,display_name,username`
  );
  const profArr = profRes.ok ? await profRes.json() : [];
  const caller = profArr[0] ?? {};
  const callerName = caller.full_name || caller.display_name || ('@' + (caller.username || 'someone'));

  // Get callee push subscriptions
  const subRes = await sb(
    `/rest/v1/push_subscriptions?user_id=eq.${calleeId}&select=id,endpoint,p256dh,auth`
  );
  if (!subRes.ok) return new Response('subs lookup failed', { status: 500 });
  const subs: any[] = await subRes.json();
  if (!subs.length) return new Response('no subscribers', { status: 200 });

  const video = row.payload?.video ? 'video' : 'voice';
  const data = JSON.stringify({
    type: 'call',
    callType: video,
    caller: callerName,
    roomId: row.room_id,
  });

  const dead: string[] = [];
  await Promise.all(subs.map(async (s: any) => {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(sub, data, { TTL: 30, urgency: 'high' });
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 0;
      if (status === 404 || status === 410) dead.push(s.endpoint);
      else console.error('call push error', status, err?.body || err?.message);
    }
  }));

  if (dead.length) {
    const enc = encodeURIComponent;
    await sb(
      `/rest/v1/push_subscriptions?endpoint=in.(${dead.map((d) => `"${enc(d)}"`).join(',')})`,
      { method: 'DELETE' }
    ).catch(() => {});
  }

  return new Response(JSON.stringify({ sent: subs.length - dead.length }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  // 1. Authenticate the webhook caller — must match the WEBHOOK_SECRET we
  //    configured in the Supabase Database Webhook header.
  const auth = req.headers.get('Authorization') ?? '';
  if (!WEBHOOK_SECRET || auth !== `Bearer ${WEBHOOK_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }

  let payload: any;
  try { payload = await req.json(); }
  catch { return new Response('bad json', { status: 400 }); }

  // Supabase webhook envelope: { type, table, schema, record, old_record }
  if (payload?.type !== 'INSERT') {
    return new Response('ignored', { status: 200 });
  }

  // Route: call signaling (offer) or message
  if (payload?.table === 'signaling') {
    return handleCallPush(payload.record);
  }
  if (payload?.table !== 'messages') {
    return new Response('ignored', { status: 200 });
  }
  const row = payload.record;
  if (!row?.id || !row?.chat_id || !row?.sender_id) {
    return new Response('missing fields', { status: 400 });
  }

  // 2. Look up other chat members (recipients).
  const memRes = await sb(
    `/rest/v1/chat_members?chat_id=eq.${row.chat_id}&user_id=neq.${row.sender_id}&select=user_id`
  );
  if (!memRes.ok) {
    return new Response('member lookup failed', { status: 500 });
  }
  const members: { user_id: string }[] = await memRes.json();
  if (!members.length) return new Response('no recipients', { status: 200 });
  const userIds = members.map((m) => m.user_id);

  // 3. Look up push subscriptions for those recipients.
  const inList = `(${userIds.join(',')})`;
  const subRes = await sb(
    `/rest/v1/push_subscriptions?user_id=in.${inList}&select=id,user_id,endpoint,p256dh,auth`
  );
  if (!subRes.ok) {
    return new Response('subs lookup failed', { status: 500 });
  }
  const subs: any[] = await subRes.json();
  if (!subs.length) return new Response('no subscribers', { status: 200 });

  // 4. Look up sender display name + avatar (single small query).
  const profRes = await sb(
    `/rest/v1/profiles?id=eq.${row.sender_id}&select=full_name,display_name,username,avatar_url`
  );
  const profArr = profRes.ok ? await profRes.json() : [];
  const sender = profArr[0] ?? {};
  const senderName = sender.full_name || sender.display_name || ('@' + (sender.username || 'someone'));

  // 5. Build the smallest reasonable payload. Skip the body when the column
  //    is empty (encrypted-at-rest case) — the client SW will show
  //    "<senderName> sent a message" in that case.
  const payloadObj: Record<string, string> = {
    c: row.chat_id,
    s: senderName,
    b: shortPreview(row.text || ''),
  };
  const data = JSON.stringify(payloadObj);

  // 6. Send Web Push to each subscription. Drop subscriptions returning
  //    404/410 (Gone) so we don't keep retrying dead endpoints.
  const dead: string[] = [];
  await Promise.all(subs.map(async (s) => {
    const sub = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth },
    };
    try {
      await webpush.sendNotification(sub, data, { TTL: 86400, urgency: 'high' });
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 0;
      if (status === 404 || status === 410) {
        dead.push(s.endpoint);
      } else {
        console.error('webpush send error', status, err?.body || err?.message);
      }
    }
  }));

  // 7. Clean up dead subscriptions.
  if (dead.length) {
    const enc = encodeURIComponent;
    await sb(
      `/rest/v1/push_subscriptions?endpoint=in.(${dead.map((d) => `"${enc(d)}"`).join(',')})`,
      { method: 'DELETE' }
    ).catch(() => {});
  }

  return new Response(JSON.stringify({ sent: subs.length - dead.length, pruned: dead.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
