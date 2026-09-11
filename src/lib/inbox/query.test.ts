import { describe, it, expect, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  fetchInboxPage,
  appendInboxPage,
  searchPattern,
  type InboxQuery,
} from './query';
import type { Conversation } from '@/types';

const filters: InboxQuery = {
  search: '',
  status: 'all',
  source: 'all',
  tagIds: [],
  company: null,
};
const signal = () => new AbortController().signal;
function client(fetcher: typeof fetch) {
  return createClient('https://example.supabase.co', 'test-key', {
    global: { fetch: fetcher },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const row = (id: string) =>
  ({
    id,
    unread_count: 0,
    status: 'open',
    contact: null,
  }) as unknown as Conversation;

describe('inbox server pagination', () => {
  it('downloads just one page from a 3207-conversation account, then loads older rows on demand', async () => {
    const all = Array.from({ length: 3207 }, (_, i) => row(String(i)));
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const start = Number(url.searchParams.get('offset'));
      return json(
        all.slice(start, start + Number(url.searchParams.get('limit')))
      );
    });
    const db = client(transport);
    const first = await fetchInboxPage(db, filters, 0, signal());
    expect(first.map((r) => r.id)).toEqual(all.slice(0, 50).map((r) => r.id));
    expect(transport).toHaveBeenCalledTimes(1);
    const old = await fetchInboxPage(db, filters, 3200, signal());
    expect(old.at(-1)?.id).toBe('3206');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(transport.mock.calls[0][0])).searchParams.get('order')
    ).toBe('last_message_at.desc.nullslast,id.asc');
  });

  it('sends tags, company, channel, status and history search to the server in the same bounded request', async () => {
    const transport = vi.fn<typeof fetch>(async () => json([row('old-match')]));
    const rows = await fetchInboxPage(
      client(transport),
      {
        ...filters,
        search: 'old contact',
        status: 'unread',
        source: 'uazapi',
        tagIds: ['vip', 'customer'],
        company: 'Acme',
      },
      0,
      signal()
    );
    expect(rows[0].id).toBe('old-match');
    expect(transport).toHaveBeenCalledTimes(1);
    const params = new URL(String(transport.mock.calls[0][0])).searchParams;
    expect(params.get('limit')).toBe('50');
    expect(params.get('select')).toContain(
      'tag_contact:contacts!inner(contact_tags!inner())'
    );
    expect(params.get('tag_contact.contact_tags.tag_id')).toBe(
      'in.(vip,customer)'
    );
    expect(params.get('contact.company')).toBe('eq.Acme');
    expect(params.get('contact')).toBe('not.is.null');
    expect(params.get('unread_count')).toBe('gt.0');
    expect(params.get('channel_messages.source')).toBe('eq.uazapi');
    expect(params.get('or')).toContain(
      'or(source.eq.uazapi,channel_messages.not.is.null)'
    );
    expect(params.get('or')).toContain(
      'search_contact.not.is.null,search_messages.not.is.null'
    );
    expect(params.get('search_messages.or')).toContain('content_text.ilike.');
    expect(params.get('search_contact.or')).toContain(
      'phone_normalized.ilike.'
    );
  });

  it('reports a HTML 403 without retrying the base table or fetching more pages', async () => {
    const transport = vi.fn<typeof fetch>(
      async () => new Response('<h1>403 Forbidden</h1>', { status: 403 })
    );
    await expect(
      fetchInboxPage(client(transport), filters, 0, signal())
    ).rejects.toMatchObject({ status: 403 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('falls back only when the view is missing and preserves pagination and filters', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ code: 'PGRST205', message: 'Missing view' }, 404)
      )
      .mockResolvedValueOnce(json([row('old')]));
    await fetchInboxPage(
      client(transport),
      { ...filters, status: 'closed' },
      100,
      signal()
    );
    expect(transport).toHaveBeenCalledTimes(2);
    const url = new URL(String(transport.mock.calls[1][0]));
    expect(url.pathname).toBe('/rest/v1/conversations');
    expect(url.searchParams.get('offset')).toBe('100');
    expect(url.searchParams.get('status')).toBe('eq.closed');
  });

  it('passes cancellation to the transport and does not trigger fallback', async () => {
    const controller = new AbortController();
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(
      fetchInboxPage(client(transport), filters, 0, controller.signal)
    ).rejects.toBeDefined();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('preserves realtime updates and deduplicates overlapping pages', () => {
    const updated = { ...row('1'), unread_count: 5 };
    expect(appendInboxPage([updated], [row('1'), row('2')])).toEqual([
      updated,
      row('2'),
    ]);
  });

  it('quotes commas and parentheses in search text and escapes percent and underscore', () => {
    const pattern = searchPattern('  ACME, (VIP)  ');
    expect(JSON.parse(pattern)).toBe('%ACME, (VIP)%');
    expect(JSON.parse(searchPattern('50%_'))).toBe('%50\\%\\_%');
  });
});
