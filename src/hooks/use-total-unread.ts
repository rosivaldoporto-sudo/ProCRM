"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Conversation } from "@/types";

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 *
 * Lives on its own realtime channel (distinct from the inbox page's
 * "inbox-realtime") so both can coexist without sharing state.
 */
export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);

  // Keep a live local mirror of {id: unread_count} so INSERT/UPDATE/DELETE
  // events can adjust the total in O(1) without refetching.
  const countsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // Initial load. RLS scopes this to the signed-in user automatically —
    // no explicit user_id filter needed here.
    //
    // Só as conversas COM não lidas: antes vinha a tabela inteira (id +
    // contador) em toda página do painel, e o PostgREST cortava em 1000
    // linhas — contas maiores baixavam 1000 linhas à toa e ainda podiam
    // errar o total.
    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, unread_count")
        .gt("unread_count", 0)
        .limit(1000);
      if (cancelled || error || !data) return;

      const map = new Map<string, number>();
      for (const row of data as { id: string; unread_count: number }[]) {
        map.set(row.id, row.unread_count ?? 0);
      }
      countsRef.current = map;
      setTotal(map.size);
    })();

    const channel = supabase
      .channel("total-unread-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload) => {
          const map = countsRef.current;
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Conversation>;
            if (oldRow.id) map.delete(oldRow.id);
          } else {
            const row = payload.new as Conversation;
            // O mapa guarda só quem tem não lidas, então o total é o
            // tamanho dele.
            if ((row.unread_count ?? 0) > 0) map.set(row.id, row.unread_count);
            else map.delete(row.id);
          }
          setTotal(map.size);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return total;
}
