/**
 * Lead Forms (Typebot-style) — tipos, defaults e avaliação de qualificação.
 */

export type LeadFormStatus = 'draft' | 'published' | 'archived';

export type LeadFormBlockType =
  | 'statement'
  | 'short_text'
  | 'long_text'
  | 'email'
  | 'phone'
  | 'number'
  | 'choice_single'
  | 'choice_multi'
  | 'rating'
  | 'nps'
  | 'date'
  | 'file'
  | 'meeting';

export interface LeadFormBlockConfig {
  label: string;
  placeholder?: string;
  help_text?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string; score?: number }>;
  min?: number;
  max?: number;
  /** Para choice: valor que qualifica automaticamente. */
  qualifying_values?: string[];
  /** Para number/rating/nps: operador de qualificação. */
  qualifying_operator?: 'gte' | 'lte' | 'eq';
  qualifying_number?: number;
}

export interface LeadFormBlock {
  id?: string;
  block_key: string;
  block_type: LeadFormBlockType;
  config: LeadFormBlockConfig;
  position: number;
  is_qualifier: boolean;
  score_weight: number;
}

export interface LeadFormTheme {
  primary_color: string;
  background: string;
  font: string;
  avatar_url: string | null;
  logo_url: string | null;
  welcome_title: string;
  welcome_subtitle: string;
  button_text: string;
  show_branding: boolean;
  bubble_user: string;
  bubble_bot: string;
}

export interface LeadFormSettings {
  redirect_url: string | null;
  webhook_url: string | null;
  notify_email: string | null;
  create_contact: boolean;
  create_deal: boolean;
  qualified_pipeline_stage_id: string | null;
  require_email: boolean;
  require_phone: boolean;
  allow_retry: boolean;
}

export interface QualificationRule {
  block_key: string;
  operator: 'equals' | 'in' | 'gte' | 'lte' | 'contains' | 'present';
  value?: string | number | string[];
  score?: number;
}

export interface LeadFormQualification {
  mode: 'score' | 'rules' | 'all_required';
  rules: QualificationRule[];
  threshold: number;
  qualified_message: string;
  disqualified_message: string;
}

export interface LeadFormScheduling {
  enabled: boolean;
  duration_min: number;
  /** @deprecated Compatibilidade: espelha buffer_after_min em configs antigas. */
  buffer_min: number;
  timezone: string;
  availability: Record<string, Array<[string, string]>>;
  owner_name: string | null;
  meeting_title: string;
  meeting_link: string | null;
  /** Antecedência mínima para o primeiro horário, em minutos. */
  min_notice_min: number;
  /** Quantos dias à frente a agenda fica aberta (inclui hoje). */
  max_days_ahead: number;
  /** De quanto em quanto tempo os horários são oferecidos, em minutos. */
  slot_interval_min: number;
  /** Espaço livre antes da reunião, em minutos. */
  buffer_before_min: number;
  /** Espaço livre depois da reunião, em minutos. */
  buffer_after_min: number;
  /** Limite de reuniões por dia. null = ilimitado. */
  max_bookings_per_day: number | null;
  /**
   * Exceções por data no fuso da agenda (YYYY-MM-DD).
   * Uma lista vazia bloqueia o dia; uma lista preenchida substitui a grade
   * semanal daquela data.
   */
  date_overrides: Record<string, Array<[string, string]>>;
}

export interface LeadFormMeta {
  pixel_id: string | null;
  fire_view_content: boolean;
  fire_lead: boolean;
  fire_complete_registration: boolean;
  fire_schedule: boolean;
  fire_qualified: boolean;
}

