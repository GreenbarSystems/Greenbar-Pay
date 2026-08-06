/**
 * GET /api/healthz — operations health probe.
 *
 * Public, unauthenticated — deliberately, so a load balancer / k8s probe
 * can hit it with no session. Returns just {status, timestamp} to anyone.
 *
 * The per-dependency detail (checks.db/s3/anthropic, including error
 * text) is gated behind HEALTHZ_TOKEN: those error messages can echo
 * DB host/connection info or the S3 bucket name, so they're only worth
 * showing to whoever's actually monitoring this, not the open internet.
 * Unset HEALTHZ_TOKEN → detail never renders, for anyone.
 *
 * Anthropic isn't pinged — a healthcheck shouldn't burn quota or risk
 * tripping the circuit breaker on a transient 5xx. We only confirm an
 * API key is present in the env.
 *
 * Overall status:
 *   "ok"       — every check returned ok
 *   "degraded" — Anthropic key missing (the API still serves cached briefs
 *                + non-LLM surfaces), but DB or S3 are down
 *   "down"     — DB or S3 unreachable; the app cannot meaningfully serve
 *
 * HTTP status:
 *   200 on "ok" or "degraded" (load balancer keeps the pod in rotation
 *        for any still-functional surface)
 *   503 on "down" (LB drains)
 *
 * The handler is deliberately fast: parallel checks, individual timeouts,
 * no auth lookup on the DB. Anything operationally meaningful should
 * appear within 2s even when a downstream is hung.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { rawAdminDb } from "@/db/internal/rawClient";
import { storage } from "@/lib/storage";

// Each check returns the same shape so the response payload is regular.
interface CheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

const CHECK_TIMEOUT_MS = 2_000;

// pg + aws-sdk both throw Errors whose `.message` can be empty (the cause
// is on `.cause` or `.code`). Fall through to those so the healthz response
// is never `error: ""` — which reads as "an error happened but we don't
// know what," the worst possible thing for an operator triaging an outage.
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.message) return err.message;
    const code = (err as { code?: string }).code;
    if (code) return code;
    if (err.cause) return errorMessage(err.cause);
    return err.name || "Error";
  }
  return String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function checkDb(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    await withTimeout(
      rawAdminDb.execute(sql`select 1`),
      CHECK_TIMEOUT_MS,
      "db",
    );
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: errorMessage(err),
    };
  }
}

async function checkS3(): Promise<CheckResult> {
  try {
    return await withTimeout(storage.healthCheck(), CHECK_TIMEOUT_MS, "s3");
  } catch (err) {
    return {
      ok: false,
      latencyMs: CHECK_TIMEOUT_MS,
      error: errorMessage(err),
    };
  }
}

function checkAnthropicKey(): CheckResult {
  const t0 = Date.now();
  const key = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  // Sanity check on shape — real Anthropic keys are ≥80 chars after the
  // `sk-ant-` prefix and use [A-Za-z0-9_-]. The 40-char floor here is a
  // heuristic that rejects every placeholder we've seen (.env.example's
  // "sk-ant-replace-me", developers' "sk-ant-not-real-…") without locking
  // us to a specific version segment that Anthropic may evolve.
  const looksReal = /^sk-ant-[A-Za-z0-9_-]{40,}$/.test(key);
  return {
    ok: looksReal,
    latencyMs: Date.now() - t0,
    error: !key
      ? "ANTHROPIC_API_KEY not set"
      : !looksReal
        ? "ANTHROPIC_API_KEY looks like a placeholder (expected ≥40 chars after sk-ant-)"
        : undefined,
  };
}

function hasValidHealthzToken(req: Request): boolean {
  const configured = process.env.HEALTHZ_TOKEN;
  if (!configured) return false;
  const provided = req.headers.get("x-healthz-token") ?? "";
  const a = Buffer.from(configured);
  const b = Buffer.from(provided);
  // timingSafeEqual throws on length mismatch rather than returning
  // false, and requires equal-length buffers — check that first.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  const [db, s3] = await Promise.all([checkDb(), checkS3()]);
  const anthropic = checkAnthropicKey();

  // DB or S3 down → "down" (can't read/write documents). Anthropic
  // missing → "degraded" (review surfaces still work, only new
  // extraction is blocked).
  const status: "ok" | "degraded" | "down" = !db.ok || !s3.ok
    ? "down"
    : !anthropic.ok
      ? "degraded"
      : "ok";

  const body = hasValidHealthzToken(req)
    ? { status, timestamp: new Date().toISOString(), checks: { db, s3, anthropic } }
    : { status, timestamp: new Date().toISOString() };

  return NextResponse.json(body, {
    status: status === "down" ? 503 : 200,
    headers: {
      // Operators may scrape this from an external monitor; we don't
      // want a CDN to cache a transient "down" beyond its window.
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
