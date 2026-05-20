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
