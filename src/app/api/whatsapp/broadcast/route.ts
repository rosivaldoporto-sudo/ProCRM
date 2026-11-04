import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canWriteWithRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import {
  MEDIA_UNAVAILABLE_ERROR,
  resolveMetaMediaId,
} from '@/lib/whatsapp/media-id-resolver'
import { decrypt } from '@/lib/whatsapp/encryption'
import { persistBroadcastMessageIfConversationExists } from '@/lib/whatsapp/broadcast-inbox'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  /** True once this route has saved the Meta id on the recipient row. */
  recorded?: boolean
  error?: string
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  phone: string
  /** Body variable values, one per {{N}}. Legacy field. */
  params?: string[]
  /**
   * Structured per-send values (header text variable, media URL
   * override, URL/COPY_CODE button values). When set, takes
   * precedence over `params` for the body too — see
   * sendTemplateMessage for the merge rules.
   */
  messageParams?: SendTimeParams
  /**
   * The `broadcast_recipients` row this send belongs to. When set, the
   * Meta id is saved on it right after the send.
   */
  recipient_id?: string
}

/**
 * Saves the Meta id on the recipient as soon as Meta returns it. The webhook
 * finds a recipient only by this id, and a receipt it can't match is lost, so
 * this can't wait for the batch to return to the browser.
 *
 * Runs on the caller's session, so RLS limits the write to their account.
 * Returns false when nothing was saved; the browser then records it instead.
 */
