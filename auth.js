// PopChats — Auth helpers (sign up / in / out / forgot / reset)
//
// Turnstile-ready: pass an optional { captchaToken } once you enable
// Cloudflare Turnstile in Supabase → Auth → Attack Protection. Existing
// calls without the extra argument keep working unchanged.
window.PopChatsAuth = (function () {
  function client() { return window.sb; }

  // opts: { dob?: 'YYYY-MM-DD', captchaToken?: string }
  // dob is stored in user metadata; 18+ is enforced server-side
  // (see migrations/017_age_gate.sql -> set_date_of_birth()).
  async function signUp(email, password, username, opts) {
    opts = opts || {};
    const options = {
      data: { username, display_name: username },
      emailRedirectTo: window.POPCHATS_SITE_URL
    };
    if (opts.dob) options.data.dob = opts.dob;
    if (opts.captchaToken) options.captchaToken = opts.captchaToken;
    return await client().auth.signUp({ email, password, options });
  }

  async function signIn(email, password, opts) {
    opts = opts || {};
    const options = {};
    if (opts.captchaToken) options.captchaToken = opts.captchaToken;
    return await client().auth.signInWithPassword({ email, password, options });
  }

  async function signOut() {
    return await client().auth.signOut();
  }

  async function resetPassword(email, opts) {
    opts = opts || {};
    const options = { redirectTo: window.POPCHATS_SITE_URL + 'reset.html' };
    if (opts.captchaToken) options.captchaToken = opts.captchaToken;
    return await client().auth.resetPasswordForEmail(email, options);
  }

  async function updatePassword(newPassword) {
    return await client().auth.updateUser({ password: newPassword });
  }

  async function getSession() {
    const { data } = await client().auth.getSession();
    return data.session;
  }

  async function getUser() {
    const { data } = await client().auth.getUser();
    return data.user;
  }

  function onAuthChange(cb) {
    return client().auth.onAuthStateChange(cb);
  }

  return { signUp, signIn, signOut, resetPassword, updatePassword, getSession, getUser, onAuthChange };
})();
