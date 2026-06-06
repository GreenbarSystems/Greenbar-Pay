/**
 * Shared Idempotency-Key wrapper for the small mutating endpoints
 * (approve, reject, future export). Mirrors the upload route's pattern
 * but factored out so we don't repeat the request-hash dance.
 */
import { NextResponse } from "next/server";
import {
  hashRequest,
  readIdempotencyKey,
  writeIdempotencyKey,
} from "@/lib/idempotency";

export async function withIdempotency<T>(
  req: Request,
  organizationId: string,
  path: string,
  body: unknown,
  handler: () => Promise<{ status: number; body: T }>,
): Promise<NextResponse> {
  const key = req.headers.get("Idempotency-Key");
  const requestHash = key ? hashRequest("POST", path, body) : "";

  if (key) {
    const hit = await readIdempotencyKey(organizationId, key, requestHash);
    if (hit.kind === "hit") {
      return NextResponse.json(hit.response.body, { status: hit.response.status });
    }
    if (hit.kind === "conflict") {
      return NextResponse.json(
        { error: "idempotency_key_conflict" },
        { status: 409 },
      );
    }
  }

  const result = await handler();
  if (key) {
    await writeIdempotencyKey(organizationId, key, requestHash, result);
  }
  return NextResponse.json(result.body, { status: result.status });
}
