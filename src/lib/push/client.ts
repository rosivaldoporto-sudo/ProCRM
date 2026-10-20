/**
 * Browser-side Web Push plumbing.
 *
 * Kept outside React so the dashboard shell, the inbox banner and the
 * settings panel can all call it without duplicating the subscription
 * dance (or racing each other when several components mount at once).
 */

export type PushSetupStatus =
  | "unsupported"
  | "ios-install-required"
  | "unconfigured"
  | "default"
  | "denied"
  | "disabled"
  | "subscribed"
  | "error";

export interface PushSetupResult {
  status: PushSetupStatus;
  message?: string;
}

const OPT_OUT_KEY = "wacrm:push-opt-out";

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isOptedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function setOptedOut(value: boolean) {
  try {
    if (value) localStorage.setItem(OPT_OUT_KEY, "1");
    else localStorage.removeItem(OPT_OUT_KEY);
  } catch {
    // localStorage can throw in private browsing / sandboxed contexts.
  }
}

/** VAPID public keys are base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return await navigator.serviceWorker.ready;
  } catch (err) {
    console.error("[push] service worker registration failed:", err);
    return null;
  }
}

async function loadConfig(): Promise<{
  configured: boolean;
  publicKey: string | null;
}> {
  const response = await fetch("/api/push/subscribe", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Push config request failed (${response.status})`);
  }
  return (await response.json()) as {
    configured: boolean;
    publicKey: string | null;
  };
}

function syncSubscriptionToServer(
  subscription: PushSubscription,
): Promise<Response> {
  return fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
}

async function createOrReuseSubscription(
  registration: ServiceWorkerRegistration,
  publicKey: string,
): Promise<PushSubscription> {
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
}

let backgroundSync: Promise<PushSetupResult> | null = null;

/**
 * Register the service worker and, when permission is already granted,
 * keep the server-side subscription in sync. Safe to call on every
 * dashboard mount — it never prompts the user.
 */
export function syncPushSubscription(): Promise<PushSetupResult> {
  if (backgroundSync) return backgroundSync;

  backgroundSync = (async (): Promise<PushSetupResult> => {
    if (
      typeof window === "undefined" ||
      !window.isSecureContext ||
      !("serviceWorker" in navigator)
    ) {
      return { status: "unsupported" };
    }

    if (isIos() && !isStandalone()) {
      return { status: "ios-install-required" };
    }

    // Register the worker even before permission is granted: Chrome's
    // installability check expects a service worker, and the push
    // subscription needs one anyway. `getRegistration` never prompts.
    const registration = await getRegistration();
    if (!registration) {
      return { status: "error", message: "service-worker-registration" };
    }

    if (!("PushManager" in window) || !("Notification" in window)) {
      return { status: "unsupported" };
    }
    if (Notification.permission === "denied") {
      return { status: "denied" };
    }
    if (isOptedOut()) {
      return { status: "disabled" };
    }
    if (Notification.permission === "default") {
      // The settings/banner buttons call enable() after the user
      // gesture; requesting permission here would be ignored (or
      // blocked) by the browser.
      return { status: "default" };
    }

    try {
      const config = await loadConfig();
      if (!config.configured || !config.publicKey) {
        return { status: "unconfigured" };
      }

      const subscription = await createOrReuseSubscription(
        registration,
        config.publicKey,
      );
      const response = await syncSubscriptionToServer(subscription);
      if (!response.ok) {
        return { status: "error", message: "subscription-sync" };
      }
      return { status: "subscribed" };
    } catch (err) {
      console.error("[push] subscription setup failed:", err);
      return {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  })().finally(() => {
    backgroundSync = null;
  });

  return backgroundSync;
}

/**
 * Interactive opt-in. MUST be called straight from a click / tap
 * handler: iOS only allows `Notification.requestPermission()` during a
 * user gesture.
 */
export async function enablePushNotifications(): Promise<PushSetupResult> {
  if (!isSupported()) {
    return isIos() && !isStandalone()
      ? { status: "ios-install-required" }
      : { status: "unsupported" };
  }

  if (Notification.permission === "denied") {
    return { status: "denied" };
  }

  let permission: NotificationPermission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }

  if (permission !== "granted") {
    return { status: permission === "denied" ? "denied" : "default" };
  }

  setOptedOut(false);

  const registration = await getRegistration();
  if (!registration) {
    return { status: "error", message: "service-worker-registration" };
  }

  try {
    const config = await loadConfig();
    if (!config.configured || !config.publicKey) {
      return { status: "unconfigured" };
    }

    const subscription = await createOrReuseSubscription(
      registration,
      config.publicKey,
    );
    const response = await syncSubscriptionToServer(subscription);
    if (!response.ok) {
      return { status: "error", message: "subscription-sync" };
    }
    return { status: "subscribed" };
  } catch (err) {
    console.error("[push] enable failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    // A user who dismisses the iOS permission prompt can surface as
    // NotAllowedError even though Notification.permission stayed
    // "default"; report it as still-disabled rather than a hard error.
    if (/denied|not allowed|permission/i.test(message)) {
      return { status: "default" };
    }
    return { status: "error", message };
  }
}

/**
 * Turn push off for this browser. `remember` persists the choice so the
 * automatic sync doesn't silently re-subscribe on the next page load
 * (used by the settings toggle). Sign-out calls it with
 * `remember: false` to detach the device without opting the next user
 * out.
 */
export async function disablePushNotifications(
  options: { remember?: boolean } = {},
): Promise<PushSetupResult> {
  const { remember = true } = options;

  if (remember) setOptedOut(true);

  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();

    if (subscription) {
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => undefined);
      await subscription.unsubscribe().catch(() => false);
    }
  } catch (err) {
    console.warn("[push] disable failed:", err);
  }

  return { status: remember ? "disabled" : "default" };
}

export async function sendTestPush(payload: {
  title: string;
  body: string;
}): Promise<{ sent: number }> {
  const response = await fetch("/api/push/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(payload),
  });

  const data = (await response.json().catch(() => null)) as {
    sent?: number;
    error?: string;
  } | null;

  if (!response.ok) {
    throw new Error(data?.error || `Test push failed (${response.status})`);
  }

  return { sent: data?.sent ?? 0 };
}
