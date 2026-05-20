// Initializes the Supabase client (depends on the supabase-js CDN script being loaded first).
(function () {
  if (!window.supabase || !window.supabase.createClient) {
    console.error('[PopChats] Supabase library not loaded. Make sure the supabase-js CDN script is included before this file.');
    return;
  }
  if (!window.SUPABASE_URL || !window.SUPABASE_PUBLISHABLE_KEY) {
    console.error('[PopChats] Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY in supabase-config.js');
    return;
  }
  window.sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce'
    }
  });
})();
