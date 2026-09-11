/** Read every page, even when the server caps responses below our page size.
 * Callers must supply a fresh query with a stable, unique ordering per page.
 * Never publish a partial result after a failed request or cancellation.
 */
export async function fetchAllInboxPages<T, E>(
  fetchPage: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: E | null }>,
  isCancelled: () => boolean = () => false
): Promise<{ data: T[] | null; error: E | null }> {
  const rows: T[] = [];
  while (!isCancelled()) {
    const { data, error } = await fetchPage(rows.length, rows.length + 499);
    if (isCancelled()) return { data: null, error: null };
    if (error) return { data: null, error };
    if (!data?.length) return { data: rows, error: null };
    rows.push(...data);
  }
  return { data: null, error: null };
}
