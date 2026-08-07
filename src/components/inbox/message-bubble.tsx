"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  Sparkles,
  Download,
  Gauge,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { useTranslations } from "next-intl";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function MediaUnavailable({ label, t }: { label: string, t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{t("unavailable", { label })}</span>
    </div>
  );
}

/**
 * Resolve the URL the browser can actually load for a media message.
 * Uazapi file links are private (token header) and expire, so Uazapi
 * media is streamed through the authenticated proxy
 * /api/uazapi/media/:messageId and turned into a blob URL. Everything
 * else (Meta proxy links, public URLs) is used as-is.
 */
function useResolvedMediaUrl(message: Message): {
  url: string | null;
  loading: boolean;
  failed: boolean;
} {
  const useProxy =
    message.source === "uazapi" && !!message.message_id;

  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(useProxy);
  const [failed, setFailed] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!useProxy) return;

    let cancelled = false;

    fetch(`/api/uazapi/media/${encodeURIComponent(message.message_id!)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        const blobUrl = URL.createObjectURL(blob);
        urlRef.current = blobUrl;
        setProxyUrl(blobUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (urlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(urlRef.current);
      }
      urlRef.current = null;
    };
  }, [useProxy, message.message_id]);

  // Non-proxy media (Meta proxy links, public URLs) is used as-is —
  // no state needed, so this branch never touches the effect's state.
  if (!useProxy) {
    return { url: message.media_url || null, loading: false, failed: false };
  }

  return { url: proxyUrl, loading, failed };
}

function MediaLoading() {
  return (
    <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2, 0.75, 0.5];

/** Audio player with a playback-speed cycle button. */
function AudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [speedIndex, setSpeedIndex] = useState(0);

  const cycleSpeed = () => {
    const next = (speedIndex + 1) % PLAYBACK_SPEEDS.length;
    setSpeedIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = PLAYBACK_SPEEDS[next];
  };

  return (
    <div className="flex items-center gap-1.5">
      <audio ref={audioRef} src={src} controls className="max-w-52" />
      <button
        type="button"
        onClick={cycleSpeed}
        title="Velocidade de reprodução"
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-muted"
      >
        <Gauge className="h-3 w-3" />
        {PLAYBACK_SPEEDS[speedIndex]}x
      </button>
    </div>
  );
}

/** Download the already-resolved media URL (blob or same-origin proxy). */
function MediaDownloadButton({ url, filename }: { url: string; filename?: string }) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename || "media";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Cross-origin URLs can't be blob-fetched — open directly instead.
      window.open(url, "_blank", "noopener");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={downloading}
      title="Baixar mídia"
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-muted disabled:opacity-60"
    >
      <Download className="h-3 w-3" />
      {downloading ? "..." : "Baixar"}
    </button>
  );
}

function MediaImage({ url, alt }: { url: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadImage = useCallback(async () => {
    if (!url) return;

    // Proxy URLs need auth fetch to create blob URL
    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        setSrc(blobUrl);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    loadImage();
    return () => {
      if (src?.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadImage]);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <img
      src={src ?? ""}
      alt={alt}
      className="max-h-64 max-w-60 rounded-lg object-cover"
      onError={() => setError(true)}
    />
  );
}

function MessageContent({ message, t }: { message: Message, t: ReturnType<typeof useTranslations> }) {
  const { url: mediaUrl, loading: mediaLoading, failed: mediaFailed } = useResolvedMediaUrl(message);
  const hasMedia = !!(message.media_url || (message.source === "uazapi" && message.message_id));

  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {hasMedia ? (
            mediaFailed ? (
              <MediaUnavailable label={t("photo")} t={t} />
            ) : mediaLoading ? (
              <MediaLoading />
            ) : (
              <div className="relative">
                <MediaImage url={mediaUrl ?? ""} alt="Shared image" />
                <div className="absolute right-1 top-1">
                  <MediaDownloadButton url={mediaUrl ?? ""} filename={`imagem_${message.id}`} />
                </div>
              </div>
            )
          ) : (
            <MediaUnavailable label={t("photo")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {hasMedia ? (
            mediaFailed ? (
              <MediaUnavailable label={t("video")} t={t} />
            ) : mediaLoading ? (
              <MediaLoading />
            ) : (
              <div className="relative">
                <video
                  src={mediaUrl ?? ""}
                  controls
                  className="max-h-64 max-w-60 rounded-lg"
                />
                <div className="absolute right-1 top-1">
                  <MediaDownloadButton url={mediaUrl ?? ""} filename={`video_${message.id}`} />
                </div>
              </div>
            )
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div className="flex items-center gap-1.5">
          {hasMedia ? (
            mediaFailed ? (
              <MediaUnavailable label={t("audio")} t={t} />
            ) : mediaLoading ? (
              <div className="flex h-14 w-60 items-center justify-center rounded-lg bg-muted">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            ) : (
              <>
                <AudioPlayer src={mediaUrl ?? ""} />
                <MediaDownloadButton url={mediaUrl ?? ""} filename={`audio_${message.id}`} />
              </>
            )
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
        </div>
      );

    case "document":
      if (!hasMedia) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      if (mediaFailed) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      if (mediaLoading) {
        return (
          <div className="flex h-14 w-60 items-center justify-center rounded-lg bg-muted">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        );
      }
      return (
        <a
          href={mediaUrl ?? ""}
          target={mediaUrl?.startsWith("blob:") ? undefined : "_blank"}
          download={mediaUrl?.startsWith("blob:") ? message.content_text || undefined : undefined}
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
        >
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {message.content_text || t("document")}
          </span>
        </a>
      );

    case "template":
      return (
        <div>
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <LayoutTemplate className="h-3 w-3" />
            {message.template_name || t("template")}
          </span>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">
            {message.content_text || message.template_name || t("template")}
          </p>
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || t("locationShared")}</span>
        </div>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || t("interactiveReply")}
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("interactiveReply")}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("unsupported")}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent message={message} t={t} />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-primary-foreground/20 px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-primary-foreground"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} />}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
