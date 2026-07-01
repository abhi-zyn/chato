# PopChats — Production Security & Trust-and-Safety Checklist

This branch adds the code/DB pieces. The items below are the remaining
**manual dashboard steps** you must do yourself.

## Included in this PR (code)
- `migrations/016_reports.sql` — reports table + `report_user()` RPC (moderation queue readable only by service role).
- `migrations/017_age_gate.sql` — `dob`/`gender`/`is_adult`/`agreed_terms_at` columns, server-side 18+ enforcement (`set_date_of_birth`), `accept_terms()`, `is_adult()`, and a `public_profiles` view that hides sensitive columns.
- `migrations/018_message_media.sql` — image/video message support with a `moderation` gate + private `chat-media` storage bucket + policies.
- `supabase/functions/moderate-media/` — CSAM + nudity moderation Edge Function skeleton (fails closed until configured).
- `auth.js` — now accepts an optional `{ dob, captchaToken }` (Turnstile-ready, backward compatible).
- `privacy.html`, `terms.html` — legal pages (templates — get lawyer review).

## Run order
1. Run migrations `016`, `017`, `018` in Supabase → SQL Editor (in order).
2. Wire onboarding “Complete profile” to call `set_date_of_birth(dob, gender)` (rejects under-18 with `must_be_18`).
3. Point signup/onboarding to call `accept_terms()` when the 18+ box is ticked.
4. Switch other-user reads to the `public_profiles` view, then apply the commented `profiles_select_own` policy in `017`.
5. Wire a “Report” button on each user/message to `report_user(...)`.

## Manual dashboard steps (not in code)
- [ ] **Turnstile:** Supabase → Auth → Attack Protection → enable CAPTCHA, paste Turnstile secret. Add the widget to login/signup/reset and pass the token via `{ captchaToken }`.
- [ ] **Email verification:** ensure “Confirm email” is ON and users can’t chat/call before confirming.
- [ ] **Leaked-password protection** + min length: Supabase → Auth → Policies.
- [ ] **Redirect allowlist:** restrict to `https://popchats.zenvx.in/*`.
- [ ] **Rotate** the message encryption passphrase placeholder in `007_encrypt_messages.sql` (`_popchats_msg_key`) before prod — currently `CHANGE_ME...`.
- [ ] **Moderation provider:** create an account (Hive / Sightengine / AWS Rekognition + PhotoDNA), set `MODERATION_API_KEY`, and fill in `moderate()` in the Edge Function. Deploy it and call it after every media upload.
- [ ] **TURN server** for calls so peers don’t leak each other’s IPs (WebRTC).
- [ ] **Strip EXIF** from uploaded images (removes GPS/location) and compress client-side.
- [ ] **Cloudflare:** proxy `popchats.zenvx.in` (orange cloud, SSL Full), enable Bot Fight Mode + rate-limiting rules. Note: this protects the static site only — the Supabase API is your real backend surface, so rely on Supabase auth rate limits + Turnstile + RPC guards there.
- [ ] **Account deletion:** add an Edge Function (service role) that deletes the auth user + cascades data (DPDP/GDPR requirement).
- [ ] **Fill real contact / Grievance Officer** details in `privacy.html` and `terms.html`.
