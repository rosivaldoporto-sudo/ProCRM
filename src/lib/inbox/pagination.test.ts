import { describe, expect, it } from 'vitest';
import { fetchAllInboxPages } from './pagination';

describe('fetchAllInboxPages', () => {
  it.each([1000, 137])(
    'loads old matches beyond 3000 rows with a server cap of %i',
    async (cap) => {
      const rows = Array.from({ length: 3207 }, (_, id) => ({
        id,
        tag: id === 3206 ? 'old' : 'new',
      }));
      const result = await fetchAllInboxPages(async (from, to) => ({
        data: rows.slice(from, Math.min(to + 1, from + cap)),
        error: null,
      }));
      expect(result.data).toEqual(rows);
      expect(result.data?.filter((row) => row.tag === 'old')).toEqual([
        rows[3206],
      ]);
    }
  );

  it('does not return partial results when a later page fails', async () => {
    const error = { message: 'Connection failed' };
    const result = await fetchAllInboxPages(async (from) =>
      from === 0 ? { data: [{ id: 1 }], error: null } : { data: null, error }
    );
    expect(result).toEqual({ data: null, error });
  });

  it('discards an in-flight result after cancellation', async () => {
    let cancelled = false;
    let requests = 0;
    const result = await fetchAllInboxPages(
      async () => {
        requests++;
        cancelled = true;
        return { data: [{ id: 1 }], error: null };
      },
      () => cancelled
    );
    expect(result.data).toBeNull();
    expect(requests).toBe(1);
  });

  it('handles an empty inbox', async () => {
    expect(
      await fetchAllInboxPages(async () => ({ data: [], error: null }))
    ).toEqual({ data: [], error: null });
  });
});
