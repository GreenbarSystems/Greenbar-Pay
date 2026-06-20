/**
 * Phase 10 — D5: POST /api/ap/review/:id/coaching/dismiss
 *
 * Records a reviewer's dismissal of a coaching prompt. Dismissal is
 * session-only at the UI layer — refreshing brings the prompt back —
 * but the audit event makes the action durably visible to compliance.
 *
 * The spec emphasises "dismissible but logged"; this is the logging
 * half. Durable per-user-per-card hide state is a Phase 10.1 concern
 * if pilot users complain.
 *
 * PR15 H-Dismiss-Anchor — briefingCardId is now REQUIRED and the
 * promptCode must match a prompt on the referenced card before the
 * audit row is written. Without this, the audit log could carry
 * dismissals against superseded cards or against codes the active
 * briefing never emitted, leaving the chain "approver saw X →
 * dismissed Y" unresolvable when an auditor reads it.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { auditEvents, briefingCards } from "@/db/schema";
import { requireUuid } from "@/lib/route-helpers";

const DismissSchema = z.object({
  /** Stable coaching code, e.g. "terms_mismatch". */
  promptCode: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/i, "code must be alphanumeric"),
  /** Briefing card the prompt belonged to — required so the dismissal
   *  is anchored to the exact card the approver saw. PR15 — was
   *  previously nullable. */
  briefingCardId: z.string().uuid(),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const bad = requireUuid(params.id);
  if (bad) return bad;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { organizationId, id: userId } = session.user;

  let body;
  try {
    body = DismissSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", issues: (err as z.ZodError).issues },
      { status: 400 },
    );
  }

  const result = await withOrg(organizationId, async (tx) => {
    // PR15 H-Dismiss-Anchor — verify the referenced card (a) exists in
    // this org, (b) is bound to this invoice, and (c) actually carries
    // the prompt code the caller is dismissing. The briefing card row
    // is org-scoped via RLS; this query adds the (invoice, promptCode)
    // checks. If the card was superseded we still accept the dismissal
    // because the approver saw THAT card — the dismissal is a
    // historical fact about that specific snapshot.
    const [card] = await tx
      .select({
        id: briefingCards.id,
        coachingPromptsJson: briefingCards.coachingPromptsJson,
      })
      .from(briefingCards)
      .where(
        and(
          eq(briefingCards.id, body.briefingCardId),
          eq(briefingCards.extractedInvoiceId, params.id),
        ),
      )
      .limit(1);
    if (!card) {
      return { status: "card_not_found" as const };
    }
    const prompts = Array.isArray(card.coachingPromptsJson)
      ? (card.coachingPromptsJson as Array<{ code?: string }>)
      : [];
    if (!prompts.some((p) => p.code === body.promptCode)) {
      return { status: "prompt_not_on_card" as const };
    }

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "user",
      actorId: userId,
      action: "coaching.prompt_dismissed",
      entityType: "extracted_invoice",
      entityId: params.id,
      metadataJson: {
        promptCode: body.promptCode,
        briefingCardId: body.briefingCardId,
      },
    });
    return { status: "logged" as const };
  });

  if (result.status === "card_not_found") {
    return NextResponse.json(
      { error: "card_not_found" },
      { status: 404 },
    );
  }
  if (result.status === "prompt_not_on_card") {
    return NextResponse.json(
      { error: "prompt_not_on_card" },
      { status: 422 },
    );
  }
  return NextResponse.json({ status: "logged" }, { status: 200 });
}
