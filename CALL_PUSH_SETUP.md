# Call Push Notification Setup

This document explains how to set up push notifications for incoming calls when the app is not open.

## Prerequisites

1. VAPID keys already configured (from message push setup)
2. `send-push` edge function already deployed
3. Push subscriptions table already exists

## Setup Steps

### 1. Deploy the Call Push Edge Function

```bash
supabase functions deploy send-call-push
```

### 2. Create Database Webhook for Incoming Calls

Go to **Supabase Dashboard → Database → Webhooks** and create a new webhook:

- **Name**: `call-push-notification`
- **Table**: `signaling`
- **Events**: `INSERT`
- **Type**: `HTTP Request`
- **Method**: `POST`
- **URL**: `https://<your-project-ref>.supabase.co/functions/v1/send-call-push`
- **HTTP Headers**:
  ```
  Authorization: Bearer <WEBHOOK_SECRET>
  Content-Type: application/json
  ```
  ⚠️ **Important**: Use the same `WEBHOOK_SECRET` value you set in step 3 below. This is NOT the VAPID key - it's a separate secret you generate for webhook authentication.
  
- **HTTP Params**: Leave empty
- **Conditions**: Add filter `type = 'offer'` (only trigger on call offers, not ICE candidates)

### 3. Set Required Secrets

Generate a random secret for webhook authentication and set all required secrets:

```bash
# Generate a random webhook secret (or use any secure random string)
supabase secrets set WEBHOOK_SECRET=<generate-random-secret-here>

# VAPID keys for Web Push (if not already set from message push setup)
supabase secrets set VAPID_PUBLIC_KEY=<your-vapid-public-key>
supabase secrets set VAPID_PRIVATE_KEY=<your-vapid-private-key>
supabase secrets set VAPID_SUBJECT=mailto:your-email@example.com
```

**Note**: 
- `WEBHOOK_SECRET` is used to authenticate the database webhook → edge function call
- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are used for Web Push authentication
- These are different secrets with different purposes

## How It Works

1. User A calls User B
2. WebRTC offer is inserted into `signaling` table with `type='offer'`
3. Database webhook triggers `send-call-push` edge function
4. Edge function:
   - Extracts callee ID from room_id
   - Looks up callee's push subscriptions
   - Sends push notification with caller info
5. Service worker receives push and shows notification
6. User clicks notification → app opens and call UI appears

## Testing

1. Open app on Device A, log in as User A
2. Close app completely on Device B (User B must have granted notification permission)
3. From Device A, call User B
4. Device B should receive a push notification even with app closed
5. Click notification to open app and answer call

## Troubleshooting

- **No notification received**: Check browser console for push subscription errors
- **Webhook not firing**: Check Supabase Dashboard → Database → Webhooks → Logs
- **Edge function errors**: Check Supabase Dashboard → Edge Functions → Logs
- **Push permission denied**: User must grant notification permission in browser settings
