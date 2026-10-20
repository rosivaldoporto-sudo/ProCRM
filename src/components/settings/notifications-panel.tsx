"use client";

import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Loader2,
  Send,
  Smartphone,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { usePushNotifications, type PushStatus } from "@/hooks/use-push-notifications";
import { cn } from "@/lib/utils";
import { SettingsPanelHead } from "./settings-panel-head";

const STATUS_CONTENT: Record<
  PushStatus,
  {
    titleKey: string;
    descriptionKey: string;
    tone: "ok" | "warn" | "muted" | "error";
  }
> = {
  loading: {
    titleKey: "statusLoading",
    descriptionKey: "statusLoadingDesc",
    tone: "muted",
  },
  subscribed: {
    titleKey: "statusSubscribed",
    descriptionKey: "statusSubscribedDesc",
    tone: "ok",
  },
  default: {
    titleKey: "statusDefault",
    descriptionKey: "statusDefaultDesc",
    tone: "muted",
  },
  disabled: {
    titleKey: "statusDisabled",
    descriptionKey: "statusDisabledDesc",
    tone: "muted",
  },
  denied: {
    titleKey: "statusDenied",
    descriptionKey: "statusDeniedDesc",
    tone: "warn",
  },
  unsupported: {
    titleKey: "statusUnsupported",
    descriptionKey: "statusUnsupportedDesc",
    tone: "warn",
  },
  "ios-install-required": {
    titleKey: "statusIosInstall",
    descriptionKey: "statusIosInstallDesc",
    tone: "warn",
  },
  unconfigured: {
    titleKey: "statusUnconfigured",
    descriptionKey: "statusUnconfiguredDesc",
    tone: "warn",
  },
  error: {
    titleKey: "statusError",
    descriptionKey: "statusErrorDesc",
    tone: "error",
  },
};

const TONE_CLASSES: Record<
  "ok" | "warn" | "muted" | "error",
  { card: string; icon: string }
> = {
  ok: {
    card: "border-emerald-500/25 bg-emerald-500/5",
    icon: "bg-emerald-500/10 text-emerald-500",
  },
  warn: {
    card: "border-amber-500/25 bg-amber-500/5",
    icon: "bg-amber-500/10 text-amber-500",
  },
  muted: {
    card: "border-border bg-card",
    icon: "bg-muted text-muted-foreground",
  },
  error: {
    card: "border-destructive/25 bg-destructive/5",
    icon: "bg-destructive/10 text-destructive",
  },
};

export function NotificationsPanel() {
  const t = useTranslations("Settings.notifications");
  const { status, busy, testing, enable, disable, test } =
    usePushNotifications();

  const content = STATUS_CONTENT[status];
  const tone = TONE_CLASSES[content.tone];
  const canEnable = status === "default" || status === "disabled" || status === "error";

  const handleEnable = async () => {
    const result = await enable();
    if (result.status === "subscribed") {
      toast.success(t("enabledToast"));
    } else if (result.status === "unconfigured") {
      toast.error(t("unconfiguredToast"));
    } else if (result.status === "denied") {
      toast.error(t("deniedToast"));
    } else if (result.status === "error") {
      toast.error(t("enableFailedToast"));
    }
  };

  const handleTest = async () => {
    try {
      const sent = await test({ title: t("testTitle"), body: t("testBody") });
      if (sent > 0) toast.success(t("testSent"));
      else toast.error(t("testNoDevice"));
    } catch (err) {
      toast.error(
        t("testFailed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />

      <div className={cn("rounded-xl border p-4", tone.card)}>
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-lg",
              tone.icon,
            )}
            aria-hidden
          >
            {status === "loading" ? (
              <Loader2 className="size-5 animate-spin" />
            ) : status === "subscribed" ? (
              <CheckCircle2 className="size-5" />
            ) : status === "unsupported" ||
              status === "ios-install-required" ? (
              <Smartphone className="size-5" />
            ) : status === "denied" ||
              status === "unconfigured" ||
              status === "error" ? (
              <AlertTriangle className="size-5" />
            ) : (
              <BellRing className="size-5" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">
              {t(content.titleKey)}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(content.descriptionKey)}
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              {canEnable ? (
                <Button onClick={handleEnable} disabled={busy}>
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <BellRing className="size-4" />
                  )}
                  {busy ? t("enabling") : t("enable")}
                </Button>
              ) : null}

              {status === "subscribed" ? (
                <>
                  <Button
                    variant="outline"
                    onClick={handleTest}
                    disabled={testing}
                  >
                    {testing ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                    {testing ? t("testing") : t("test")}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void disable()}
                    disabled={busy}
                  >
                    {t("disable")}
                  </Button>
                </>
              ) : null}
            </div>

            <p className="mt-3 text-xs text-muted-foreground/80">
              {t("iosHint")}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
