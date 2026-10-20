import { describe, expect, it } from 'vitest';
import type { LeadFormScheduling } from './types';
import {
  findAvailableSlot,
  generateSlots,
  groupSlotsByDay,
  normalizeScheduling,
} from './availability';

function makeConfig(overrides: Record<string, unknown> = {}): LeadFormScheduling {
  return normalizeScheduling({
    enabled: true,
    duration_min: 30,
    buffer_min: 0,
    timezone: 'America/Sao_Paulo',
    availability: {
      mon: [['09:00', '10:00']],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    },
    owner_name: null,
    meeting_title: 'Call',
    meeting_link: null,
    min_notice_min: 0,
    max_days_ahead: 7,
    slot_interval_min: 30,
    buffer_before_min: 0,
    buffer_after_min: 0,
    max_bookings_per_day: null,
    date_overrides: {},
    ...overrides,
  });
}

describe('generateSlots — regras de disponibilidade', () => {
  it('gera horários no fuso da agenda, não no fuso do servidor', () => {
    const slots = generateSlots(makeConfig(), [], {
      now: new Date('2026-10-11T12:00:00.000Z'), // domingo
      daysAhead: 2,
    });

    expect(slots).toHaveLength(2);
    // 09:00 e 09:30 em America/Sao_Paulo (UTC-3) = 12:00 e 12:30 UTC.
    expect(slots[0]).toEqual({
      start: '2026-10-12T12:00:00.000Z',
      end: '2026-10-12T12:30:00.000Z',
    });
    expect(slots[1].start).toBe('2026-10-12T12:30:00.000Z');
  });

  it('respeita a antecedência mínima', () => {
    const slots = generateSlots(makeConfig({ min_notice_min: 30 }), [], {
      now: new Date('2026-10-12T11:50:00.000Z'), // 08:50 em São Paulo
      daysAhead: 1,
    });

    // 09:00 só tem 10 min de antecedência; o primeiro horário é 09:30.
    expect(slots).toHaveLength(1);
    expect(slots[0].start).toBe('2026-10-12T12:30:00.000Z');
  });

  it('limita a agenda à janela de dias configurada', () => {
    const slots = generateSlots(makeConfig({ max_days_ahead: 2 }), [], {
      now: new Date('2026-10-11T12:00:00.000Z'), // domingo
      daysAhead: 30,
    });

    // A janela de 2 dias inclui domingo e segunda; só segunda tem grade.
    expect(slots).toHaveLength(2);
    expect(slots.every((slot) => slot.start.startsWith('2026-10-12'))).toBe(true);
  });

  it('aplica exceções por data: dia bloqueado', () => {
    const slots = generateSlots(
      makeConfig({ date_overrides: { '2026-10-12': [] } }),
      [],
      { now: new Date('2026-10-11T12:00:00.000Z'), daysAhead: 2 },
    );
    expect(slots).toHaveLength(0);
  });

  it('aplica exceções por data: horário personalizado substitui a grade', () => {
    const slots = generateSlots(
      makeConfig({ date_overrides: { '2026-10-12': [['14:00', '15:00']] } }),
      [],
      { now: new Date('2026-10-11T12:00:00.000Z'), daysAhead: 2 },
    );

    expect(slots.map((slot) => slot.start)).toEqual([
      '2026-10-12T17:00:00.000Z',
      '2026-10-12T17:30:00.000Z',
    ]);
  });

  it('respeita buffers antes e depois de reuniões existentes', () => {
    const config = makeConfig({
      duration_min: 30,
      slot_interval_min: 40,
      buffer_before_min: 10,
      buffer_after_min: 10,
      availability: { mon: [['09:00', '12:00']] },
    });
    const slots = generateSlots(
      config,
      [{
        starts_at: '2026-10-12T12:00:00.000Z',
        ends_at: '2026-10-12T12:30:00.000Z',
        status: 'scheduled',
      }],
      { now: new Date('2026-10-11T12:00:00.000Z'), daysAhead: 2 },
    );

    // 09:00 conflita com a reunião existente; 09:40 é o próximo horário.
    expect(slots[0].start).toBe('2026-10-12T12:40:00.000Z');
    expect(slots.some((slot) => slot.start === '2026-10-12T12:00:00.000Z')).toBe(false);
  });

  it('respeita o limite de reuniões por dia', () => {
    const slots = generateSlots(
      makeConfig({
        max_bookings_per_day: 1,
        availability: { mon: [['09:00', '12:00']] },
      }),
      [{
        starts_at: '2026-10-12T12:00:00.000Z',
        ends_at: '2026-10-12T12:30:00.000Z',
        status: 'scheduled',
      }],
      { now: new Date('2026-10-12T05:00:00.000Z'), daysAhead: 1 },
    );
    expect(slots).toHaveLength(0);
  });

  it('pula horários inexistentes no início do horário de verão', () => {
    const slots = generateSlots(
      makeConfig({
        timezone: 'America/New_York',
        availability: { sun: [['01:00', '04:00']] },
        duration_min: 30,
        slot_interval_min: 30,
        max_days_ahead: 1,
      }),
      [],
      {
        now: new Date('2026-03-08T05:00:00.000Z'), // 00:00 EST
        daysAhead: 1,
      },
    );

    expect(slots.map((slot) => slot.start)).toEqual([
      '2026-03-08T06:00:00.000Z', // 01:00 EST
      '2026-03-08T06:30:00.000Z', // 01:30 EST
      '2026-03-08T07:00:00.000Z', // 03:00 EDT
      '2026-03-08T07:30:00.000Z', // 03:30 EDT
    ]);
  });
});

