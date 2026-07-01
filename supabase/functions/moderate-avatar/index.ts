// PopChats — profile-picture (avatar) moderation Edge Function
// Deploy:  supabase functions deploy moderate-avatar
// Secrets: supabase secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... MODERATION_API_KEY=...
//
// The client uploads the avatar to the public `avatars` bucket, then calls this
// with { path }. We scan it for CSAM + nudity. On a hit we DELETE the object
// (killing its public URL) and return { allowed:false }.
//
// If MODERATION_API_KEY is not set it fails OPEN (allows) so profile setup keeps
// working until you connect a provider. Set a key + fill in moderate() to enforce.
// CSAM handling must never be disabled once you go to production with photos.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return json({ error: 'unauthorized' }, 401);
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const path = body && body.path;
    if (!path || typeof path !== 'string') return json({ error: 'missing path' }, 400);
    // Callers may only moderate their own uploads: path must be `<uid>/...`
    if (!path.startsWith(user.id + '/')) return json({ error: 'forbidden' }, 403);

    const publicUrl = Deno.env.get('SUPABASE_URL') + '/storage/v1/object/public/avatars/' + path;
    const verdict = await moderate(publicUrl);

    if (verdict.csam || verdict.nudity) {
      await admin.storage.from('avatars').remove([path]);
      // TODO (CSAM): preserve evidence + report to authorities + ban the user.
      return json({ allowed: false, reason: verdict.csam ? 'csam' : 'nudity' });
    }
    return json({ allowed: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

async function moderate(url: string): Promise<{ csam: boolean; nudity: boolean }> {
  const key = Deno.env.get('MODERATION_API_KEY');
  if (!key) return { csam: false, nudity: false }; // fail OPEN until configured
  // TODO: real provider call (Hive / Sightengine / Rekognition + PhotoDNA), e.g.:
  // const res = await fetch('https://api.provider.com/scan', {
  //   method: 'POST',
  //   headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ url }),
  // });
  // const data = await res.json();
  // return { csam: !!data.csam_match, nudity: (data.nudity_score || 0) > 0.5 };
  return { csam: false, nudity: false };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}
