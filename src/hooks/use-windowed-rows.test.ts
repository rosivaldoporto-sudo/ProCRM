import { describe, expect, it } from 'vitest';

import { computeRowWindow } from './use-windowed-rows';

const base = { viewportHeight: 450, rowHeight: 45, count: 3000, overscan: 10 };

describe('computeRowWindow', () => {
  it('no topo, monta as linhas visíveis mais a folga', () => {
    expect(computeRowWindow({ ...base, scrollOffset: 0 })).toEqual({
      start: 0,
      end: 20,
    });
  });

  it('com a tabela abaixo do topo, conta só o que já entrou na tela', () => {
    // A tabela começa 225 px abaixo do topo da área visível: cabem 5 linhas.
    expect(computeRowWindow({ ...base, scrollOffset: -225 })).toEqual({
      start: 0,
      end: 15,
    });
  });

  it('no meio da lista, monta só a vizinhança', () => {
    const range = computeRowWindow({ ...base, scrollOffset: 45 * 1000 });
    expect(range).toEqual({ start: 990, end: 1020 });
    expect(range.end - range.start).toBeLessThan(50);
  });

  it('no fim, não passa da última linha', () => {
    expect(
      computeRowWindow({ ...base, scrollOffset: 45 * 2995 })
    ).toEqual({ start: 2985, end: 3000 });
  });

  it('continua coerente se a rolagem ficou além de uma lista que encolheu', () => {
    const range = computeRowWindow({ ...base, count: 5, scrollOffset: 45 * 2000 });
    expect(range).toEqual({ start: 5, end: 5 });
  });

  it('lista vazia não monta nada', () => {
    expect(computeRowWindow({ ...base, count: 0, scrollOffset: 0 })).toEqual({
      start: 0,
      end: 0,
    });
  });

  it('com a tabela fora da tela, não monta linha visível', () => {
    expect(
      computeRowWindow({ ...base, overscan: 0, scrollOffset: -5000 })
    ).toEqual({ start: 0, end: 0 });
  });
});
