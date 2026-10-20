"use client";

import { useEffect, useState } from "react";
import { BellRing, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { usePushNotifications } from "@/hooks/use-push-notifications";

const DISMISS_STORAGE_KEY = "wacrm:push-banner-dismissed-at";
const DISMISS_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One-time call-to-action shown inside the inbox while notifications
 * are still off. Browsers (and iOS in particular) only allow the
 * permission prompt from a user gesture, so silently enabling push is
 * not possible — this is the nudge that makes the feature discoverable.
 *
 * "Not now" snoozes it for a week instead of hiding it forever.
 */
export function PushEnableBanner() {
  const t = useTranslations("Inbox.pushBanner");
  const { status, busy, enable } = usePushNotifications();
  // Start hidden (not `false`) so the banner doesn't flash for users who
  // already dismissed it before localStorage is read on mount.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DISMISS_STORAGE_KEY);
      const dismissedAt = raw ? Number(raw) : 0;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hydration of a client-only storage value; same pattern as the sidebar/theme prefs.
      setDismissed(
        Number.isFinite(dismissedAt) &&
          dismissedAt > 0 &&
          Date.now() - dismissedAt < DISMISS_FOR_MS,
      );
    } catch {
      // Private browsing / storage disabled: show the banner.
      setDismissed(false);
    }
  }, []);

  if (dismissed || status !== "default") return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
    } catch {
      // Best-effort only.
    }
  };

  const handleEnable = async () => {
    const result = await enable();
    if (result.status === "unconfigured") {
      toast.error(t("unconfigured"));
    } else if (result.status === "denied") {
      toast.error(t("denied"));
    } else if (result.status === "error") {
      toast.error(t("failed"));
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-primary/20 bg-primary/5 px-4 py-2.5">
      <BellRing className="hidden size-4 shrink-0 text-primary sm:block" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">
          {t("title")}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {t("description")}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0"
        onClick={() => void handleEnable()}
        disabled={busy}
      >
        {busy ? t("enabling") : t("enable")}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        className="shrink-0"
        onClick={handleDismiss}
        aria-label={t("dismiss")}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
