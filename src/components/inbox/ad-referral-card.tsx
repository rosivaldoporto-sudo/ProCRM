"use client";

import { useState } from "react";
import { ExternalLink, Megaphone, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import type { MessageReferral } from "@/types";
import { toHttpsUrl } from "@/lib/whatsapp/ad-referral";

/** Host do link, para o atendente saber para onde vai antes de clicar. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Cartão do anúncio Click-to-WhatsApp que originou a mensagem logo abaixo.
 * Os dados vêm do webhook (não confiáveis): link e miniatura só são usados
 * quando são `https:`, e o link abre numa aba nova sem `opener` nem
 * `referer`.
 */
export function AdReferralCard({ referral }: { referral: MessageReferral }) {
  const t = useTranslations("Inbox.adReferral");
  const [thumbFailed, setThumbFailed] = useState(false);

  const isPost = referral.source_type === "post";
  const isVideo = referral.media_type === "video";
  const link = toHttpsUrl(referral.source_url);
  const thumb = toHttpsUrl(referral.thumbnail_url ?? referral.image_url);
  const host = link ? hostOf(link) : null;
  const headline = referral.headline;
  const body = referral.body;

  const thumbnail =
    thumb && !thumbFailed ? (
      <span className="relative block h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- miniatura externa da Meta, sem otimização do Next */}
        <img
          src={thumb}
          alt={t("thumbnailAlt")}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => setThumbFailed(true)}
        />
        {isVideo && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/25">
            <Play className="h-5 w-5 fill-white text-white" />
          </span>
        )}
      </span>
    ) : null;

  return (
    <div className="flex w-full justify-start">
      <div className="min-w-0 max-w-[86%] sm:max-w-[75%]">
        <div className="w-72 max-w-full rounded-xl border border-border bg-card p-2.5 text-card-foreground shadow-sm">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Megaphone className="h-3 w-3 shrink-0" />
            <span>{isPost ? t("fromPost") : t("fromAd")}</span>
            <span className="ml-auto rounded-full bg-muted px-1.5 py-px normal-case tracking-normal">
              {isPost ? t("typePost") : t("typeAd")}
            </span>
          </div>

          {(thumbnail || headline || body) && (
            <div className="flex items-start gap-2.5">
              {thumbnail &&
                (link ? (
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={isPost ? t("openPost") : t("openAd")}
                    className="shrink-0"
                  >
                    {thumbnail}
                  </a>
                ) : (
                  thumbnail
                ))}
              <div className="min-w-0 flex-1">
                {headline && (
                  <p className="line-clamp-2 break-words text-sm font-semibold leading-snug">
                    {headline}
                  </p>
                )}
                {body && (
                  <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {body}
                  </p>
                )}
              </div>
            </div>
          )}

          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              title={t("openHint")}
              className="mt-2 flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-muted"
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              <span>{isPost ? t("openPost") : t("openAd")}</span>
              {host && (
                <span className="ml-auto truncate text-[10px] font-normal text-muted-foreground">
                  {host}
                </span>
              )}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
