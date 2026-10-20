import { describe, expect, it } from 'vitest';
import { evaluateQualification } from './types';
import { generateSlots as genSlots, normalizeScheduling } from './availability';
import type { LeadFormBlock } from './types';

const blocks: LeadFormBlock[] = [
  {
    block_key: 'faturamento',
    block_type: 'choice_single',
    config: {
      label: 'Faturamento?',
      options: [
        { value: 'baixo', label: 'Baixo', score: 0 },
        { value: 'alto', label: 'Alto', score: 60 },
      ],
      qualifying_values: ['alto'],
    },
    position: 0,
    is_qualifier: true,
    score_weight: 40,
  },
  {
    block_key: 'urgencia',
    block_type: 'choice_single',
    config: {
      label: 'Urgência?',
      options: [
        { value: 'agora', label: 'Agora', score: 40 },
        { value: 'depois', label: 'Depois', score: 0 },
      ],
      qualifying_values: ['agora'],
    },
    position: 1,
    is_qualifier: true,
    score_weight: 30,
  },
];

describe('evaluateQualification', () => {
  it('qualifies when score >= threshold', () => {
    const r = evaluateQualification(blocks, { faturamento: 'alto', urgencia: 'agora' }, {
      mode: 'score', rules: [], threshold: 50,
      qualified_message: 'q', disqualified_message: 'd',
    });
    expect(r.score).toBe(100);
    expect(r.isQualified).toBe(true);
  });

  it('disqualifies low score', () => {
    const r = evaluateQualification(blocks, { faturamento: 'baixo', urgencia: 'depois' }, {
      mode: 'score', rules: [], threshold: 50,
      qualified_message: 'q', disqualified_message: 'd',
    });
    expect(r.isQualified).toBe(false);
  });

  it('all_required fails when one qualifier fails', () => {
    const r = evaluateQualification(blocks, { faturamento: 'alto', urgencia: 'depois' }, {
      mode: 'all_required', rules: [], threshold: 50,
      qualified_message: 'q', disqualified_message: 'd',
    });
    expect(r.isQualified).toBe(false);
  });
});

describe('generateSlots', () => {
  it('generates slots within windows and skips busy', () => {
    const scheduling = normalizeScheduling({
      enabled: true,
      duration_min: 30,
      buffer_min: 0,
      timezone: 'America/Sao_Paulo',
      availability: { mon: [['09:00', '10:00']], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
      owner_name: null,
      meeting_title: 'Call',
      meeting_link: null,
      min_notice_min: 0,
    });
    // Uma segunda-feira conhecida: 2026-10-12 é segunda
    const slots = genSlots(scheduling, [], { daysAhead: 7, now: new Date('2026-10-11T12:00:00') });
    expect(slots.length).toBeGreaterThan(0);
    const busy = [{ starts_at: slots[0].start, ends_at: slots[0].end, status: 'scheduled' }];
    const slots2 = genSlots(scheduling, busy, { daysAhead: 7, now: new Date('2026-10-11T12:00:00') });
    expect(slots2.length).toBe(slots.length - 1);
  });
});
