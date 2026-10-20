/**
 * Disponibilidade para agendamento.
 *
 * Regras suportadas (estilo Calendly):
 *  - grade semanal com vários intervalos por dia;
 *  - exceções por data (feriado/férias ou horário especial);
 *  - duração da reunião e intervalo entre horários;
 *  - antecedência mínima e janela máxima de dias à frente;
 *  - buffer antes/depois de cada reunião;
 *  - limite de reuniões por dia;
 *  - fuso horário da agenda respeitado de verdade (incluindo DST).
 */
import type { LeadFormScheduling } from './types';
import { DEFAULT_SCHEDULING } from './types';
import {
  addDaysToKey,
  dayKeyDiff,
  dayOfWeek,
  isValidDayKey,
  isValidTimeZone,
  zonedDateTimeToUtc,
  zonedDayKey,
  zonedParts,
} from './timezone';

export interface Slot {
  start: string; // ISO UTC
  end: string; // ISO UTC
}

export interface BookingInterval {
  starts_at: string;
  ends_at: string;
  status: string;
}

export interface GenerateSlotsOptions {
  /** Limite adicional de dias. Nunca ultrapassa max_days_ahead. */
  daysAhead?: number;
  now?: Date;
  maxSlots?: number;
}

export interface FindSlotOptions {
  now?: Date;
}

const DOW_BY_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DOW_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const MAX_WINDOWS_PER_DAY = 50;
const MAX_DATE_OVERRIDES = 400;

type TimeWindow = [string, string];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function parseClock(value: unknown, allow24 = false): number | null {
  if (typeof value !== 'string') return null;
  const clock = value.trim();
  if (allow24 && clock === '24:00') return 1440;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(clock);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function normalizeWindows(input: unknown): TimeWindow[] {
  if (!Array.isArray(input)) return [];
  const windows: Array<[number, number]> = [];
  for (const item of input.slice(0, MAX_WINDOWS_PER_DAY)) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const start = parseClock(item[0]);
    const end = parseClock(item[1], true);
    if (start === null || end === null || end <= start) continue;
    windows.push([start, end]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && window[0] <= last[1]) {
      last[1] = Math.max(last[1], window[1]);
    } else {
      merged.push([window[0], window[1]]);
    }
  }
  return merged.map(([start, end]) => [formatClock(start), formatClock(end)]);
}

function normalizeAvailability(input: unknown): Record<string, TimeWindow[]> {
  const source = isRecord(input) ? input : null;
  const availability: Record<string, TimeWindow[]> = {};
  for (const key of DOW_KEYS) {
    availability[key] = source
      ? normalizeWindows(source[key])
      : [...(DEFAULT_SCHEDULING.availability[key] ?? [])];
  }
  return availability;
}

function normalizeDateOverrides(input: unknown): Record<string, TimeWindow[]> {
  if (!isRecord(input)) return {};
  const overrides: Record<string, TimeWindow[]> = {};
  let count = 0;
  for (const [dayKey, windows] of Object.entries(input)) {
    if (count >= MAX_DATE_OVERRIDES) break;
    if (!isValidDayKey(dayKey) || !Array.isArray(windows)) continue;
    // Lista vazia é intencional: significa "dia bloqueado".
    overrides[dayKey] = normalizeWindows(windows);
    count += 1;
  }
  return overrides;
}

function normalizeDailyLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return clampInt(numeric, 1, 1000, 1);
}

/**
 * Normaliza configs antigas e novas. Configs antigas tinham apenas
 * `buffer_min`; nele o buffer era aplicado antes/depois e também como
 * intervalo, então os novos campos herdam esse valor para não mudar o
 * comportamento de agendas já publicadas.
 */
