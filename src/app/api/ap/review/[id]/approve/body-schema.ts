/**
 * Phase 11 — F02 Stop Work Authority body schema.
 *
 * Lives in its own module (rather than inline in route.ts) so the
 * Phase 11.2 modal-contract test can verify UI/route agreement
 * without pulling auth.ts, drizzle, or pg-boss at test-import time.
 *
 * When blocking findings exist, the route refuses unless the body
 * includes a justification of at least 20 chars (the DB CHECK
 * constraint echoes this floor). Body is optional on the happy path —
 * clean approves don't touch it.
 */
import { z } from "zod";

export const OVERRIDE_MIN_JUSTIFICATION_CHARS = 20;
export const OVERRIDE_MAX_JUSTIFICATION_CHARS = 2000;

export const ApproveBodySchema = z
  .object({
    overrideJustification: z
      .string()
      .min(
        OVERRIDE_MIN_JUSTIFICATION_CHARS,
        `justification must be at least ${OVERRIDE_MIN_JUSTIFICATION_CHARS} characters`,
      )
      .max(OVERRIDE_MAX_JUSTIFICATION_CHARS)
      .optional(),
    secondApproverId: z.string().uuid().optional(),
  })
  .partial();

export type ApproveBody = z.infer<typeof ApproveBodySchema>;
