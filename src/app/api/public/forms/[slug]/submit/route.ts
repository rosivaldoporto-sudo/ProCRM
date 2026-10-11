import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { evaluateQualification, extractContactFields } from '@/lib/lead-forms/types';
import { fireFormCapiEvent } from '@/lib/lead-forms/meta-events';
import { normalizeAttribution, sanitizeTracking, type TrackingBag } from '@/lib/lead-forms/attribution';
import { getClientIp } from '@/lib/request-ip';
import { bumpFormCounter } from '@/lib/lead-forms/counters';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

/** POST público — recebe answers, avalia qualificação, cria contato/deal,
 *  dispara Meta CAPI (Lead + CompleteRegistration/QualifiedLead) e webhook.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const limit = checkRateLimit(`leadform-submit:${getClientIp(req)}`, RATE_LIMITS.invitationPeek);
  if (!limit.success) return rateLimitResponse(limit);

  const body = (await req.json().catch(() => null)) as {
    answers?: Record<string, unknown>;
    /** Tracking bruto do browser (UTMs, macros de campanha/anúncio, click IDs, cookies). */
    tracking?: TrackingBag;
    /** event_id gerado no browser p/ deduplicar pixel ↔ CAPI. */
    event_id?: string;
    /** Honeypot anti-bot (campo oculto; bots preenchem). */
    website?: string;
    /** Epoch ms de quando o formulário foi aberto (bots respondem em ms). */
    started_at?: number;
  } | null;
  if (!body?.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) {
    return NextResponse.json({ error: 'answers é obrigatório' }, { status: 400 });
  }

  // Teto anti-DoS: respostas absurdas (MBs de texto) estourariam JSONB e
  // lentidão. 100 campos, 5KB por texto, 100KB no total — folga ampla.
  const answerEntries = Object.entries(body.answers);
  if (answerEntries.length > 100) {
    return NextResponse.json({ error: 'answers excede o limite' }, { status: 400 });
  }
  for (const [key, value] of answerEntries) {
    if (key.length > 80) return NextResponse.json({ error: 'answers excede o limite' }, { status: 400 });
    if (typeof value === 'string' && value.length > 5000) {
      return NextResponse.json({ error: 'Resposta muito longa' }, { status: 400 });
    }
    if (Array.isArray(value) && (value.length > 100 || value.some((v) => typeof v === 'string' && v.length > 500))) {
      return NextResponse.json({ error: 'answers excede o limite' }, { status: 400 });
    }
  }
  if (JSON.stringify(body.answers).length > 100_000) {
    return NextResponse.json({ error: 'answers excede o limite' }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: formRow } = await db.from('lead_forms').select('*').eq('slug', slug).maybeSingle();
  const form = formRow as {
    id: string; account_id: string; user_id: string; name: string; status: string;
    settings: Record<string, unknown>; qualification_config: Parameters<typeof evaluateQualification>[2];
    meta_config: Record<string, unknown>; scheduling_config?: { enabled?: boolean };
  } | null;
  if (!form || form.status !== 'published') {
    return NextResponse.json({ error: 'Formulário não encontrado' }, { status: 404 });
  }

  // Anti-bot silencioso: honeypot preenchido ou tempo de preenchimento
  // humanamente impossível (<1.5s) → "sucesso" falso com a mensagem padrão,
  // SEM armazenar nada. Nunca sinalizar ao bot que foi detectado.
  const honeypot = typeof body.website === 'string' ? body.website.trim() : '';
  const rawFillMs =
    typeof body.started_at === 'number' && Number.isFinite(body.started_at)
      ? Date.now() - body.started_at
      : null;
  const fillMs = rawFillMs !== null && rawFillMs >= 0 ? rawFillMs : null;
  if (honeypot || (fillMs !== null && fillMs < 1500)) {
    // Atraso proposital: o caminho falso precisa durar parecido com o real
    // para o bot não detectar o honeypot por timing.
    await new Promise((r) => setTimeout(r, 500));
    const qualMsg = (form.qualification_config as { disqualified_message?: string }).disqualified_message;
    return NextResponse.json({
      response_id: `bot_${Date.now().toString(36)}`,
      is_qualified: false,
      message: qualMsg ?? 'Obrigado!',
      scheduling_enabled: false,
    });
  }
  const { data: blockRows } = await db
    .from('lead_form_blocks')
    .select('*')
    .eq('form_id', form.id)
    .order('position');
  const blocks = ((blockRows ?? []) as Array<{
    block_key: string; block_type: string; config: Record<string, unknown>;
    position: number; is_qualifier: boolean; score_weight: number;
  }>).map((b) => ({
    block_key: b.block_key,
    block_type: b.block_type as never,
    config: b.config as never,
    position: b.position,
    is_qualifier: b.is_qualifier,
    score_weight: b.score_weight,
  }));

  // Validação de obrigatórios
  for (const b of blocks) {
    const cfg = b.config as { required?: boolean; label?: string };
    if (cfg.required) {
      const v = body.answers[b.block_key];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
        return NextResponse.json({ error: `Campo obrigatório: ${cfg.label ?? b.block_key}` }, { status: 400 });
      }
    }
  }

  const { score, isQualified } = evaluateQualification(blocks, body.answers, form.qualification_config);
  const contact = extractContactFields(blocks, body.answers);
  const rawTracking = sanitizeTracking(body.tracking);
  // Atribuição normalizada (campanha/conjunto/anúncio) — vai embutida no
  // tracking da resposta para a UI ler sem migração de banco.
  const attribution = normalizeAttribution(rawTracking);
  const tracking: Record<string, unknown> = { ...rawTracking, attribution };
  const status = isQualified ? 'qualified' : 'disqualified';

  const { data: response, error: respErr } = await db
    .from('lead_form_responses')
    .insert({
      form_id: form.id,
      account_id: form.account_id,
      answers: body.answers,
      score,
      is_qualified: isQualified,
      status,
      respondent_name: contact.name ?? null,
      respondent_email: contact.email ?? null,
      respondent_phone: contact.phone ?? null,
      tracking,
      ip: getClientIp(req),
      user_agent: req.headers.get('user-agent')?.slice(0, 500) ?? null,
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (respErr || !response) {
    return NextResponse.json({ error: 'Falha ao salvar resposta' }, { status: 500 });
  }
  const responseId = (response as { id: string }).id;

  // Contadores (com log em caso de falha — ver counters.ts)
  void bumpFormCounter(db, form.id, 'response');
  if (isQualified) void bumpFormCounter(db, form.id, 'qualified');

  // Cria/atualiza contato + deal (fire-and-forget com await tolerante)
  let contactId: string | null = null;
  let dealId: string | null = null;
  try {
    const settings = form.settings as { create_contact?: boolean; create_deal?: boolean; qualified_pipeline_stage_id?: string | null };
    if (settings.create_contact !== false && (contact.phone || contact.email)) {
      // Dedup por telefone ou email dentro da conta
      let existing: { id: string } | null = null;
      if (contact.phone) {
        const { data } = await db.from('contacts').select('id').eq('account_id', form.account_id).eq('phone', contact.phone).maybeSingle();
        existing = (data as { id: string } | null) ?? null;
      }
      if (!existing && contact.email) {
        const { data } = await db.from('contacts').select('id').eq('account_id', form.account_id).eq('email', contact.email).maybeSingle();
        existing = (data as { id: string } | null) ?? null;
      }
      if (existing) {
        contactId = existing.id;
        await db.from('contacts').update({
          name: contact.name ?? undefined,
          email: contact.email ?? undefined,
          utm_source: (tracking as Record<string, string>).utm_source ?? undefined,
          utm_campaign: (tracking as Record<string, string>).utm_campaign ?? undefined,
          utm_medium: (tracking as Record<string, string>).utm_medium ?? undefined,
          utm_term: (tracking as Record<string, string>).utm_term ?? undefined,
          utm_content: (tracking as Record<string, string>).utm_content ?? undefined,
        }).eq('id', contactId);
      } else {
        const { data: created } = await db.from('contacts').insert({
          account_id: form.account_id,
          user_id: form.user_id,
          name: contact.name ?? 'Lead via formulário',
          phone: contact.phone ?? null,
          email: contact.email ?? null,
          company: typeof body.answers.empresa === 'string' ? (body.answers.empresa as string) : null,
          utm_source: (tracking as Record<string, string>).utm_source ?? null,
          utm_campaign: (tracking as Record<string, string>).utm_campaign ?? null,
          utm_medium: (tracking as Record<string, string>).utm_medium ?? null,
          utm_term: (tracking as Record<string, string>).utm_term ?? null,
          utm_content: (tracking as Record<string, string>).utm_content ?? null,
        }).select('id').single();
        contactId = ((created as { id: string } | null)?.id) ?? null;
      }
    }
    if (settings.create_deal !== false && contactId) {
      // Pipeline: usa stage qualificado se definido, senão primeiro stage do pipeline default
      let stageId = (settings.qualified_pipeline_stage_id as string | null) ?? null;
      let pipelineId: string | null = null;
      if (stageId) {
        const { data: st } = await db.from('pipeline_stages').select('id, pipeline_id').eq('id', stageId).maybeSingle();
        if (st) pipelineId = (st as { pipeline_id: string }).pipeline_id;
        else stageId = null;
      }
      if (!stageId) {
        const { data: pipes } = await db.from('pipelines').select('id').eq('account_id', form.account_id).order('created_at').limit(1);
        pipelineId = ((pipes?.[0] as { id: string } | undefined)?.id) ?? null;
        if (pipelineId) {
          const { data: stages } = await db.from('pipeline_stages').select('id').eq('pipeline_id', pipelineId).order('position').limit(1);
          stageId = ((stages?.[0] as { id: string } | undefined)?.id) ?? null;
        }
      }
      if (stageId && pipelineId) {
        const { data: deal } = await db.from('deals').insert({
          account_id: form.account_id,
          user_id: form.user_id,
          pipeline_id: pipelineId,
          stage_id: stageId,
          contact_id: contactId,
          title: `${contact.name ?? 'Lead'} — ${form.name}`,
          value: 0,
          status: 'open',
        }).select('id').single();
        dealId = ((deal as { id: string } | null)?.id) ?? null;
      }
    }
    if (contactId || dealId) {
      await db.from('lead_form_responses').update({ contact_id: contactId, deal_id: dealId }).eq('id', responseId);
    }
  } catch (err) {
    console.error('[lead-forms] contact/deal:', err instanceof Error ? err.message : err);
  }

  // Meta CAPI: Lead sempre; CompleteRegistration/QualifiedLead se qualificado.
  // Em PARALELO (Promise.all): sequencial, 3 round-trips à Meta somavam
  // segundos e congelavam a última pergunta. Cada envio é best-effort
  // (fireFormCapiEvent nunca lança) e tem timeout próprio de 8s.
  const metaCfg = form.meta_config as { fire_lead?: boolean; fire_complete_registration?: boolean; fire_qualified?: boolean };
  const metaIds: Record<string, string> = {};
  const trk = tracking as Record<string, string | undefined>;
  // Atribuição no custom_data: ajuda a fatiar relatórios por campanha/anúncio
  // e alimenta otimização. Chaves livres são ignoradas pela Meta sem erro.
  const attrCustom: Record<string, string> = {};
  if (attribution.campaign) attrCustom.campaign_name = attribution.campaign;
  if (attribution.campaignId) attrCustom.campaign_id = attribution.campaignId;
  if (attribution.adset) attrCustom.adset_name = attribution.adset;
  if (attribution.adsetId) attrCustom.adset_id = attribution.adsetId;
  if (attribution.ad) attrCustom.ad_name = attribution.ad;
  if (attribution.adId) attrCustom.ad_id = attribution.adId;
  const sharedEventId = typeof body.event_id === 'string' && body.event_id.length <= 100
    ? body.event_id
    : `form_${form.id}_${responseId}`;
  const baseUser = {
    email: contact.email, phone: contact.phone, fullName: contact.name,
    eventSourceUrl: trk.source_url,
    fbp: trk.fbp, fbc: trk.fbc, fbclid: trk.fbclid,
    clientIp: getClientIp(req), clientUa: req.headers.get('user-agent')?.slice(0, 500) ?? undefined,
  };
  const capiSends: Array<Promise<{ key: string; eid: string | null }>> = [];
  if (metaCfg.fire_lead !== false) {
    capiSends.push(
      fireFormCapiEvent({
        accountId: form.account_id, formId: form.id, responseId, event: 'Lead',
        ...baseUser, eventId: sharedEventId,
        custom: { form_name: form.name, score, qualified: isQualified, utm_campaign: trk.utm_campaign, ...attrCustom },
      }).then((eid) => ({ key: 'lead', eid }))
    );
  }
  if (isQualified && metaCfg.fire_complete_registration !== false) {
    capiSends.push(
      fireFormCapiEvent({
        accountId: form.account_id, formId: form.id, responseId, event: 'CompleteRegistration',
        ...baseUser, eventId: `${sharedEventId}_complete`,
        custom: { form_name: form.name, score, ...attrCustom },
      }).then((eid) => ({ key: 'complete_registration', eid }))
    );
  }
  if (isQualified && metaCfg.fire_qualified !== false) {
    capiSends.push(
      fireFormCapiEvent({
        accountId: form.account_id, formId: form.id, responseId, event: 'QualifiedLead',
        ...baseUser, eventId: `${sharedEventId}_qualified`,
        custom: { form_name: form.name, score, lead_quality: 'qualified', ...attrCustom },
      }).then((eid) => ({ key: 'qualified', eid }))
    );
  }
  for (const { key, eid } of await Promise.all(capiSends)) {
    if (eid) metaIds[key] = eid;
  }
  if (Object.keys(metaIds).length) {
    await db.from('lead_form_responses').update({ meta_event_ids: metaIds }).eq('id', responseId);
  }

  // Webhook externo (fire-and-forget)
  const webhook = (form.settings as { webhook_url?: string | null }).webhook_url;
  if (webhook) {
    fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ form_id: form.id, form_name: form.name, response_id: responseId, answers: body.answers, score, is_qualified: isQualified, contact, tracking, attribution }),
    }).catch(() => undefined);
  }

  const qual = form.qualification_config as { qualified_message?: string; disqualified_message?: string };
  // Resposta mínima: score/reasons são lógica interna de qualificação e
  // não saem para o respondente anônimo.
  return NextResponse.json({
    response_id: responseId,
    is_qualified: isQualified,
    message: isQualified ? qual.qualified_message : qual.disqualified_message,
    // scheduling_config já veio no select('*') acima — sem round-trip extra.
    scheduling_enabled: form.scheduling_config?.enabled ?? false,
  });
}