export function normalizeScheduling(input: unknown): LeadFormScheduling {
  const raw = isRecord(input) ? input : {};
  const duration = clampInt(raw.duration_min, 5, 480, DEFAULT_SCHEDULING.duration_min);
  const legacyBuffer = clampInt(raw.buffer_min, 0, 240, DEFAULT_SCHEDULING.buffer_min);
  const bufferBefore = clampInt(raw.buffer_before_min, 0, 240, legacyBuffer);
  const bufferAfter = clampInt(raw.buffer_after_min, 0, 240, legacyBuffer);
  const intervalFallback = duration + Math.max(bufferBefore, bufferAfter);
  const slotInterval = clampInt(raw.slot_interval_min, duration, 480, intervalFallback);
  const timezoneValue = typeof raw.timezone === 'string' ? raw.timezone.trim() : '';
  const timezone = timezoneValue && isValidTimeZone(timezoneValue)
    ? timezoneValue
    : DEFAULT_SCHEDULING.timezone;
  const ownerName = typeof raw.owner_name === 'string'
    ? raw.owner_name.trim().slice(0, 200) || null
    : null;
  const meetingTitle = typeof raw.meeting_title === 'string' && raw.meeting_title.trim()
    ? raw.meeting_title.trim().slice(0, 200)
    : DEFAULT_SCHEDULING.meeting_title;
  const meetingLink = typeof raw.meeting_link === 'string' && raw.meeting_link.trim()
    ? raw.meeting_link.trim().slice(0, 2000)
    : null;

  return {
    enabled: raw.enabled === true,
    duration_min: duration,
    // Mantém o campo legado sincronizado para qualquer consumidor antigo.
    buffer_min: bufferAfter,
    timezone,
    availability: normalizeAvailability(raw.availability),
    owner_name: ownerName,
    meeting_title: meetingTitle,
    meeting_link: meetingLink,
    min_notice_min: clampInt(raw.min_notice_min, 0, 10_080, DEFAULT_SCHEDULING.min_notice_min),
    max_days_ahead: clampInt(raw.max_days_ahead, 1, 365, DEFAULT_SCHEDULING.max_days_ahead),
    slot_interval_min: slotInterval,
    buffer_before_min: bufferBefore,
    buffer_after_min: bufferAfter,
    max_bookings_per_day: normalizeDailyLimit(raw.max_bookings_per_day),
    date_overrides: normalizeDateOverrides(raw.date_overrides),
  };
}

function windowsForDay(config: LeadFormScheduling, dayKey: string): TimeWindow[] {
  if (Object.prototype.hasOwnProperty.call(config.date_overrides, dayKey)) {
    return config.date_overrides[dayKey] ?? [];
  }
  const dow = dayOfWeek(dayKey);
  const key = DOW_BY_INDEX[dow];
  return key ? (config.availability[key] ?? []) : [];
}

