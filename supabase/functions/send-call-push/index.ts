// PopChats — Call Push Notification Edge Function
//
// Triggered by Database Webhook on INSERT into public.signaling (type='offer').
// Sends push notification to the callee when they receive an incoming call.

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

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (!WEBHOOK_SECRET || auth !== `Bearer ${WEBHOOK_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }

  let payload: any;
  try { payload = await req.json(); }
  catch { return new Response('bad json', { status: 400 }); }

  if (payload?.type !== 'INSERT' || payload?.table !== 'signaling') {
    return new Response('ignored', { status: 200 });
  }

  const row = payload.record;
  if (row?.type !== 'offer' || !row?.room_id || !row?.sender_id) {
    return new Response('not an offer', { status: 200 });
  }

  // Extract callee_id from room_id format: "call_{caller}_{callee}_{timestamp}"
  const parts = row.room_id.split('_');
  if (parts.length < 4 || parts[0] !== 'call') {
    return new Response('invalid room_id', { status: 400 });
  }
  const calleeId = parts[2];

  // Look up push subscriptions for callee
  const subRes = await sb(
    `/rest/v1/push_subscriptions?user_id=eq.${calleeId}&select=endpoint,p256dh,auth`
  );
  if (!subRes.ok) return new Response('subs lookup failed', { status: 500 });
  const subs: any[] = await subRes.json();
  if (!subs.length) return new Response('no subscribers', { status: 200 });

  // Look up caller info
  const profRes = await sb(
    `/rest/v1/profiles?id=eq.${row.sender_id}&select=full_name,display_name,username`
  );
  const profArr = profRes.ok ? await profRes.json() : [];
  const caller = profArr[0] ?? {};
  const callerName = caller.full_name || caller.display_name || ('@' + (caller.username || 'someone'));

  const isVideo = row.payload?.video === true;
  const data = JSON.stringify({
    type: 'call',
    callType: isVideo ? 'video' : 'voice',
    caller: callerName,
    roomId: row.room_id
  });

  // Send push to all subscriptions
  const dead: string[] = [];
  await Promise.all(subs.map(async (s) => {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(sub, data, { TTL: 30 });
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 0;
      if (status === 404 || status === 410) dead.push(s.endpoint);
    }
  }));

  // Clean up dead subscriptions
  if (dead.length) {
    const enc = encodeURIComponent;
    await sb(
      `/rest/v1/push_subscriptions?endpoint=in.(${dead.map((d) => `"${enc(d)}"`).join(',')})`,
      { method: 'DELETE' }
    ).catch(() => {});
  }

  return new Response(JSON.stringify({ sent: subs.length - dead.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
