# Chato — Supabase Setup Guide

## 1. Run the schema

1. Go to your Supabase dashboard → **SQL Editor** → **New query**
2. Paste the entire contents of `schema.sql` and click **Run**
3. Verify: Tables `profiles`, `chats`, `chat_members`, `messages`, `notifications`, `calls` should appear under **Table Editor**

## 2. Enable Realtime

1. Go to **Database → Replication** (or **Realtime** in newer dashboards)
2. Ensure `messages` and `notifications` tables have Realtime enabled (the schema already adds them to the publication, but toggle them on in the UI if needed)

## 3. Configure Auth

1. Go to **Authentication → Providers → Email**
   - Enable **Email** provider
   - Set "Confirm email" to **ON** (recommended) or OFF for testing
   - Under "Email Templates → Reset Password", the default template is fine
2. Go to **Authentication → URL Configuration**
   - **Site URL**: `https://abhi-zyn.github.io/chato/`
   - **Redirect URLs** (add both):
     - `https://abhi-zyn.github.io/chato/`
     - `https://abhi-zyn.github.io/chato/reset.html`

### Google OAuth (required for "Continue with Google")

The Google button needs both Supabase and Google Cloud configured:

1. **Google Cloud Console** (https://console.cloud.google.com):
   - Create a project (or use existing)
   - Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: `https://vnrfmumsauwvpfiruryc.supabase.co/auth/v1/callback`
   - Copy the **Client ID** and **Client Secret**
2. **Supabase Dashboard → Authentication → Providers → Google**:
   - Toggle **Enabled** on
   - Paste the Client ID and Client Secret
   - Save
3. Test by clicking "Continue with Google" on the login screen.

If Google is not configured, the button will throw "Provider is not enabled" — that's expected until you finish the steps above.

## 4. Deploy to GitHub Pages

Push all files to your repo's deployment branch. The files needed:

```
index.html
reset.html
style.css
login.css
supabase-config.js
supabase-client.js
auth.js
db.js
script.js
```

## 5. Test

1. Open `https://abhi-zyn.github.io/chato/`
2. Sign up with an email + username
3. Confirm email (if enabled)
4. Sign in → you should see the empty chat list
5. Open a second browser/incognito, sign up another user
6. Use the **+** button → search for the other user → start a chat
7. Send messages — they appear in realtime on both sides
8. Test "I forgot" → enter email → check inbox → click link → set new password

## Notes

- The `supabase-config.js` contains your **publishable (anon) key** — this is safe to commit; RLS protects your data.
- Avatar URLs default to DiceBear initials. Users can set `avatar_url` on their profile (edit profile UI not yet built).
- Stranger matching picks a random online profile. If only one user exists, it will fail gracefully.