function toBusyIntervals(bookings: BookingInterval[]): Array<{ start: number; end: number }> {
  const busy: Array<{ start: number; end: number }> = [];
  for (const booking of bookings) {
    if (booking.status !== 'scheduled') continue;
    const start = new Date(booking.starts_at).getTime();
    const end = new Date(booking.ends_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    busy.push({ start, end });
  }
  return busy;
}

function countByDay(
  bookings: BookingInterval[],
  timeZone: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const booking of bookings) {
    if (booking.status !== 'scheduled') continue;
    const key = zonedDayKey(booking.starts_at, timeZone);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * A reunião nova precisa de `buffer_before` livre antes e `buffer_after`
 * livre depois. Quando duas reuniões ficam próximas, o mesmo intervalo
 * vazio atende aos dois lados — os buffers não são somados duas vezes.
 */
function conflicts(
  startMs: number,
  endMs: number,
  busy: Array<{ start: number; end: number }>,
  bufferBeforeMs: number,
  bufferAfterMs: number,
): boolean {
  return busy.some(
    (booking) =>
      startMs - bufferBeforeMs < booking.end &&
      endMs + bufferAfterMs > booking.start,
  );
}

export function generateSlots(
  scheduling: LeadFormScheduling,
  existingBookings: BookingInterval[],
  opts: GenerateSlotsOptions = {},
): Slot[] {
  const config = normalizeScheduling(scheduling);
  if (!config.enabled) return [];

  const now = opts.now ?? new Date();
  const timeZone = config.timezone;
  const todayKey = zonedDayKey(now, timeZone);
  if (!todayKey) return [];

  const requestedDays = typeof opts.daysAhead === 'number' && Number.isFinite(opts.daysAhead)
    ? opts.daysAhead
    : config.max_days_ahead;
  const daysAhead = Math.max(
    0,
    Math.min(config.max_days_ahead, Math.floor(requestedDays)),
  );
  if (daysAhead === 0) return [];

  const maxSlots = Math.max(1, Math.min(20_000, opts.maxSlots ?? 5_000));
  const duration = config.duration_min;
  const interval = Math.max(duration, config.slot_interval_min);
  const notBefore = now.getTime() + config.min_notice_min * 60_000;
  const bufferBeforeMs = config.buffer_before_min * 60_000;
  const bufferAfterMs = config.buffer_after_min * 60_000;
  const busy = toBusyIntervals(existingBookings);
  const dailyCounts = countByDay(existingBookings, timeZone);
  const slots: Slot[] = [];
  const seen = new Set<number>();

  for (let offset = 0; offset < daysAhead && slots.length < maxSlots; offset += 1) {
    const dayKey = addDaysToKey(todayKey, offset);
    if (
      config.max_bookings_per_day !== null &&
      (dailyCounts.get(dayKey) ?? 0) >= config.max_bookings_per_day
    ) {
      continue;
    }

    const windows = windowsForDay(config, dayKey);
    if (windows.length === 0) continue;

    for (const [startClock, endClock] of windows) {
      const windowStart = parseClock(startClock);
      const windowEnd = parseClock(endClock, true);
      if (windowStart === null || windowEnd === null) continue;

      for (
        let cursor = windowStart;
        cursor + duration <= windowEnd;
        cursor += interval
      ) {
        const start = zonedDateTimeToUtc(dayKey, cursor, timeZone);
        if (!start) continue;
        const startMs = start.getTime();
        if (seen.has(startMs) || startMs < notBefore) continue;

        const endMs = startMs + duration * 60_000;
        if (conflicts(startMs, endMs, busy, bufferBeforeMs, bufferAfterMs)) continue;

        seen.add(startMs);
        slots.push({
          start: start.toISOString(),
          end: new Date(endMs).toISOString(),
        });
        if (slots.length >= maxSlots) break;
      }
      if (slots.length >= maxSlots) break;
    }
  }

  return slots;
}

/**
 * Valida um horário específico (usado no POST de agendamento para não
 * precisar gerar a agenda inteira).
 */
export function findAvailableSlot(
  scheduling: LeadFormScheduling,
  existingBookings: BookingInterval[],
  startsAt: string | Date,
  opts: FindSlotOptions = {},
): Slot | null {
  const config = normalizeScheduling(scheduling);
  if (!config.enabled) return null;

  const start = typeof startsAt === 'string' ? new Date(startsAt) : startsAt;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return null;
  if (start.getMilliseconds() !== 0) return null;

  const parts = zonedParts(start, config.timezone);
  if (!parts || parts.second !== 0) return null;

  const now = opts.now ?? new Date();
  if (start.getTime() < now.getTime() + config.min_notice_min * 60_000) return null;

  const todayKey = zonedDayKey(now, config.timezone);
  const dayDiff = dayKeyDiff(todayKey, parts.dayKey);
  if (!Number.isFinite(dayDiff) || dayDiff < 0 || dayDiff >= config.max_days_ahead) {
    return null;
  }

  const windows = windowsForDay(config, parts.dayKey);
  if (windows.length === 0) return null;

  const localMinutes = parts.hour * 60 + parts.minute;
  const localEnd = localMinutes + config.duration_min;
  const interval = Math.max(config.duration_min, config.slot_interval_min);
  const aligned = windows.some(([startClock, endClock]) => {
    const windowStart = parseClock(startClock);
    const windowEnd = parseClock(endClock, true);
    return (
      windowStart !== null &&
      windowEnd !== null &&
      localMinutes >= windowStart &&
      localEnd <= windowEnd &&
      (localMinutes - windowStart) % interval === 0
    );
  });
  if (!aligned) return null;

  if (config.max_bookings_per_day !== null) {
    const counts = countByDay(existingBookings, config.timezone);
    if ((counts.get(parts.dayKey) ?? 0) >= config.max_bookings_per_day) return null;
  }

  const endMs = start.getTime() + config.duration_min * 60_000;
  const busy = toBusyIntervals(existingBookings);
  if (
    conflicts(
      start.getTime(),
      endMs,
      busy,
      config.buffer_before_min * 60_000,
      config.buffer_after_min * 60_000,
    )
  ) {
    return null;
  }

  return { start: new Date(start).toISOString(), end: new Date(endMs).toISOString() };
}

export function groupSlotsByDay(
  slots: Slot[],
  timeZone = 'UTC',
): Array<{ day: string; label: string; slots: Slot[] }> {
  const map = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = zonedDayKey(slot.start, timeZone);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(slot);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, daySlots]) => ({
      day,
      label: new Date(`${day}T12:00:00Z`).toLocaleDateString('pt-BR', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        timeZone: 'UTC',
      }),
      slots: daySlots,
    }));
}