export interface LeadForm {
  id: string;
  account_id: string;
  user_id: string;
  name: string;
  description: string | null;
  slug: string;
  status: LeadFormStatus;
  theme_config: LeadFormTheme;
  settings: LeadFormSettings;
  qualification_config: LeadFormQualification;
  scheduling_config: LeadFormScheduling;
  meta_config: LeadFormMeta;
  view_count: number;
  response_count: number;
  qualified_count: number;
  booked_count: number;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_THEME: LeadFormTheme = {
  primary_color: '#7c3aed',
  background: '#0f0f14',
  font: 'Inter',
  avatar_url: null,
  logo_url: null,
  welcome_title: 'Vamos conversar?',
  welcome_subtitle: 'Responda em menos de 1 minuto.',
  button_text: 'Começar',
  show_branding: true,
  bubble_user: '#7c3aed',
  bubble_bot: '#1f1f2a',
};

export const DEFAULT_SETTINGS: LeadFormSettings = {
  redirect_url: null,
  webhook_url: null,
  notify_email: null,
  create_contact: true,
  create_deal: true,
  qualified_pipeline_stage_id: null,
  require_email: false,
  require_phone: false,
  allow_retry: true,
};

export const DEFAULT_QUALIFICATION: LeadFormQualification = {
  mode: 'score',
  rules: [],
  threshold: 50,
  qualified_message: 'Perfeito! Você pode agendar uma reunião abaixo.',
  disqualified_message: 'Obrigado! Vamos analisar e retornar em breve.',
};

export const DEFAULT_SCHEDULING: LeadFormScheduling = {
  enabled: false,
  duration_min: 30,
  buffer_min: 10,
  timezone: 'America/Sao_Paulo',
  availability: {
    mon: [['09:00', '18:00']],
    tue: [['09:00', '18:00']],
    wed: [['09:00', '18:00']],
    thu: [['09:00', '18:00']],
    fri: [['09:00', '18:00']],
    sat: [],
    sun: [],
  },
  owner_name: null,
  meeting_title: 'Reunião de diagnóstico',
  meeting_link: null,
  min_notice_min: 30,
  max_days_ahead: 60,
  slot_interval_min: 40,
  buffer_before_min: 10,
  buffer_after_min: 10,
  max_bookings_per_day: null,
  date_overrides: {},
};

export const DEFAULT_META: LeadFormMeta = {
  pixel_id: null,
  fire_view_content: true,
  fire_lead: true,
  fire_complete_registration: true,
  fire_schedule: true,
  fire_qualified: true,
};

export const BLOCK_TYPE_LABELS: Record<LeadFormBlockType, string> = {
  statement: 'Texto / Declaração',
  short_text: 'Resposta curta',
  long_text: 'Resposta longa',
  email: 'E-mail',
  phone: 'Telefone / WhatsApp',
  number: 'Número',
  choice_single: 'Escolha única',
  choice_multi: 'Múltipla escolha',
  rating: 'Avaliação (1-5)',
  nps: 'NPS (0-10)',
  date: 'Data',
  file: 'Arquivo (link)',
  meeting: 'Agendamento',
};

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `form-${Date.now().toString(36)}`;
}

export function defaultBlocks(): LeadFormBlock[] {
  return [
    {
      block_key: 'nome',
      block_type: 'short_text',
      config: { label: 'Qual é o seu nome?', placeholder: 'Seu nome', required: true },
      position: 0,
      is_qualifier: false,
      score_weight: 0,
    },
    {
      block_key: 'whatsapp',
      block_type: 'phone',
      config: { label: 'Qual seu WhatsApp?', placeholder: '(11) 99999-9999', required: true },
      position: 1,
      is_qualifier: false,
      score_weight: 0,
    },
    {
      block_key: 'email',
      block_type: 'email',
      config: { label: 'Qual seu melhor e-mail?', placeholder: 'voce@empresa.com', required: true },
      position: 2,
      is_qualifier: false,
      score_weight: 0,
    },
    {
      block_key: 'faturamento',
      block_type: 'choice_single',
      config: {
        label: 'Qual o faturamento mensal da empresa?',
        required: true,
        options: [
          { value: 'ate_10k', label: 'Até R$ 10 mil', score: 0 },
          { value: '10_50k', label: 'R$ 10 a 50 mil', score: 20 },
          { value: '50_200k', label: 'R$ 50 a 200 mil', score: 40 },
          { value: 'acima_200k', label: 'Acima de R$ 200 mil', score: 60 },
        ],
        qualifying_values: ['10_50k', '50_200k', 'acima_200k'],
      },
      position: 3,
      is_qualifier: true,
      score_weight: 40,
    },
    {
      block_key: 'urgencia',
      block_type: 'choice_single',
      config: {
        label: 'Quando pretende começar?',
        required: true,
        options: [
          { value: 'agora', label: 'Agora / este mês', score: 30 },
          { value: 'proximos_3', label: 'Próximos 3 meses', score: 15 },
          { value: 'pesquisando', label: 'Só pesquisando', score: 0 },
        ],
        qualifying_values: ['agora', 'proximos_3'],
      },
      position: 4,
      is_qualifier: true,
      score_weight: 30,
    },
    {
      block_key: 'decisor',
      block_type: 'choice_single',
      config: {
        label: 'Você decide a contratação?',
        required: true,
        options: [
          { value: 'sim', label: 'Sim, sou decisor', score: 30 },
          { value: 'influencio', label: 'Influencio', score: 10 },
          { value: 'nao', label: 'Não', score: 0 },
        ],
        qualifying_values: ['sim', 'influencio'],
      },
      position: 5,
      is_qualifier: true,
      score_weight: 30,
    },
  ];
}

// ---------- Qualificação ----------

