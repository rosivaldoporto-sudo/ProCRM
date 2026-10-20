/* global self */

// ============================================================
// ProCRM service worker — Web Push receiver
//
// The app is a PWA (manifest.ts + apple-mobile-web-app-capable), so
// this worker is what lets an iPhone / Android device receive an alert
// while the app is closed or suspended. Supabase Realtime only works
// while a page is alive; push is delivered by the OS instead.
//
// Payload shape (see src/lib/push/send.ts):
//   { title, body, url, tag }
//
// Keep this file dependency-free and cache-free: a stale worker must
// never pin an old asset, and bumping the file is how the browser
// detects an update.
// ============================================================

self.addEventListener("install", () => {
  // Activate the new worker immediately instead of waiting for every
  // open tab to close — notification payloads must not be handled by
  // an old copy after a deploy.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// No-op passthrough. Kept intentionally: Chromium's installability
// criteria still look for a service worker with a fetch handler, and
// this app never wants a cached shell (the inbox is live data). Not
// calling respondWith() lets the network handle every request normally.
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Malformed / non-JSON payload — fall back to a generic alert
    // rather than dropping the notification entirely (iOS would then
    // show "This website has been updated in the background").
    data = {};
  }

  const title = typeof data.title === "string" && data.title ? data.title : "ProCRM";
  const body = typeof data.body === "string" ? data.body : "Nova mensagem no inbox";
  const url = typeof data.url === "string" && data.url ? data.url : "/inbox";
  const tag = typeof data.tag === "string" && data.tag ? data.tag : undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/192",
      badge: "/icons/192",
      tag,
      // Re-alert even when an older notification with the same tag is
      // still visible (Android/Chrome). iOS ignores this flag.
      renotify: Boolean(tag),
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = new URL(
    (event.notification.data && event.notification.data.url) || "/inbox",
    self.location.origin,
  ).href;

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Focus an existing app window when possible so the user lands
      // back where they were instead of stacking a second PWA window.
      for (const client of allClients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ("navigate" in client) {
          await client.navigate(targetUrl);
        }
        return;
      }

      await self.clients.openWindow(targetUrl);
    })(),
  );
});
