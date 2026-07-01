# delete-account

Server-side account deletion for DPDP / GDPR right-to-erasure.

## Deploy
```bash
supabase functions deploy delete-account
supabase secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
```

## Call from the frontend
```js
const session = await PopChatsAuth.getSession();
await fetch(`${window.SUPABASE_URL}/functions/v1/delete-account`, {
  method: "POST",
  headers: { Authorization: `Bearer ${session.access_token}` },
});
await PopChatsAuth.signOut();
```

## Notes
- Add a confirmation step in the UI (e.g. “type DELETE to confirm”).
- Deletion relies on `on delete cascade` on tables referencing the user.
  Verify newer tables (`friendships`, `push_subscriptions`) cascade.
- `reports.reporter_id` is `on delete set null` on purpose — a deleted
  user’s past reports are preserved for safety.
- Legal-hold: if the account is tied to an open CSAM/safety case, retain
  evidence rather than fully erasing (permitted under DPDP/GDPR).
