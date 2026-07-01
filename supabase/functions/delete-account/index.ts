// PopChats — account deletion Edge Function (DPDP / GDPR right to erasure)
// Deploy:  supabase functions deploy delete-account
// Secrets: supabase secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
//
// The frontend only has the publishable key and CANNOT delete auth.users.
// That requires the service_role key, which must never reach the browser —
// hence this server-side function.
//
// Flow:
//   1. Identify the caller from their JWT (never trust an id from the body).
//   2. Remove their uploaded files (storage isn't covered by DB cascades).
//   3. Delete the auth user -> all rows with `on delete cascade` are wiped.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    // 1) Identify caller from the JWT
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) return json({ error: "unauthorized" }, 401);

    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "unauthorized" }, 401);

    // 2) Delete this user's uploaded media (storage is not cascaded)
    try {
      const { data: files } = await admin.storage.from("chat-media").list(user.id);
      if (files && files.length) {
        await admin.storage.from("chat-media")
          .remove(files.map((f) => `${user.id}/${f.name}`));
      }
    } catch (_) { /* bucket may not exist yet; ignore */ }

    // 3) Delete the auth user -> DB rows cascade automatically.
    //    reports.reporter_id is ON DELETE SET NULL, so safety records survive.
    const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
    if (delErr) return json({ error: delErr.message }, 500);

    return json({ deleted: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}
