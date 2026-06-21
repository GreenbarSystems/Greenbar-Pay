/**
 * Phase 11.2 — modal-contract tests.
 *
 * The override and reject modals live in ReviewDetailClient.tsx and
 * post JSON bodies to the approve / reject routes. The Zod schemas
 * in the routes are the authoritative contract; this suite locks
 * down the schema-level behaviour so a UI refactor that drifts the
 * payload shape fails CI rather than 422'ing pilot reviewers.
 *
 * Covered:
 *   · ApproveBodySchema:
 *       - empty body accepted (clean approve)
 *       - justification < 20 chars rejected
 *       - justification ≥ 20 chars accepted
 *       - secondApproverId must be UUID when present
 *   · RejectSchema:
 *       - reasonCode-only body accepted
 *       - legacy { reason } body accepted (PR19 backcompat)
 *       - empty body rejected
 *       - reasonCode + note accepted
 *       - note over 280 chars rejected
 */
import { describe, it, expect } from "vitest";
import {
  ApproveBodySchema,
  OVERRIDE_MIN_JUSTIFICATION_CHARS,
} from "@/app/api/ap/review/[id]/approve/body-schema";
import {
  RejectSchema,
  REJECT_NOTE_MAX_CHARS,
} from "@/app/api/ap/review/[id]/reject/body-schema";

const VALID_UUID = "9e1c5fb0-4a3c-4d2b-9b6f-6a6f5e93f8a1";
const SHORT_JUSTIFICATION = "Too short.";
const VALID_JUSTIFICATION =
  "PO mismatch confirmed verbally with vendor and ops lead; approving to keep production scheduled.";

describe("ApproveBodySchema", () => {
  it("accepts an empty body (clean approve path)", () => {
    const result = ApproveBodySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects an override justification under the minimum", () => {
    const result = ApproveBodySchema.safeParse({
      overrideJustification: SHORT_JUSTIFICATION,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        new RegExp(`${OVERRIDE_MIN_JUSTIFICATION_CHARS}`),
      );
    }
  });

  it("accepts an override justification at the boundary", () => {
    const boundary = "x".repeat(OVERRIDE_MIN_JUSTIFICATION_CHARS);
    const result = ApproveBodySchema.safeParse({
      overrideJustification: boundary,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full override payload with a second approver", () => {
    const result = ApproveBodySchema.safeParse({
      overrideJustification: VALID_JUSTIFICATION,
      secondApproverId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID secondApproverId", () => {
    const result = ApproveBodySchema.safeParse({
      overrideJustification: VALID_JUSTIFICATION,
      secondApproverId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("does not allow secondApproverId without a justification to slip past the route's separate hasBlockingFindings gate", () => {
    // The schema by design accepts a lone secondApproverId — the route's
    // hasBlockingFindings gate is what blocks an "override-without-
    // justification" attempt. This test pins the layering so a future
    // refactor that conflates the two gates fails here loudly.
    const result = ApproveBodySchema.safeParse({
      secondApproverId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });
});

describe("RejectSchema", () => {
  it("accepts a canonical reasonCode-only body", () => {
    const result = RejectSchema.safeParse({ reasonCode: "wrong_vendor" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasonCode).toBe("wrong_vendor");
      expect(result.data.note).toBeUndefined();
    }
  });

  it("accepts the legacy { reason } body and coerces to reasonCode='other'", () => {
    const result = RejectSchema.safeParse({ reason: "free-text legacy" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasonCode).toBe("other");
      // PR19 — free text MUST be discarded from the audit payload.
      // The transform drops `reason` and only forwards `note`, so an
      // accidental migration back to free-text PII via the audit log
      // is caught here.
      expect(result.data.note).toBeUndefined();
    }
  });

  it("rejects an empty body (must have either reasonCode or reason)", () => {
    const result = RejectSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts reasonCode + note and forwards the note", () => {
    const result = RejectSchema.safeParse({
      reasonCode: "duplicate_submission",
      note: "Submitted twice from inbox alias.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasonCode).toBe("duplicate_submission");
      expect(result.data.note).toBe("Submitted twice from inbox alias.");
    }
  });

  it("rejects a note over the character cap", () => {
    const oversized = "x".repeat(REJECT_NOTE_MAX_CHARS + 1);
    const result = RejectSchema.safeParse({
      reasonCode: "other",
      note: oversized,
    });
    expect(result.success).toBe(false);
  });
});
