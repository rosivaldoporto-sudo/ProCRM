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

// Safari (iOS e macOS) revoga a inscrição de quem recebe push sem mostrar
// notificação, então lá o alerta é sempre exibido. Nos demais navegadores
// um push pode ficar em silêncio quando o app está aberto e em foco.
const MUST_ALWAYS_NOTIFY = /^((?!chrome|chromium|android|crios|fxios|edg|firefox).)*safari/i.test(
  self.navigator.userAgent,
);

/**
 * O agente já está com esta conversa aberta, numa janela visível e em
 * foco? Então a mensagem aparece na tela na hora (realtime) e uma
 * notificação do sistema por cima seria só ruído.
 */
async function isBeingRead(url) {
  try {
    const target = new URL(url, self.location.origin);
    const conversationId = target.searchParams.get("c");
    if (!conversationId) return false;

    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    return windows.some((client) => {
      if (!client.focused || client.visibilityState !== "visible") return false;
      const current = new URL(client.url);
      return (
        current.origin === self.location.origin &&
        current.pathname === target.pathname &&
        current.searchParams.get("c") === conversationId
      );
    });
  } catch {
    return false;
  }
}

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
  const url = typeof data.url === "string" && data.url ? data.url : "/conversas";
  const tag = typeof data.tag === "string" && data.tag ? data.tag : undefined;

  event.waitUntil(
    (async () => {
      if (!MUST_ALWAYS_NOTIFY && (await isBeingRead(url))) return;

      // Marca o ícone do app instalado. O número exato é definido pela
      // página (use-unread-indicators) quando o app abre; aqui basta o
      // sinal de "há algo novo".
      if (self.navigator.setAppBadge) {
        self.navigator.setAppBadge().catch(() => {});
      }

      await self.registration.showNotification(title, {
        body,
        icon: "/icons/192",
        badge: "/icons/192",
        tag,
        lang: "pt-BR",
        // Re-alert even when an older notification with the same tag is
        // still visible (Android/Chrome). iOS ignores this flag.
        renotify: Boolean(tag),
        data: { url },
      });
    })(),
  );
});

// O serviço de push pode trocar ou expirar a inscrição sem avisar a
// página (Chrome e Firefox fazem isso periodicamente). Sem este handler o
// dispositivo para de receber alertas até o app ser aberto de novo.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const previous = event.oldSubscription;
        const subscription =
          event.newSubscription ||
          (previous && previous.options
            ? await self.registration.pushManager.subscribe(previous.options)
            : null);
        if (!subscription) return;

        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ subscription: subscription.toJSON() }),
        });
      } catch {
        // Sessão expirada ou sem rede: a página refaz a inscrição na
        // próxima abertura (syncPushSubscription).
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // Same-origin only: a notification must never open a third-party page.
  const requestedUrl = new URL(
    (event.notification.data && event.notification.data.url) || "/conversas",
    self.location.origin,
  );
  const targetUrl =
    requestedUrl.origin === self.location.origin
      ? requestedUrl.href
      : new URL("/conversas", self.location.origin).href;

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
