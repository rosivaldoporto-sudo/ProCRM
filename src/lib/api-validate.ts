import { NextResponse } from 'next/server';

/**
 * Validação e erros padronizados para rotas de API.
 *
 * Regras aplicadas em todo o sistema:
 *  - 400 com mensagem curta e estável para input inválido (sem detalhe interno);
 *  - 500 genérico + log server-side (nunca vazar `error.message` do banco);
 *  - tetos de tamanho em strings/arrays (anti DoS de armazenamento);
 *  - allow-lists para enums e formatos (UUID, dígitos, URLs https).
 */

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** 500 genérico — o detalhe vai só para o log do servidor. */
export function fail(op: string, err: unknown) {
  console.error(`[api:${op}]`, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function isDigits(v: unknown, minLen = 1, maxLen = 30): v is string {
  return (
    typeof v === 'string' &&
    v.length >= minLen &&
    v.length <= maxLen &&
    /^\d+$/.test(v)
  );
}

/** String aparada e com teto. Retorna undefined se ausente/vazia. */
export function capStr(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, maxLen);
  return s ? s : undefined;
}

/** String obrigatória com teto. Retorna null se inválida. */
export function reqStr(v: unknown, maxLen: number): string | null {
  const s = capStr(v, maxLen);
  return s ?? null;
}

export function isValidEnum<T extends string>(v: unknown, allowed: ReadonlySet<T> | readonly T[]): v is T {
  if (typeof v !== 'string') return false;
  if (Array.isArray(allowed)) return (allowed as readonly string[]).includes(v);
  return (allowed as ReadonlySet<string>).has(v);
}

/**
 * URL https válida com teto de tamanho. Bloqueia `javascript:`, `data:`,
 * `file:` e protocolos estranhos (vetor de XSS via href/src persistido).
 */
export function httpsUrl(v: unknown, maxLen = 2048): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > maxLen) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return null;
    return s;
  } catch {
    return null;
  }
}

/** E-mail com formato básico + teto. */
export function validEmail(v: unknown, maxLen = 320): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > maxLen) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/**
 * Array de strings higienizado: remove não-strings/vazias, aplica teto
 * por item e no total. Retorna null se não for array.
 */
export function strArray(v: unknown, maxItems: number, maxItemLen: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim().slice(0, maxItemLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Teto de tamanho do JSON serializado (anti DoS). */
export function jsonSizeOk(v: unknown, maxBytes: number): boolean {
  try {
    return JSON.stringify(v).length <= maxBytes;
  } catch {
    return false;
  }
}
