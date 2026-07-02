// PopChats — Supabase config (frontend-safe public values)
// NOTE: SUPABASE_URL stays on supabase.co — auth, database and realtime talk to
// Supabase directly. ONLY avatar storage is routed through the Cloudflare proxy
// (handled inside popchats-safety.js), which keeps us under the Workers cap.
window.SUPABASE_URL = 'https://vnrfmumsauwvpfiruryc.supabase.co';
window.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Hws3Y48E8YR1X63KYfo7kA_y6kW6ZFo';
window.POPCHATS_SITE_URL = 'https://popchats.zenvx.in/';

// Web Push (VAPID) — paste the PUBLIC key generated with
// `npx web-push generate-vapid-keys`. The PRIVATE key stays as a Supabase
// Edge Function secret (VAPID_PRIVATE_KEY); never put it here.
// If empty, web push registration is silently skipped.
window.VAPID_PUBLIC_KEY = 'BDRinntPwfQpiQ8yoceVftektR98Vadl-_OJyzLsIs8slNvGYtkoiiXf1i4sbTg7PsrfohEXlpwacfiGLM4ARBc';

// Load PopChats safety & privacy enhancements (delete-account UI, friends-only
// calls, stranger name masking, proxied avatar storage). Kept separate so this
// config stays declarative.
(function () {
  var s = document.createElement('script');
  s.src = 'popchats-safety.js?v=3';
  document.head.appendChild(s);
})();
