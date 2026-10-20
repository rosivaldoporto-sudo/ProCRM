"use client";

import { usePushNotifications } from "@/hooks/use-push-notifications";

/**
 * Headless dashboard-level hook host: registers the service worker and
 * refreshes an already-granted push subscription on every authenticated
 * page, not just the inbox / settings screens. Renders nothing.
 */
export function PushNotificationsSync() {
  usePushNotifications();
  return null;
}
