import type { SupabaseClient } from '@supabase/supabase-js';
import { CONVERSATION_SELECT, normalizeConversations } from './conversations';
import type { Conversation, ConversationStatus } from '@/types';

export const INBOX_PAGE_SIZE = 50;
export interface InboxQuery {
  search: string;
  status: ConversationStatus | 'all' | 'unread' | 'awaitingReply';
  source: 'all' | 'whatsapp' | 'uazapi';
  tagIds: string[];
  company: string | null;
}

// Quote PostgREST grammar and escape LIKE wildcards: user input is literal text.
export function searchPattern(value: string) {
  return JSON.stringify('%' + value.trim().replace(/[\\%_*]/g, '\\$&') + '%');
}

export function buildInboxQuery(
  db: SupabaseClient,
  filters: InboxQuery,
  offset: number,
  table = 'inbox_conversations'
) {
  const search = filters.search.trim();
  let select = CONVERSATION_SELECT;
  if (search) select += ',search_contact:contacts(),search_messages:messages()';
  if (filters.source !== 'all') select += ',channel_messages:messages()';
  if (filters.tagIds.length)
    select += ',tag_contact:contacts!inner(contact_tags!inner())';
  let query = db.from(table).select(select);
  const conditions: string[] = [];
  if (search) {
    const pattern = searchPattern(search);
    query = query
      .or(
        ['name', 'phone', 'phone_normalized']
          .map((field) => field + '.ilike.' + pattern)
          .join(','),
        { referencedTable: 'search_contact' }
      )
      .or('content_text.ilike.' + pattern + ',template_name.ilike.' + pattern, {
        referencedTable: 'search_messages',
      });
    conditions.push(
      'or(last_message_text.ilike.' +
        pattern +
        ',search_contact.not.is.null,search_messages.not.is.null)'
    );
  }
  if (filters.source !== 'all') {
    query = query.eq('channel_messages.source', filters.source);
    conditions.push(
      'or(source.eq.' + filters.source + ',channel_messages.not.is.null)'
    );
  }
  if (conditions.length) query = query.or('and(' + conditions.join(',') + ')');
  if (filters.tagIds.length)
    query = query.in('tag_contact.contact_tags.tag_id', filters.tagIds);
  if (filters.company !== null) {
    // The displayed contact join must be inner for a company filter to filter conversations.
    query = query
      .not('contact', 'is', null)
      .eq('contact.company', filters.company);
  }
  if (filters.status === 'unread') query = query.gt('unread_count', 0);
  else if (filters.status === 'awaitingReply')
    query =
      table === 'inbox_conversations'
        ? query.eq('last_message_sender_type', 'customer')
        : query.neq('status', 'closed');
  else if (filters.status !== 'all') query = query.eq('status', filters.status);
  return query
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('id')
    .range(offset, offset + INBOX_PAGE_SIZE - 1);
}

export async function fetchInboxPage(
  db: SupabaseClient,
  filters: InboxQuery,
  offset: number,
  signal: AbortSignal
) {
  let response = await buildInboxQuery(db, filters, offset).abortSignal(signal);
  // Only missing schema triggers compatibility fallback. Never retry permission,
  // rate-limit or network failures with another equally expensive query.
  if (
    !signal.aborted &&
    response.error &&
    ['42P01', 'PGRST205', 'PGRST200'].includes(response.error.code)
  ) {
    response = await buildInboxQuery(
      db,
      filters,
      offset,
      'conversations'
    ).abortSignal(signal);
  }
  if (response.error) {
    throw Object.assign(new Error('Inbox request failed'), {
      status: response.status,
      code: response.error.code,
    });
  }
  return normalizeConversations(
    (response.data ?? []) as unknown as Conversation[]
  );
}

export function appendInboxPage(current: Conversation[], page: Conversation[]) {
  const ids = new Set(current.map((row) => row.id));
  return [...current, ...page.filter((row) => !ids.has(row.id))];
}