async function recordSentRecipient(
  supabase: Awaited<ReturnType<typeof createClient>>,
  recipientId: string,
  messageId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('broadcast_recipients')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      whatsapp_message_id: messageId,
      error_message: null,
    })
    .eq('id', recipientId)
    .eq('status', 'pending')
    .select('id')

  if (error) {
    console.error(
      `Failed to record broadcast recipient ${recipientId}:`,
      error.message,
    )
    return false
  }
  return (data?.length ?? 0) > 0
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }

    // Per-user budget per batch: a campaign makes one call for every 10
    // recipients, so this can't be a budget of campaigns per minute.
    const limit = checkRateLimit(
      `broadcast-batch:${user.id}`,
      RATE_LIMITS.broadcastBatch,
    )
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. whatsapp_config + templates
    // + broadcasts are all account-scoped post-multi-user, so the
    // old `.eq('user_id', user.id)` filters miss every row created
    // by a teammate.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id, account_role')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Seu perfil não está vinculado a uma conta.' },
        { status: 403 },
      )
    }
    // Viewers are read-only: the role is enforced here, not only in the UI.
    if (!canWriteWithRole(profile?.account_role)) {
      return NextResponse.json(
        { error: "Esta ação exige o papel de agente ou superior" },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
    } = body

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Informe os destinatários em uma lista não vazia',
        },
        { status: 400 }
      )
    }

    // Teto de fan-out por chamada: o assistente envia lotes de 10. Junto
    // com RATE_LIMITS.broadcastBatch, limita as mensagens por minuto.
    const MAX_RECIPIENTS = 50
    if (recipients.length > MAX_RECIPIENTS) {
      return NextResponse.json(
        { error: `Cada chamada aceita até ${MAX_RECIPIENTS} destinatários` },
        { status: 400 }
      )
    }
    for (const raw of recipients) {
      const r = raw as
        | { phone?: unknown; params?: unknown; recipient_id?: unknown }
        | null
        | undefined;
      const params = typeof r === 'object' && r !== null ? r.params : undefined;
      if (
        r == null ||
        typeof r !== 'object' ||
        typeof r.phone !== 'string' ||
        (r.recipient_id !== undefined && typeof r.recipient_id !== 'string') ||
        (params !== undefined &&
          (!Array.isArray(params) ||
            params.length > 20 ||
            params.some(
              (p: unknown) => typeof p !== 'string' || p.length > 1024
            )))
      ) {
        return NextResponse.json(
          { error: 'Destinatários inválidos (telefone e até 20 parâmetros de 1024 caracteres)' },
          { status: 400 }
        )
      }
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'Informe o nome do modelo' },
        { status: 400 }
      )
    }

    if (
      typeof template_name !== 'string' ||
      template_name.length > 512 ||
      !/^[a-z0-9_]+$/i.test(template_name)
    ) {
      return NextResponse.json({ error: 'Nome de modelo inválido' }, { status: 400 })
    }

    if (
      template_language !== undefined &&
      (typeof template_language !== 'string' ||
        template_language.length > 16 ||
        !/^[a-z]{2}(_[A-Z]{2})?$/.test(template_language))
    ) {
      return NextResponse.json({ error: 'Idioma de modelo inválido' }, { status: 400 })
    }

    const { data: config, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp não configurado. Configure sua integração com o WhatsApp primeiro.',
        },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Load the template row once so sendTemplateMessage can build
    // header + button components on each iteration. Loading inside
    // the loop would N+1 against Supabase for every recipient.
    // Guard against a malformed local row crashing every send in
    // the loop with the same opaque TypeError — fail loudly once.
    const { data: rawTemplateRow } = await supabase
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', template_name)
      .eq('language', template_language || 'en_US')
      .maybeSingle()
    if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
      return NextResponse.json(
        {
          error:
            'O modelo está inconsistente: execute "Sincronizar da Meta" em Configurações antes de transmitir.',
        },
        { status: 500 },
      )
    }
    const templateRow = rawTemplateRow ?? null

    // ============================================================
    // Media-header sends: resolve each public media URL to a Meta
    // media id ONCE per request. Sending by `link` makes Meta download
    // the file from our storage for EVERY recipient — the Storage
    // egress blow-up on the Oct-15 video broadcast. So a failure here
    // stops the request before anything is sent. The wizard normally
    // arrives with the id already prepared (see ./media/route.ts).
    // ============================================================
    const headerType = templateRow?.header_type as string | undefined
    const mediaHeaderKind =
      headerType === 'image' ||
      headerType === 'video' ||
      headerType === 'document'
        ? headerType
        : null
    const templateMediaUrl = (
      templateRow?.header_media_url as string | null | undefined
    )?.trim()

    const mediaIdByUrl = new Map<string, string>()
    if (mediaHeaderKind) {
      const urls = new Set<string>()
      for (const recipient of recipients) {
        // A caller-supplied id already avoids the per-recipient
        // download — leave it alone.
        if (recipient.messageParams?.headerMediaId) continue
        const url =
          recipient.messageParams?.headerMediaUrl?.trim() || templateMediaUrl
        if (url) urls.add(url)
      }
      const admin = supabaseAdmin()
      for (const url of urls) {
        const mediaId = await resolveMetaMediaId({
          db: admin,
          accountId,
          phoneNumberId: config.phone_number_id,
          accessToken,
          sourceUrl: url,
          kind: mediaHeaderKind,
        })
        if (!mediaId) {
          return NextResponse.json(
            { error: MEDIA_UNAVAILABLE_ERROR },
            { status: 502 },
          )
        }
        mediaIdByUrl.set(url, mediaId)
      }
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Formato de telefone inválido',
        })
        failedCount++
        continue
      }

      // Retry with phone variants on "not in allowed list" so numbers
      // that differ only in a trunk-prefix 0 still reach recipients.
      const variants = phoneVariants(sanitized)
      // Swap the public URL for the pre-resolved Meta media id when we
      // have one — the send builder emits `{ id }` instead of `{ link }`,
      // so Meta never re-downloads the file per recipient.
      let messageParams = recipient.messageParams
      if (mediaHeaderKind && !messageParams?.headerMediaId) {
        const url = messageParams?.headerMediaUrl?.trim() || templateMediaUrl
        const mediaId = url ? mediaIdByUrl.get(url) : undefined
        if (mediaId) {
          messageParams = { ...messageParams, headerMediaId: mediaId }
        }
      }
      let sentMessageId: string | null = null
      let lastError: string | null = null

      for (const variant of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: template_name,
            language: template_language || 'en_US',
            template: templateRow ?? undefined,
            messageParams,
            params: recipient.params ?? [],
          })
          sentMessageId = result.messageId
          lastError = null
          break
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Erro desconhecido'
          if (!isRecipientNotAllowedError(errorMessage)) {
            lastError = errorMessage
            break
          }
          lastError = errorMessage
          // retry with next variant
        }
      }

      if (sentMessageId) {
        const recorded = recipient.recipient_id
          ? await recordSentRecipient(
              supabase,
              recipient.recipient_id,
              sentMessageId,
            )
          : false

        // Transmissão não cria conversa no inbox: a conversa nasce na
        // resposta do cliente (webhook inbound). Se o número já tem
        // conversa aberta, a mensagem aparece na thread existente.
        try {
          // Render the template body with recipient's params
          const renderedBody = templateRow?.body_text
            ? templateRow.body_text.replace(/\{\{(\d+)\}\}/g, (_match: string, raw: string) => {
                const idx = Number(raw) - 1;
                const value = (recipient.params ?? [])[idx];
                return value && value.trim().length > 0 ? value : `{{${raw}}}`;
              })
            : `[${template_name}]`;

          await persistBroadcastMessageIfConversationExists(
            supabaseAdmin(),
            {
              accountId,
              phone: sanitized,
              renderedBody,
              templateName: template_name,
              whatsappMessageId: sentMessageId,
            },
          )
        } catch (err) {
          console.error(
            `Failed to persist broadcast message for ${sanitized}:`,
            err instanceof Error ? err.message : err,
          )
        }

        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
          recorded,
        })
        sentCount++
      } else {
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          lastError
        )
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Erro desconhecido',
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json(
      { error: 'Falha ao processar a transmissão' },
      { status: 500 }
    )
  }
}
