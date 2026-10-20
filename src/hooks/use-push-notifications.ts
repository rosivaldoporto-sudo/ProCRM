"use client";

import { useCallback, useEffect, useState } from "react";

import {
  disablePushNotifications,
  enablePushNotifications,
  sendTestPush,
  syncPushSubscription,
  type PushSetupResult,
  type PushSetupStatus,
} from "@/lib/push/client";

export type PushStatus = PushSetupStatus | "loading";

export interface UsePushNotificationsResult {
  status: PushStatus;
  /** Human-readable detail for the last failure (developer-facing). */
  error: string | null;
  /** Enable / disable / sync in flight. */
  busy: boolean;
  /** Test notification in flight. */
  testing: boolean;
  enable: () => Promise<PushSetupResult>;
  disable: () => Promise<PushSetupResult>;
  test: (payload: { title: string; body: string }) => Promise<number>;
}

/**
 * Push permission + subscription state for this browser.
 *
 * On mount it silently self-heals an existing subscription (permission
 * granted → register the worker → ensure the server row exists). It
 * never prompts; `enable()` must be wired to a real user gesture.
 */
export function usePushNotifications(): UsePushNotificationsResult {
  const [status, setStatus] = useState<PushStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const apply = useCallback((result: PushSetupResult) => {
    setStatus(result.status);
    setError(result.message ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void syncPushSubscription().then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const result = await enablePushNotifications();
      apply(result);
      return result;
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const result = await disablePushNotifications();
      apply(result);
      return result;
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const test = useCallback(
    async (payload: { title: string; body: string }) => {
      setTesting(true);
      try {
        const { sent } = await sendTestPush(payload);
        return sent;
      } finally {
        setTesting(false);
      }
    },
    [],
  );

  return { status, error, busy, testing, enable, disable, test };
}