describe('findAvailableSlot', () => {
  const now = new Date('2026-10-11T12:00:00.000Z'); // domingo

  it('aceita um horário exato da grade', () => {
    const match = findAvailableSlot(makeConfig(), [], '2026-10-12T12:00:00.000Z', { now });
    expect(match).toEqual({
      start: '2026-10-12T12:00:00.000Z',
      end: '2026-10-12T12:30:00.000Z',
    });
  });

  it('rejeita horário fora do intervalo ou fora da grade', () => {
    expect(findAvailableSlot(makeConfig(), [], '2026-10-12T11:00:00.000Z', { now })).toBeNull();
    expect(findAvailableSlot(makeConfig(), [], '2026-10-12T12:10:00.000Z', { now })).toBeNull();
  });

  it('rejeita horário ocupado', () => {
    const match = findAvailableSlot(
      makeConfig(),
      [{
        starts_at: '2026-10-12T12:00:00.000Z',
        ends_at: '2026-10-12T12:30:00.000Z',
        status: 'scheduled',
      }],
      '2026-10-12T12:00:00.000Z',
      { now },
    );
    expect(match).toBeNull();
  });
});

describe('normalizeScheduling', () => {
  it('migra configs antigas de buffer sem mudar o comportamento', () => {
    const config = normalizeScheduling({
      enabled: true,
      duration_min: 30,
      buffer_min: 10,
      timezone: 'America/Sao_Paulo',
      availability: { mon: [['09:00', '18:00']] },
      meeting_title: 'Call',
    });

    expect(config.buffer_before_min).toBe(10);
    expect(config.buffer_after_min).toBe(10);
    expect(config.slot_interval_min).toBe(40);
    expect(config.max_days_ahead).toBe(60);
  });

  it('une intervalos sobrepostos e descarta horários inválidos', () => {
    const config = normalizeScheduling({
      enabled: true,
      availability: {
        mon: [['09:00', '12:00'], ['11:00', '18:00'], ['18:00', '09:00']],
      },
    });
    expect(config.availability.mon).toEqual([['09:00', '18:00']]);
  });
});

describe('groupSlotsByDay', () => {
  it('agrupa pelo dia local da agenda', () => {
    const groups = groupSlotsByDay(
      [{ start: '2026-10-13T01:00:00.000Z', end: '2026-10-13T01:30:00.000Z' }],
      'America/Sao_Paulo',
    );
    // 01:00 UTC = 22:00 do dia 12 em São Paulo.
    expect(groups[0].day).toBe('2026-10-12');
  });
});
