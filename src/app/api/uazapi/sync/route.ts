import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { fetchChats } from '@/lib/uazapi/uazapi-client'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

export const maxDuration = 120

export async function POST() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json({ error: 'Profile not linked to an account.' }, { status: 403 })
    }

    const { data: config } = await supabase
      .from('uazapi_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config || config.status !== 'connected') {
      return NextResponse.json({ error: 'Uazapi is not connected.' }, { status: 400 })
    }

    const apiToken = decrypt(config.api_token)
    const ownerUserId = await resolveAuditUserId(supabase, accountId)

    // Fetch recent chats from Uazapi server
    const chats = await fetchChats({ serverUrl: config.server_url, apiToken, limit: 50 })

    if (chats.length === 0) {
      return NextResponse.json({ synced: 0, message: 'No chats found to sync.' })
    }

    let syncedCount = 0

    for (const chat of chats) {
      const phone = normalizePhone(chat.phone)
      if (!phone) continue

      // Find or create contact
      let contactId: string
      const existing = await findExistingContact(supabase, accountId, phone)
      if (existing) {
        contactId = existing.id
        if (chat.name && chat.name !== existing.name) {
          await supabase
            .from('contacts')
            .update({ name: chat.name, updated_at: new Date().toISOString() })
            .eq('id', existing.id)
        }
      } else {
        const { data: created, error: createErr } = await supabase
          .from('contacts')
          .insert({
            account_id: accountId,
            user_id: ownerUserId,
            phone,
            name: chat.name || phone,
          })
          .select('id')
          .single()

        if (createErr || !created) {
          if (isUniqueViolation(createErr)) {
            const raced = await findExistingContact(supabase, accountId, phone)
            if (!raced) continue
            contactId = raced.id
          } else {
            continue
          }
        } else {
          contactId = created.id
        }
      }

      // Find or create conversation with source='uazapi'
      const { data: existingConv } = await supabase
        .from('conversations')
        .select('id, source')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .maybeSingle()

      if (existingConv) {
        continue // Already exists — skip
      }

      const { error: convErr } = await supabase
        .from('conversations')
        .insert({
          account_id: accountId,
          user_id: ownerUserId,
          contact_id: contactId,
          source: 'uazapi',
          last_message_text: chat.lastMessage || null,
          last_message_at: chat.lastMessageAt ? new Date(chat.lastMessageAt).toISOString() : null,
          unread_count: chat.unreadCount || 0,
        })

      if (convErr) {
        if (isUniqueViolation(convErr)) continue // Race: already exists
        console.error('[uazapi-sync] conversation insert error:', convErr.message)
        continue
      }

      syncedCount++
    }

    return NextResponse.json({
      synced: syncedCount,
      found: chats.length,
      message: `Synced ${syncedCount} of ${chats.length} chats found.`,
    })
  } catch (error) {
    console.error('[uazapi-sync] error:', error)
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 })
  }
}
