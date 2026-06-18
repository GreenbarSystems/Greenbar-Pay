/**
 * Shared Idempotency-Key wrapper for mutating endpoints (upload,
 * approve, reject, export, PATCH review). Method is now explicit so
 * the same key replayed against a different verb hashes differently
 * — PR2 wires PATCH through this same wrapper.
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
  method: string = req.method,
): Promise<NextResponse> {
  const key = req.headers.get("Idempotency-Key");
  const requestHash = key ? hashRequest(method, path, body) : "";

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
