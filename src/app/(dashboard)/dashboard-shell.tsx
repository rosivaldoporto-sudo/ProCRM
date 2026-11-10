"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { PushNotificationsSync } from "@/components/push/push-notifications-sync";
import { InboxAlerts } from "@/components/inbox/inbox-alerts";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

// Remembers the agent's sidebar preference (expanded vs icons-only)
// across reloads and sessions (device-scoped, like the theme prefs).
const SIDEBAR_COLLAPSED_STORAGE_KEY = "wacrm:sidebar-collapsed";

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // Desktop icon-only sidebar. Defaults to expanded; restored from
  // localStorage after mount (not in the initializer, to avoid a
  // server/client hydration mismatch).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true") {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSidebarCollapsed(true);
      }
    } catch {
      // Persistence is best-effort; ignore storage failures.
    }
  }, []);
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/entrar");
    }
  }, [user, loading, router]);

  if (loading) {
    // Esqueleto com a mesma estrutura do painel (barra lateral, cabeçalho,
    // conteúdo): a tela "monta" no lugar em vez de trocar um spinner
    // centralizado pelo layout inteiro.
    return (
      <div
        role="status"
        aria-label="Carregando"
        className="flex h-dvh overflow-hidden bg-background"
      >
        <div
          className={`hidden shrink-0 flex-col gap-2 border-r border-border bg-card p-3 lg:flex ${
            sidebarCollapsed ? "w-16" : "w-60"
          }`}
        >
          <div className="mb-4 h-8 animate-pulse rounded-md bg-muted" />
          {Array.from({ length: 8 }, (_, index) => (
            <div
              key={index}
              className="h-9 animate-pulse rounded-md bg-muted/70"
            />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
            <div className="h-8 w-8 animate-pulse rounded-md bg-muted lg:hidden" />
            <div className="h-5 w-40 animate-pulse rounded bg-muted" />
            <div className="ml-auto h-8 w-8 animate-pulse rounded-full bg-muted" />
          </div>
          <div className="flex-1 space-y-4 overflow-hidden p-4 sm:p-6">
            <div className="h-7 w-56 max-w-full animate-pulse rounded bg-muted" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <div
                  key={index}
                  className="h-24 animate-pulse rounded-xl bg-muted/70"
                />
              ))}
            </div>
            <div className="h-64 animate-pulse rounded-xl bg-muted/50" />
          </div>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <PushNotificationsSync />
      {/* Som / aviso na tela para mensagens novas com o app aberto. */}
      <InboxAlerts />
      <Sidebar
        open={sidebarOpen}
        onClose={closeSidebar}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapsed}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

// O catálogo completo entra aqui, e não em layout.tsx: o Next agrupa o layout
// de um route group com o layout raiz, então usar o mesmo provider nos dois faz
// toda página pública (/entrar, /f/<slug>) baixar o JS do painel inteiro.
export function DashboardShell({
  children,
  messages,
}: {
  children: React.ReactNode;
  messages: AbstractIntlMessages;
}) {
  return (
    <NextIntlClientProvider
      locale="pt-BR"
      timeZone="America/Sao_Paulo"
      messages={messages}
    >
      <AuthProvider>
        <DashboardShellInner>{children}</DashboardShellInner>
      </AuthProvider>
    </NextIntlClientProvider>
  );
}
