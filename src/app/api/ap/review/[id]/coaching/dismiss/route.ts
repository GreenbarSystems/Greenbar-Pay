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
 * No body validation against the coaching prompts on the row — the UI
 * passes the prompt's `code`, we accept any string that matches the
 * known CoachingCode union, and let downstream queries decide whether
 * a dismissal of a non-existent code matters (it doesn't).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { requireUuid } from "@/lib/route-helpers";

const DismissSchema = z.object({
  /** Stable coaching code, e.g. "terms_mismatch". */
  promptCode: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/i, "code must be alphanumeric"),
  /** Briefing card the prompt belonged to — bind the dismissal to the
   * exact card the approver saw. Null means "current card" — auditor
   * has to resolve via timestamp + extractedInvoiceId. */
  briefingCardId: z.string().uuid().nullable(),
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

  await withOrg(organizationId, async (tx) => {
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
  });

  return NextResponse.json({ status: "logged" }, { status: 200 });
}
