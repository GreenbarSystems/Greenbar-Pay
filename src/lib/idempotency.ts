/**
 * API-level idempotency (addendum §4.6). Cache mutating responses for 24h
 * keyed by client-supplied Idempotency-Key.
 *
 *   Same key + same request hash → return cached response (replay-safe).
 *   Same key + different request hash → 409 Conflict.
 *   No key → request proceeds (one-shot mutation).
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiIdempotencyKeys } from "@/db/schema";
import { withOrg, type Tx } from "@/db/client";

export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(method)
    .update("\n")
    .update(path)
    .update("\n")
    .update(typeof body === "string" ? body : JSON.stringify(body ?? null))
    .digest("hex");
}

export type CachedResponse = { status: number; body: unknown };

export async function readIdempotencyKey(
  organizationId: string,
  key: string,
  requestHash: string,
): Promise<
  | { kind: "miss" }
  | { kind: "hit"; response: CachedResponse }
  | { kind: "conflict" }
> {
  return withOrg(organizationId, async (tx: Tx) => {
    const rows = await tx
      .select()
      .from(apiIdempotencyKeys)
      .where(
        and(
          eq(apiIdempotencyKeys.key, key),
          eq(apiIdempotencyKeys.organizationId, organizationId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return { kind: "miss" } as const;
    if (row.requestHash !== requestHash) return { kind: "conflict" } as const;
    return {
      kind: "hit" as const,
      response: { status: row.responseStatus, body: row.responseBody },
    };
  });
}

export async function writeIdempotencyKey(
  organizationId: string,
  key: string,
  requestHash: string,
  response: CachedResponse,
  tx?: Tx,
): Promise<void> {
  const insert = async (t: Tx) => {
    await t
      .insert(apiIdempotencyKeys)
      .values({
        key,
        organizationId,
        requestHash,
        responseStatus: response.status,
        responseBody: response.body as object,
      })
      .onConflictDoNothing({ target: apiIdempotencyKeys.key });
  };
  if (tx) await insert(tx);
  else await withOrg(organizationId, insert);
}
