// Chato — Auth helpers (sign up / in / out / forgot / reset)
window.ChatoAuth = (function () {
  function client() { return window.sb; }

  async function signUp(email, password, username) {
    return await client().auth.signUp({
      email,
      password,
      options: {
        data: { username, display_name: username },
        emailRedirectTo: window.CHATO_SITE_URL
      }
    });
  }

  async function signIn(email, password) {
    return await client().auth.signInWithPassword({ email, password });
  }

  async function signOut() {
    return await client().auth.signOut();
  }

  async function resetPassword(email) {
    return await client().auth.resetPasswordForEmail(email, {
      redirectTo: window.CHATO_SITE_URL + 'reset.html'
    });
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
