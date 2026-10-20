/**
 * Utilitários de fuso horário para a agenda.
 *
 * Usa apenas Intl (sem dependência extra) e converte horários de parede
 * (YYYY-MM-DD + HH:MM no fuso da agenda) para instantes UTC. Isso é o que
 * garante que "09:00" configurado em America/Sao_Paulo apareça como 09:00
 * para o lead, independentemente do fuso do servidor ou do navegador.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  return typeof timeZone === 'string' && timeZone.trim().length > 0
    ? formatterFor(timeZone) !== null
    : false;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** YYYY-MM-DD no fuso informado. */
  dayKey: string;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts | null {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const formatter = formatterFor(timeZone);
  if (!formatter) return null;

  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const year = values.year;
  const month = values.month;
  const day = values.day;
  const hour = values.hour;
  const minute = values.minute;
  const second = values.second;
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dayKey: `${year}-${pad2(month)}-${pad2(day)}`,
  };
}

/** YYYY-MM-DD de um instante no fuso informado. */
export function zonedDayKey(value: Date | string, timeZone: string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return zonedParts(date, timeZone)?.dayKey ?? '';
}

/**
 * Converte um horário de parede no fuso da agenda para UTC.
 *
 * Retorna null para horários que não existem (salto de horário de verão).
 * Em horários ambíguos (fim do horário de verão), escolhe a primeira
 * ocorrência, que é o comportamento esperado por quem agenda.
 */
export function zonedDateTimeToUtc(
  dayKey: string,
  minutesOfDay: number,
  timeZone: string,
): Date | null {
  if (!isValidDayKey(dayKey)) return null;
  if (!Number.isFinite(minutesOfDay) || minutesOfDay < 0 || minutesOfDay > 1440) return null;
  const [year, month, day] = dayKey.split('-').map(Number);
  const hour = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;
  if (hour > 23) return null;

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset1 = timezoneOffsetMs(new Date(utcGuess), timeZone);
  if (offset1 === null) return null;

  let timestamp = utcGuess - offset1;
  const offset2 = timezoneOffsetMs(new Date(timestamp), timeZone);
  if (offset2 !== null && offset2 !== offset1) timestamp = utcGuess - offset2;

  const result = new Date(timestamp);
  const check = zonedParts(result, timeZone);
  if (
    !check ||
    check.year !== year ||
    check.month !== month ||
    check.day !== day ||
    check.hour !== hour ||
    check.minute !== minute ||
    check.second !== 0
  ) {
    return null;
  }
  return result;
}

function timezoneOffsetMs(date: Date, timeZone: string): number | null {
  const parts = zonedParts(date, timeZone);
  if (!parts) return null;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Ignora milissegundos para o offset não carregar frações.
  return asUtc - (date.getTime() - date.getMilliseconds());
}

export function isValidDayKey(dayKey: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return false;
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Soma dias a uma data YYYY-MM-DD usando calendário UTC (sem DST). */
export function addDaysToKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Diferença em dias entre duas datas YYYY-MM-DD (to - from). */
export function dayKeyDiff(from: string, to: string): number {
  if (!isValidDayKey(from) || !isValidDayKey(to)) return Number.NaN;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const fromUtc = Date.UTC(fy, fm - 1, fd);
  const toUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

/** Dia da semana (0 = domingo) de uma data YYYY-MM-DD. */
export function dayOfWeek(dayKey: string): number {
  if (!isValidDayKey(dayKey)) return -1;
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
