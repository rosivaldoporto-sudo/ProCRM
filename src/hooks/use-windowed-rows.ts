"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface RowWindow {
  start: number;
  end: number;
}

interface RowWindowInput {
  /** Distância do topo da lista ao topo da área visível; negativa antes da lista. */
  scrollOffset: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  overscan: number;
}

/** Quais linhas montar: as visíveis e uma folga para a rolagem não piscar. */
export function computeRowWindow({
  scrollOffset,
  viewportHeight,
  rowHeight,
  count,
  overscan,
}: RowWindowInput): RowWindow {
  const firstVisible = Math.floor(Math.max(0, scrollOffset) / rowHeight);
  const lastVisible = Math.ceil(
    Math.max(0, scrollOffset + viewportHeight) / rowHeight
  );
  const start = Math.min(count, Math.max(0, firstVisible - overscan));
  const end = Math.min(count, lastVisible + overscan);
  return { start, end: Math.max(start, end) };
}

/** Sem contêiner de rolagem conhecido, monta tudo em vez de esconder linhas. */
const ALL_ROWS: RowWindow = { start: 0, end: Number.MAX_SAFE_INTEGER };

interface UseWindowedRowsOptions {
  count: number;
  rowHeight: number;
  overscan?: number;
}

/**
 * Monta só as linhas perto da área visível de uma tabela longa, usando a
 * rolagem do `<main>` do painel (ver dashboard-shell). Procurar o rolador pelo
 * estilo computado erraria: o contêiner da tabela tem `overflow-x-auto`, e o
 * navegador reporta `overflow-y: auto` para ele também, embora só role de lado.
 *
 * Quem usa renderiza `rows.slice(start, end)` entre dois espaçadores com
 * `paddingTop` e `paddingBottom` de altura, e coloca `anchorRef` no `<tbody>`.
 *
 * A altura real da linha é medida, porque zoom e fonte podem desviá-la do
 * valor informado, e o erro se acumularia a cada linha acima da área visível.
 */
export function useWindowedRows({
  count,
  rowHeight: estimatedRowHeight,
  overscan = 12,
}: UseWindowedRowsOptions) {
  const anchorRef = useRef<HTMLTableSectionElement>(null);
  const [rowHeight, setRowHeight] = useState(estimatedRowHeight);
  // A janela não depende de `count`: quando as linhas chegam, as primeiras já
  // aparecem nesse render, sem esperar um quadro (que nem roda em aba oculta).
  const [range, setRange] = useState<RowWindow>({ start: 0, end: 40 });

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const scroller = anchor.closest("main");

    let frame = 0;
    const update = () => {
      frame = 0;
      const row = anchor.querySelector("tr[data-window-row]");
      const measured = row?.getBoundingClientRect().height ?? 0;
      const height = measured > 0 ? measured : rowHeight;
      if (Math.abs(height - rowHeight) > 0.01) setRowHeight(height);
      const next = scroller
        ? computeRowWindow({
            scrollOffset:
              scroller.getBoundingClientRect().top -
              anchor.getBoundingClientRect().top,
            viewportHeight: scroller.clientHeight,
            rowHeight: height,
            count: Number.MAX_SAFE_INTEGER,
            overscan,
          })
        : ALL_ROWS;
      setRange((prev) =>
        prev.start === next.start && prev.end === next.end ? prev : next
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    const timer = setTimeout(update);
    scroller?.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    if (scroller) observer.observe(scroller);

    return () => {
      clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      scroller?.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [count, overscan, rowHeight]);

  /** Volta ao topo da lista, para quando as linhas mudam de vez. */
  const scrollToTop = useCallback(() => {
    const anchor = anchorRef.current;
    const scroller = anchor?.closest("main");
    if (!anchor || !scroller) return;
    const offset =
      scroller.getBoundingClientRect().top - anchor.getBoundingClientRect().top;
    if (offset > 0) scroller.scrollTop -= offset;
  }, []);

  // A lista pode ter encolhido antes de o efeito recalcular a janela.
  const end = Math.min(range.end, count);
  const start = Math.min(range.start, end);

  return {
    anchorRef,
    start,
    end,
    paddingTop: start * rowHeight,
    paddingBottom: (count - end) * rowHeight,
    scrollToTop,
  };
}
