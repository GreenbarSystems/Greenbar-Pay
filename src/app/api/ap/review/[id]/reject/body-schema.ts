/**
 * PR19 — controlled-vocabulary rejection reason. Phase 11.2 moved this
 * out of route.ts so the modal-contract test can verify UI/route
 * agreement without pulling auth.ts, drizzle, or pg-boss at test
 * import time.
 *
 * The free-text `reason` field was a PII channel: reviewers could (and
 * did, per pilot review feedback) type vendor names, account numbers,
 * EINs, or personal notes about employees, all of which persisted
 * unscrubbed in audit_events.metadata_json. The fix is an enum of
 * canonical reject codes; an optional `note` field captures the
 * reviewer's free text but is capped and explicitly NOT stored on
 * audit_events (only on the rejected invoice row's warningsJson for
 * in-app context).
 *
 * The enum can be extended; each new code lands in the briefing
 * card's coaching prompts and the recompute job's vendor-pattern
 * analysis without a schema change.
 */
import { z } from "zod";

export const RejectReasonCode = z.enum([
  "not_an_invoice",
  "duplicate_submission",
  "wrong_vendor",
  "wrong_amount",
  "missing_information",
  "policy_violation",
  "other",
]);

export const REJECT_NOTE_MAX_CHARS = 280;

export const RejectSchema = z
  .object({
    reasonCode: RejectReasonCode.optional(),
    /** Optional free-text note. NOT persisted on audit_events. */
    note: z.string().max(REJECT_NOTE_MAX_CHARS).optional(),
    /**
     * Backward-compatibility — the prior client posted { reason:
     * string }. We accept it, coerce to reasonCode="other", and
     * discard the free text rather than persisting it on the audit
     * row.
     */
    reason: z.string().max(REJECT_NOTE_MAX_CHARS).optional(),
  })
  .refine((b) => b.reasonCode || b.reason, {
    message: "reasonCode or reason is required",
  })
  .transform((b) => ({
    reasonCode: b.reasonCode ?? "other",
    note: b.note,
  }));

export type RejectBody = z.infer<typeof RejectSchema>;
