/**
 * Briefing Card output schema (Phase 8 — D2 from updated MVP spec).
 *
 * Two representations of the same shape, kept in lockstep:
 *   - BriefingCardSchema       — Zod, used to decode tool_use.input
 *   - BRIEFING_TOOL_JSON_SCHEMA — passed to Anthropic tool-use so the
 *                                model is constrained at decode time.
 *
 * Per the spec §"Call 2 — Briefing Card Generation": output is
 * "structured Briefing Card JSON with GL rationale string, anomaly
 * flags array, delta summary string, and risk score integer with
 * justification string."
 *
 * Risk score note (Phase 8 design decision): the SCORE is deterministic,
 * computed by the job from validation findings + vendor signals. The
 * LLM only writes the JUSTIFICATION prose explaining the number. That
 * keeps the score reproducible across model regressions; the prose
 * stays human-friendly.
 */
import { z } from "zod";

export const AnomalyFlagSeverity = z.enum(["info", "warning", "critical"]);

/**
 * Phase 9 — F07: each step of the evidence chain. Labels are loose by
 * design (we don't want to force the model into a slot when the
 * underlying validation finding doesn't supply one), but the canonical
 * labels the prompt requests are: Evidence, This invoice, Trend signal,
 * Contract reference, Stddev distance, Recommendation. Length caps
 * mirror the existing message field so a long chain can't blow past
 * the briefing-card budget.
 */
const EvidenceStep = z.object({
  label: z.string().min(1).max(48),
  detail: z.string().min(1).max(280),
});

const AnomalyFlag = z.object({
  code: z
    .string()
    .max(64)
    .describe("Short machine-readable identifier, e.g. 'rate_variance'."),
  severity: AnomalyFlagSeverity,
  message: z
    .string()
    .min(1)
    .max(280)
    .describe("Plain-English explanation an approver can act on."),
  /**
   * Phase 9 — F07: structured reasoning trail per anomaly. Optional so
   * pre-Phase-9 briefing rows remain decodable, but the prompt now
   * requires it on every flag the model emits. Capped at 6 steps so a
   * runaway model can't unroll a vendor profile into prose here.
   */
  evidenceChain: z.array(EvidenceStep).max(6).optional(),
});

export const BriefingCardSchema = z.object({
  /**
   * Suggested GL account code (PRD's "GL Coding Rationale"). Null when
   * the model cannot make a defensible suggestion. The vendor's
   * default_gl_code is the natural prior; the model may still propose
   * a different code with rationale.
   */
  glCode: z.string().max(32).nullable(),
  glRationale: z
    .string()
    .min(1)
    .max(500)
    .describe("Why this GL coding — vendor history, keyword match, prior approvals."),
  /**
   * Plain-English anomaly flags drawn from validation findings + vendor
   * signals. The validator's structured findings drive what to flag;
   * the model phrases each one for an approver.
   */
  anomalyFlags: z.array(AnomalyFlag).max(20),
  /**
   * "What changed since the most recent invoice from this vendor."
   * Empty string when there's no prior invoice to compare to.
   */
  deltaSummary: z.string().max(500),
  /**
   * One-sentence justification of the deterministic risk score. The
   * job assembles `risk_score | justification` for the final UI; the
   * LLM only contributes prose, not the number.
   */
  riskJustification: z
    .string()
    .min(1)
    .max(280)
    .describe("One sentence explaining the score (no number — that's deterministic)."),
});

export type BriefingCardResult = z.infer<typeof BriefingCardSchema>;
export type BriefingCardAnomalyFlag = z.infer<typeof AnomalyFlag>;

/**
 * JSON Schema (Draft 2020-12) passed to Anthropic tool-use. Forces the
 * model to call `emit_briefing` whose input matches.
 */
export const BRIEFING_TOOL_JSON_SCHEMA = {
  type: "object",
  properties: {
    glCode: {
      type: ["string", "null"],
      description: "Suggested GL account code (e.g. '6200'). Null if unknown.",
    },
    glRationale: {
      type: "string",
      description:
        "Why this GL coding — reference vendor history, keyword match, or prior approvals.",
    },
    anomalyFlags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "Short machine-readable id, e.g. 'rate_variance', 'terms_mismatch'.",
          },
          severity: { type: "string", enum: ["info", "warning", "critical"] },
          message: {
            type: "string",
            description: "Plain-English explanation an approver can act on.",
          },
          evidenceChain: {
            type: "array",
            description:
              "Reasoning trail an approver can audit. Labelled steps grounded in the inputs.",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                detail: { type: "string" },
              },
              required: ["label", "detail"],
            },
          },
        },
        required: ["code", "severity", "message"],
      },
    },
    deltaSummary: {
      type: "string",
      description:
        "What changed vs the most recent prior invoice from this vendor. Empty string if none.",
    },
    riskJustification: {
      type: "string",
      description:
        "One sentence explaining the risk score. Do NOT include the number — that comes from the deterministic compute.",
    },
  },
  required: [
    "glCode",
    "glRationale",
    "anomalyFlags",
    "deltaSummary",
    "riskJustification",
  ],
} as const;
