/**
 * Cursor-based pagination helpers for RSC list pages (review queue,
 * exports history, vendors list).
 *
 * Why cursor, not OFFSET: these tables grow unbounded (documented
 * scaling concern — see CLAUDE.md). OFFSET-based pagination gets
 * linearly slower as the offset grows (Postgres still has to scan and
 * discard every skipped row), and a cursor keyed on the same columns
 * as the ORDER BY turns "give me the next page" into an index range
 * scan that costs the same at page 1 as it does at page 10,000.
 *
 * Forward-only by design: no "previous page" link. For an internal AP
 * tool where the primary use case is scanning recent activity, this
 * is a deliberate scope cut — bidirectional cursor pagination needs
 * either a stack of prior cursors or a reverse-direction query variant
 * per page, real complexity for a "go back" feature nobody has asked
 * for. Every page's own filters (status tabs, etc.) link back to page
 * 1 with no cursor, so "start over" is always one click away.
 */

/**
 * Encodes an arbitrary JSON-serializable cursor payload as an opaque,
 * URL-safe string. Callers define their own cursor shape per page
 * (whatever columns that page's ORDER BY needs).
 */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Decodes a cursor produced by encodeCursor. Never throws — a
 * missing, malformed, or tampered cursor (hand-edited URL, a cursor
 * from a since-changed page shape) silently resolves to `null`, which
 * every call site treats as "no cursor: show page 1." A bad cursor
 * should degrade to the start of the list, not a 500.
 */
export function decodeCursor<T>(cursor: string | string[] | undefined): T | null {
  if (typeof cursor !== "string" || cursor.length === 0) return null;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Given a result set fetched with `limit(pageSize + 1)`, splits it
 * into the page to render (at most pageSize rows) and whether a next
 * page exists — without a separate COUNT(*) query.
 */
export function splitPage<T>(
  rows: T[],
  pageSize: number,
): { pageRows: T[]; hasNext: boolean } {
  if (rows.length > pageSize) {
    return { pageRows: rows.slice(0, pageSize), hasNext: true };
  }
  return { pageRows: rows, hasNext: false };
}
