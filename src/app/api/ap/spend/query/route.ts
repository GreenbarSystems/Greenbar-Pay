/**
 * POST /api/ap/spend/query — natural-language spend search.
 *
 * Body: { question: string }
 *
 * Extracts a structured SpendQueryIntent via the LLM gateway (Call 4),
 * then runs the corresponding Drizzle query inside withOrg. Returns the
 * query results plus the intent (so the client can show the explanation).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { dispatchSpendQueryExtraction } from "@/lib/llm";
import { buildSpendQuery } from "@/modules/spend/application/build-query";

const BodySchema = z.object({
  question: z.string().trim().min(1).max(500),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId } = session.user;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", issues: (err as z.ZodError).issues },
      { status: 400 },
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const outcome = await dispatchSpendQueryExtraction({
    organizationId,
    question: body.question,
    today,
  });

  if (outcome.kind === "quota_exceeded") {
    return NextResponse.json({ error: "quota_exceeded" }, { status: 429 });
  }
  if (outcome.kind === "circuit_open") {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }
  if (outcome.kind !== "succeeded") {
    return NextResponse.json({ error: "extraction_failed", kind: outcome.kind }, { status: 502 });
  }

  const intent = outcome.result;
  const queryResult = await withOrg(organizationId, (tx) =>
    buildSpendQuery(tx, intent, organizationId),
  );

  return NextResponse.json({
    intent,
    columns: queryResult.columns,
    rows: queryResult.rows,
    summary: queryResult.summary,
  });
}
