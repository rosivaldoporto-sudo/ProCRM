"use client";

import { useEffect } from "react";

const PREFIX_PATTERN = /^\(\d+\+?\)\s/;

function withCount(title: string, count: number): string {
  const base = title.replace(PREFIX_PATTERN, "");
  if (count <= 0) return base;
  return `(${count > 99 ? "99+" : count}) ${base}`;
}

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Mostra as conversas não lidas fora da página:
 *
 *  - no título da aba — "(3) Conversas" —, para quem deixa o CRM numa aba
 *    em segundo plano;
 *  - no ícone do app instalado (Badging API: Android, desktop e iOS 16.4+).
 *
 * O Next reescreve o <title> a cada navegação, então um observer reaplica
 * o prefixo em vez de depender da ordem dos efeitos.
 */
export function useUnreadIndicators(count: number): void {
  useEffect(() => {
    const apply = () => {
      const next = withCount(document.title, count);
      // A comparação evita o laço observer → escrita → observer.
      if (document.title !== next) document.title = next;
    };
    apply();

    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      observer.disconnect();
      const base = withCount(document.title, 0);
      if (document.title !== base) document.title = base;
    };
  }, [count]);

  useEffect(() => {
    const nav = navigator as BadgeNavigator;
    if (count > 0) void nav.setAppBadge?.(count).catch(() => undefined);
    else void nav.clearAppBadge?.().catch(() => undefined);
  }, [count]);
}
