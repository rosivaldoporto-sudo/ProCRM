# Push notifications (PWA)

ProCRM can deliver a system notification to every device that opted in
whenever a **new inbound WhatsApp message** arrives in the inbox — even
when the app is closed or the phone is locked. It uses the standard Web
Push protocol (VAPID + service worker), not a native wrapper.

## How it works

```
WhatsApp / Uazapi webhook
        │
        ▼
src/lib/{whatsapp,uazapi}/webhook-handler.ts
        │  after the message row is inserted
        ▼
src/lib/push/send.ts ── web-push ──► FCM / APNs / Mozilla push service
                                            │
                                            ▼
                              public/sw.js (service worker)
                                            │
                                            ▼
                                  OS notification → /inbox?c=<id>
```

- Subscriptions live in `push_subscriptions` (migration `059`), one row
  per browser/device, scoped to the user and account.
- Assigned conversations notify only the assigned agent. Unassigned
  conversations notify every account member who enabled notifications.
- Dead endpoints (HTTP 404/410) are pruned automatically.
- Messages sent *from* the phone (`fromMe`) never trigger an alert.
- Historical Uazapi imports (`/api/uazapi/sync`) are silent on purpose.

- The push is sent as soon as the message is stored — before flows,
  automations and the AI auto-reply run — so the alert is not held back
  by a slow LLM call.
- When the agent already has that conversation open in a focused window,
  Chrome / Edge / Firefox skip the system notification (the message is
  already on screen). Safari always shows it: it revokes subscriptions
  that receive pushes without displaying anything.
- `pushsubscriptionchange` is handled in the worker, so a subscription the
  push service rotates is re-registered without opening the app.

## Alerts while the app is open

Web Push covers the closed / background app. With the app open in a tab,
`src/components/inbox/inbox-alerts.tsx` listens to Supabase Realtime and
adds, per device (**Settings → Notifications → With the app open**):

- a short sound on every inbound message (synthesised with Web Audio, no
  asset to download);
- an on-screen toast with the contact name and a shortcut to the
  conversation, when the agent is on another page of the dashboard;
- the unread-conversation count in the tab title — `(3) Conversas` — and
  on the installed app icon (Badging API);
- a system notification raised by the page itself when the tab is in the
  background and push is **not** active on that browser (permission
  granted but no VAPID keys on the server, or a failed subscription).

Same routing rule as push: an assigned conversation alerts only its
assignee. Nothing alerts for the conversation the agent is reading.

## Setup

### 1. Apply the migration

Run `supabase/migrations/059_push_subscriptions.sql` in the Supabase SQL
editor (or through your migration pipeline).

### 2. Generate a VAPID key pair

```bash
npm run vapid
```

Keep the pair stable. Rotating the keys invalidates every existing
subscription — users have to re-enable notifications.

### 3. Set the environment variables

```env
VAPID_PUBLIC_KEY=<publicKey from the command>
VAPID_PRIVATE_KEY=<privateKey from the command>
VAPID_SUBJECT=mailto:admin@your-domain.com
```

`VAPID_SUBJECT` must be a `mailto:` address or an `https:` URL. If it's
omitted, the app falls back to `NEXT_PUBLIC_SITE_URL`, then to
`mailto:noreply@localhost`.

The public key is served at runtime by `GET /api/push/subscribe`, so no
`NEXT_PUBLIC_*` variable or rebuild is required when adding it to an
existing deployment (restart the server after changing env vars).

### 4. Enable notifications on the device

- **Android / desktop:** open the app → **Settings → Notifications** →
  **Enable notifications**, allow the browser prompt. A compact banner
  in the inbox also offers this the first time.
- **iPhone / iPad:** the app must be installed from Safari
  (**Share → Add to Home Screen**) and opened from that icon. Web Push
  requires **iOS 16.4 or newer**. Then go to **Settings →
  Notifications → Enable notifications**.

Use **Send test notification** in the same panel to verify the whole
chain without waiting for a real message.

## Platform notes

| Platform | Requirement |
| --- | --- |
| iOS / iPadOS | Installed to the Home Screen, iOS 16.4+, HTTPS |
| Android | Chrome (or any Chromium browser), HTTPS |
| Desktop | Chrome, Edge, Firefox; HTTPS (localhost is allowed) |

The manifest (`src/app/manifest.ts`) declares `display: standalone` and
192/512 px icons; `/apple-icon` provides the 180 px Home Screen icon.
The existing `appleWebApp` metadata in `src/app/layout.tsx` remains for
older iOS versions.

## Troubleshooting

- **“Push is not configured on the server”** — `VAPID_PUBLIC_KEY` /
  `VAPID_PRIVATE_KEY` are missing from the running process. Restart the
  server after setting them.
- **“Permission blocked”** — the browser/OS is denying notifications.
  On iOS: Settings → ProCRM → Notifications → Allow Notifications.
  On desktop: the padlock/site-settings menu → Notifications → Allow.
- **No notification while the app is open on iOS** — iOS may deliver it
  silently if a previous permission prompt was dismissed. Re-enable in
  Settings → Notifications and use the test button.
- **Test says “no device is subscribed”** — the browser subscription was
  removed (app uninstalled, storage cleared). Tap enable again.
