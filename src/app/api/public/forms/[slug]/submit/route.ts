import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { evaluateQualification, extractContactFields } from '@/lib/lead-forms/types';
import { fireFormCapiEvent } from '@/lib/lead-forms/meta-events';
import { normalizeAttribution, sanitizeTracking, type TrackingBag } from '@/lib/lead-forms/attribution';
import { getClientIp } from '@/lib/request-ip';
import { bumpFormCounter } from '@/lib/lead-forms/counters';
import { syncLeadRecords, type LeadSyncSettings } from '@/lib/lead-forms/contact-sync';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { isUuid } from '@/lib/api-validate';

interface LeadFormResponseRow {
  id: string;
  status: string;
  contact_id: string | null;
  deal_id: string | null;
}

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
    /**
     * Salvamento antecipado: cria o lead no CRM assim que o WhatsApp é
     * respondido, sem exigir as demais perguntas obrigatórias. O envio
     * final reaproveita a mesma resposta via `response_id`.
     */
    partial?: boolean;
    /** Resposta já iniciada (parcial) que o envio final deve atualizar. */
    response_id?: string;
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

  const isPartial = body.partial === true;
  const requestedResponseId = isUuid(body.response_id) ? body.response_id : null;

  // ---------- Salvamento antecipado (WhatsApp respondido) ----------
  // Cria a resposta como `started`, já com contato e deal, para que o
  // time consiga abordar quem abandonou o formulário. Não dispara
  // Meta CAPI, webhook nem contadores: isso é papel do envio final.
  if (isPartial) {
    const contact = extractContactFields(blocks, body.answers);
    if (!contact.phone) {
      return NextResponse.json({ error: 'Telefone é obrigatório' }, { status: 400 });
    }

    const rawTracking = sanitizeTracking(body.tracking);
    const attribution = normalizeAttribution(rawTracking);
    const tracking: Record<string, unknown> = { ...rawTracking, attribution };
    const { score } = evaluateQualification(blocks, body.answers, form.qualification_config);

    let existing: LeadFormResponseRow | null = null;

    if (requestedResponseId) {
      const { data } = await db
        .from('lead_form_responses')
        .select('id, status, contact_id, deal_id')
        .eq('id', requestedResponseId)
        .eq('form_id', form.id)
        .maybeSingle();
      const row = data as LeadFormResponseRow | null;
      if (row?.status === 'started') existing = row;
    }

    // Recarregou a página / perdeu o id local: reaproveita a resposta em
    // andamento do mesmo telefone nas últimas 24h em vez de duplicar.
    if (!existing) {
      const { data: recent } = await db
        .from('lead_form_responses')
        .select('id, status, contact_id, deal_id')
        .eq('form_id', form.id)
        .eq('status', 'started')
        .eq('respondent_phone', contact.phone)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      existing = (recent as LeadFormResponseRow | null) ?? null;
    }

    const responsePatch = {
      answers: body.answers,
      score,
      is_qualified: false,
      status: 'started',
      respondent_name: contact.name ?? null,
      respondent_email: contact.email ?? null,
      respondent_phone: contact.phone,
      tracking,
      ip: getClientIp(req),
      user_agent: req.headers.get('user-agent')?.slice(0, 500) ?? null,
    };

    let responseId = existing?.id ?? null;
    if (responseId) {
      const { error } = await db
        .from('lead_form_responses')
        .update(responsePatch)
        .eq('id', responseId);
      if (error) {
        return NextResponse.json({ error: 'Falha ao salvar o lead' }, { status: 500 });
      }
    } else {
      const { data: inserted, error } = await db
        .from('lead_form_responses')
        .insert({
          form_id: form.id,
          account_id: form.account_id,
          ...responsePatch,
          completed_at: null,
        })
        .select('id')
        .single();
      if (error || !inserted) {
        return NextResponse.json({ error: 'Falha ao salvar o lead' }, { status: 500 });
      }
      responseId = (inserted as { id: string }).id;
    }

    try {
      const { contactId, dealId } = await syncLeadRecords(db, {
        accountId: form.account_id,
        ownerId: form.user_id,
        formName: form.name,
        contact,
        company: typeof body.answers.empresa === 'string' ? body.answers.empresa : null,
        tracking,
        settings: form.settings as LeadSyncSettings,
        existingContactId: existing?.contact_id ?? null,
        existingDealId: existing?.deal_id ?? null,
      });
      if (contactId || dealId) {
        await db
          .from('lead_form_responses')
          .update({ contact_id: contactId, deal_id: dealId })
          .eq('id', responseId);
      }
    } catch (err) {
      console.error('[lead-forms] partial contact/deal:', err instanceof Error ? err.message : err);
    }

    return NextResponse.json({ response_id: responseId, partial: true });
  }

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

  // Envio final pode concluir a resposta criada no salvamento parcial
  // (status `started`). Sem `response_id` válido, cria uma nova.
  let existingResponse: LeadFormResponseRow | null = null;
  if (requestedResponseId) {
    const { data } = await db
      .from('lead_form_responses')
      .select('id, status, contact_id, deal_id')
      .eq('id', requestedResponseId)
      .eq('form_id', form.id)
      .maybeSingle();
    existingResponse = (data as LeadFormResponseRow | null) ?? null;
  }
  // Sem id (reload em outra aba, storage limpo): adota a resposta em
  // andamento do mesmo telefone para não duplicar resposta/negócio.
  if (!existingResponse && contact.phone) {
    const { data: recent } = await db
      .from('lead_form_responses')
      .select('id, status, contact_id, deal_id')
      .eq('form_id', form.id)
      .eq('status', 'started')
      .eq('respondent_phone', contact.phone)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    existingResponse = (recent as LeadFormResponseRow | null) ?? null;
  }
  const isFirstCompletion = !existingResponse || existingResponse.status === 'started';
  const finalStatus = isQualified
    ? (existingResponse?.status === 'booked' ? 'booked' : 'qualified')
    : (existingResponse?.status === 'booked' ? 'booked' : 'disqualified');

  const responseFields = {
    answers: body.answers,
    score,
    is_qualified: isQualified,
    status: finalStatus,
    respondent_name: contact.name ?? null,
    respondent_email: contact.email ?? null,
    respondent_phone: contact.phone ?? null,
    tracking,
    ip: getClientIp(req),
    user_agent: req.headers.get('user-agent')?.slice(0, 500) ?? null,
    completed_at: new Date().toISOString(),
  };

  let responseId: string;
  if (existingResponse) {
    const { error: respErr } = await db
      .from('lead_form_responses')
      .update(responseFields)
      .eq('id', existingResponse.id);
    if (respErr) {
      return NextResponse.json({ error: 'Falha ao salvar resposta' }, { status: 500 });
    }
    responseId = existingResponse.id;
  } else {
    const { data: response, error: respErr } = await db
      .from('lead_form_responses')
      .insert({
        form_id: form.id,
        account_id: form.account_id,
        ...responseFields,
      })
      .select()
      .single();
    if (respErr || !response) {
      return NextResponse.json({ error: 'Falha ao salvar resposta' }, { status: 500 });
    }
    responseId = (response as { id: string }).id;
  }

  // Contadores só na primeira conclusão — um retry do envio final não
  // pode inflar "Respostas". O salvamento parcial também não conta.
  if (isFirstCompletion) {
    void bumpFormCounter(db, form.id, 'response');
    if (isQualified) void bumpFormCounter(db, form.id, 'qualified');
  }

  // Cria/atualiza contato + deal reaproveitando o que o salvamento
  // parcial já criou (sem duplicar contato nem card no pipeline).
  let contactId: string | null = existingResponse?.contact_id ?? null;
  let dealId: string | null = existingResponse?.deal_id ?? null;
  try {
    const synced = await syncLeadRecords(db, {
      accountId: form.account_id,
      ownerId: form.user_id,
      formName: form.name,
      contact,
      company: typeof body.answers.empresa === 'string' ? body.answers.empresa : null,
      tracking,
      settings: form.settings as LeadSyncSettings,
      existingContactId: contactId,
      existingDealId: dealId,
    });
    contactId = synced.contactId;
    dealId = synced.dealId;
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
  if (isFirstCompletion && metaCfg.fire_lead !== false) {
    capiSends.push(
      fireFormCapiEvent({
        accountId: form.account_id, formId: form.id, responseId, event: 'Lead',
        ...baseUser, eventId: sharedEventId,
        custom: { form_name: form.name, score, qualified: isQualified, utm_campaign: trk.utm_campaign, ...attrCustom },
      }).then((eid) => ({ key: 'lead', eid }))
    );
  }
  if (isFirstCompletion && isQualified && metaCfg.fire_complete_registration !== false) {
    capiSends.push(
      fireFormCapiEvent({
        accountId: form.account_id, formId: form.id, responseId, event: 'CompleteRegistration',
        ...baseUser, eventId: `${sharedEventId}_complete`,
        custom: { form_name: form.name, score, ...attrCustom },
      }).then((eid) => ({ key: 'complete_registration', eid }))
    );
  }
  if (isFirstCompletion && isQualified && metaCfg.fire_qualified !== false) {
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

  // Webhook externo (fire-and-forget) — só na primeira conclusão.
  const webhook = (form.settings as { webhook_url?: string | null }).webhook_url;
  if (isFirstCompletion && webhook) {
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
