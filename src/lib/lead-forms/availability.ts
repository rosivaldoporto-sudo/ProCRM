/**
 * Disponibilidade para agendamento — gera slots a partir da
 * grade semanal + bookings existentes.
 */
import type { LeadFormScheduling } from './types';

export interface Slot {
  start: string; // ISO
  end: string; // ISO
}

const DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function generateSlots(
  scheduling: LeadFormScheduling,
  existingBookings: Array<{ starts_at: string; ends_at: string; status: string }>,
  opts: { daysAhead?: number; now?: Date } = {},
): Slot[] {
  if (!scheduling.enabled) return [];
  const daysAhead = opts.daysAhead ?? 14;
  const now = opts.now ?? new Date();
  const duration = Math.max(15, scheduling.duration_min || 30);
  const buffer = Math.max(0, scheduling.buffer_min || 0);
  const slots: Slot[] = [];

  const busy = existingBookings
    .filter((b) => b.status === 'scheduled')
    .map((b) => ({ s: new Date(b.starts_at).getTime(), e: new Date(b.ends_at).getTime() }));

  for (let d = 0; d < daysAhead; d += 1) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    const dow = DOW_KEYS[day.getDay()];
    const windows = scheduling.availability?.[dow] ?? [];
    if (!windows.length) continue;
    const yyyy = day.getFullYear();
    const mm = day.getMonth();
    const dd = day.getDate();
    for (const [startH, endH] of windows) {
      let cursor = toMinutes(startH);
      const end = toMinutes(endH);
      while (cursor + duration <= end) {
        const s = new Date(yyyy, mm, dd, Math.floor(cursor / 60), cursor % 60, 0, 0);
        const e = new Date(s.getTime() + duration * 60_000);
        if (e.getTime() > now.getTime() + 30 * 60_000) {
          const overlap = busy.some(
            (b) => s.getTime() < b.e + buffer * 60_000 && e.getTime() + buffer * 60_000 > b.s,
          );
          if (!overlap) slots.push({ start: s.toISOString(), end: e.toISOString() });
        }
        cursor += duration + buffer;
      }
    }
  }
  return slots.slice(0, 200);
}

export function groupSlotsByDay(slots: Slot[], timeZone?: string): Array<{ day: string; label: string; slots: Slot[] }> {
  const map = new Map<string, Slot[]>();
  for (const s of slots) {
    const d = new Date(s.start);
    const key = d.toISOString().slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  void timeZone;
  return [...map.entries()].map(([day, daySlots]) => ({
    day,
    label: new Date(`${day}T12:00:00`).toLocaleDateString('pt-BR', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
    }),
    slots: daySlots,
  }));
}
