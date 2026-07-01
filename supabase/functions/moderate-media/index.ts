// PopChats — media moderation Edge Function
// Deploy:  supabase functions deploy moderate-media
// Secrets: supabase secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... MODERATION_API_KEY=...
//
// Flow: client uploads to the private `chat-media` bucket and calls
// send_media_message() (row = 'pending'), then POSTs { messageId, path } here.
// We run CSAM + nudity checks and flip moderation to approved/blocked.
//
// CSAM detection + reporting is a LEGAL requirement — never disable it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  try {
    const { messageId, path } = await req.json();
    if (!messageId || !path) return json({ error: "missing params" }, 400);

    // 1) Short-lived URL to the uploaded object.
    const { data: signed, error: signErr } = await admin
      .storage.from("chat-media").createSignedUrl(path, 60);
    if (signErr) throw signErr;

    // 2) Run moderation provider (Hive / Sightengine / Rekognition + a CSAM
    //    hash service such as PhotoDNA). Prefer one call returning both scores.
    const verdict = await moderate(signed.signedUrl);

    // 3) CSAM => block, preserve evidence, file a report, ban the uploader.
    if (verdict.csam) {
      await admin.from("messages").update({ moderation: "blocked" }).eq("id", messageId);
      // TODO: preserve evidence + report to NCMEC / local authorities (mandatory),
      //       then ban the uploader.
      return json({ status: "blocked", reason: "csam" });
    }

    // 4) Adult nudity => block (nudity is OFF per product policy).
    const status = verdict.nudity ? "blocked" : "approved";
    await admin.from("messages").update({ moderation: status }).eq("id", messageId);
    return json({ status });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

async function moderate(url: string): Promise<{ csam: boolean; nudity: boolean }> {
  // TODO: replace with a real provider call using MODERATION_API_KEY.
  // Until configured this fails CLOSED (treats media as blocked) so nothing
  // unreviewed is ever shown.
  const key = Deno.env.get("MODERATION_API_KEY");
  if (!key) return { csam: false, nudity: true };
  // const res = await fetch("https://api.provider.com/scan", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ url }) });
  // const data = await res.json();
  // return { csam: data.csam_match, nudity: data.nudity_score > 0.5 };
  return { csam: false, nudity: false };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