export function evaluateQualification(
  blocks: LeadFormBlock[],
  answers: Record<string, unknown>,
  qual: LeadFormQualification,
): { score: number; isQualified: boolean; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  let qualifierFails = 0;
  let qualifierTotal = 0;

  for (const b of blocks) {
    const ans = answers[b.block_key];
    if (ans === undefined || ans === null || ans === '') continue;
    // Score por opção
    if ((b.block_type === 'choice_single' || b.block_type === 'choice_multi') && b.config.options) {
      const values = Array.isArray(ans) ? ans.map(String) : [String(ans)];
      for (const v of values) {
        const opt = b.config.options.find((o) => o.value === v);
        if (opt?.score) score += opt.score;
      }
    }
    if ((b.block_type === 'rating' || b.block_type === 'nps' || b.block_type === 'number') && b.score_weight) {
      const n = Number(ans);
      if (!Number.isNaN(n)) {
        const max = b.block_type === 'nps' ? 10 : b.block_type === 'rating' ? 5 : 100;
        score += Math.round((Math.min(n, max) / max) * b.score_weight);
      }
    }
    // Regra de qualificação por bloco
    if (b.is_qualifier) {
      qualifierTotal += 1;
      if (!blockAnswerQualifies(b, ans)) {
        qualifierFails += 1;
        reasons.push(`${b.config.label}: resposta desqualificou`);
      }
    }
  }

  // Regras extras
  for (const r of qual.rules ?? []) {
    const v = answers[r.block_key];
    if (matchRule(v, r)) {
      score += r.score ?? 0;
    } else if (qual.mode === 'all_required') {
      return { score, isQualified: false, reasons: [...reasons, `Regra ${r.block_key} não atendida`] };
    }
  }

  score = Math.max(0, Math.min(100, score));

  let isQualified: boolean;
  if (qual.mode === 'all_required') {
    isQualified = qualifierTotal > 0 ? qualifierFails === 0 : score >= qual.threshold;
  } else if (qual.mode === 'rules' && (qual.rules ?? []).length > 0) {
    // rules mode: usa threshold sobre score acumulado das regras + blocos
    isQualified = score >= qual.threshold && qualifierFails === 0;
  } else {
    isQualified = score >= qual.threshold;
  }

  return { score, isQualified, reasons };
}

function blockAnswerQualifies(block: LeadFormBlock, ans: unknown): boolean {
  const cfg = block.config;
  if (cfg.qualifying_values && cfg.qualifying_values.length > 0) {
    const values = Array.isArray(ans) ? ans.map(String) : [String(ans)];
    return values.some((v) => cfg.qualifying_values!.includes(v));
  }
  if (cfg.qualifying_number !== undefined && cfg.qualifying_operator) {
    const n = Number(ans);
    if (Number.isNaN(n)) return false;
    if (cfg.qualifying_operator === 'gte') return n >= cfg.qualifying_number;
    if (cfg.qualifying_operator === 'lte') return n <= cfg.qualifying_number;
    return n === cfg.qualifying_number;
  }
  // Sem regra explícita: qualquer resposta válida qualifica
  return true;
}

function matchRule(v: unknown, r: QualificationRule): boolean {
  if (v === undefined || v === null || v === '') {
    return r.operator === 'present' ? false : false;
  }
  switch (r.operator) {
    case 'present':
      return true;
    case 'equals':
      return String(v) === String(r.value);
    case 'in':
      return Array.isArray(r.value) && (Array.isArray(v) ? v.some((x) => (r.value as string[]).includes(String(x))) : (r.value as string[]).includes(String(v)));
    case 'contains':
      return String(v).toLowerCase().includes(String(r.value ?? '').toLowerCase());
    case 'gte':
      return Number(v) >= Number(r.value);
    case 'lte':
      return Number(v) <= Number(r.value);
    default:
      return false;
  }
}

export function extractContactFields(
  blocks: LeadFormBlock[],
  answers: Record<string, unknown>,
): { name?: string; email?: string; phone?: string } {
  const out: { name?: string; email?: string; phone?: string } = {};
  for (const b of blocks) {
    const v = answers[b.block_key];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (b.block_type === 'email' && !out.email) out.email = v.trim();
    else if (b.block_type === 'phone' && !out.phone) out.phone = v.trim();
    else if (b.block_key === 'nome' || b.block_key === 'name' || (!out.name && b.block_type === 'short_text')) {
      if (!out.name) out.name = v.trim();
    }
  }
  // fallback: chaves nomeadas
  if (!out.name && typeof answers['nome'] === 'string') out.name = (answers['nome'] as string).trim();
  if (!out.email && typeof answers['email'] === 'string') out.email = (answers['email'] as string).trim();
  if (!out.phone && (typeof answers['whatsapp'] === 'string' || typeof answers['phone'] === 'string' || typeof answers['telefone'] === 'string' || typeof answers['celular'] === 'string')) {
    out.phone = String(answers['whatsapp'] ?? answers['phone'] ?? answers['telefone'] ?? answers['celular']).trim();
  }
  return out;
}
