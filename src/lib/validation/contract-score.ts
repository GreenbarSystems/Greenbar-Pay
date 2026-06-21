/**
 * Phase 9.5 PR3 — contract-grounded line scoring.
 *
 * Pure function: given an invoice line and the matched vendor's active
 * contract lines, compute whether the line's unit_price is within or
 * above contract. The Phase 9 statistical rate-drift remains the
 * fallback when no contract match exists.
 *
 * Tiering (overage = (unitPrice − contractUnitPrice) / contractUnitPrice):
 *   overage ≤ 0           → info  within_contract_rate (positive signal)
 *   overage ≤ WARN  (10%) → info  within_contract_rate (within tolerance)
 *   overage ≤ BLOCK (25%) → warning above_contract_rate
 *   overage >  BLOCK      → blocking severely_above_contract_rate
 *
 * The within tier is intentionally emitted as `info` (not silent) so an
 * auditor can see that the validation rule DID fire and matched the
 * contract — a clean run still records a positive lineage entry.
 */
import type { ValidationFinding } from "./index";

export const CONTRACT_WARNING_OVERAGE = 0.1;
export const CONTRACT_BLOCKING_OVERAGE = 0.25;

export interface ContractLineMatch {
  /** Pre-normalized via itemKeyword(); identifies the line in the
   *  contract rate card. NULL contract-side keywords are skipped
   *  upstream — they never participate in matching. */
  itemKeyword: string;
  unitPrice: number;
  currency: string | null;
  priceBasis: string | null;
}

export interface ScoreLineAgainstContractInput {
  lineNumber: number | null;
  /** Same itemKeyword() output the contract lines were normalized with. */
  invoiceKeyword: string | null;
  invoiceUnitPrice: number | null;
  invoiceCurrency: string | null;
}

export interface ContractScoreResult {
  finding: ValidationFinding;
  contractUnitPrice: number;
  overage: number;
}

/**
 * Returns null when no contract match was applied — either no keyword
 * on the invoice line, no contract-side rate for that keyword, or the
 * invoice line's unit_price was missing. Caller should fall through to
 * the statistical rate-drift in that case.
 */
export function scoreLineAgainstContract(
  input: ScoreLineAgainstContractInput,
  contractLines: ContractLineMatch[],
): ContractScoreResult | null {
  if (input.invoiceKeyword === null) return null;
  if (input.invoiceUnitPrice === null) return null;
  if (contractLines.length === 0) return null;

  // Look up the contract line by keyword. The Phase 9.5 PR1 sidecar
  // 0023 indexes (organization_id, item_keyword) so the caller's lookup
  // is O(log n); here we work over the already-narrowed array.
  const contractLine = contractLines.find(
    (cl) => cl.itemKeyword === input.invoiceKeyword,
  );
  if (!contractLine) return null;

  // Currency mismatch — emit a warning so the reviewer notices, but
  // don't try to compare values across currencies. Decline to score
  // and let the caller fall through.
  if (
    contractLine.currency !== null &&
    input.invoiceCurrency !== null &&
    contractLine.currency !== input.invoiceCurrency
  ) {
    return {
      finding: {
        code: "above_contract_rate",
        severity: "warning",
        message:
          `Line ${input.lineNumber ?? "?"} is priced in ${input.invoiceCurrency} but the contract is in ${contractLine.currency} — manual review required.`,
        context: {
          itemKeyword: input.invoiceKeyword,
          lineNumber: input.lineNumber,
          invoiceCurrency: input.invoiceCurrency,
          contractCurrency: contractLine.currency,
          reason: "currency_mismatch",
        },
      },
      contractUnitPrice: contractLine.unitPrice,
      overage: 0,
    };
  }

  const overage =
    (input.invoiceUnitPrice - contractLine.unitPrice) / contractLine.unitPrice;

  // Within / at / below contract. Emit a positive lineage entry so the
  // audit chain shows the rule fired and the line was on-rate.
  //
  // PR21 H3 — messages reach Anthropic via the briefing-card prompt.
  // Combined with the same line's invoice unitPrice in the same prompt
  // an LLM could reconstruct the negotiated rate. Keep messages
  // directional only; the exact overage stays in `context` for the
  // sanctioned errors_json + UI rendering path. Same pattern as the
  // PR11 C6 fix for `unit_price_drift`.
  if (overage <= CONTRACT_WARNING_OVERAGE) {
    return {
      finding: {
        code: "within_contract_rate",
        severity: "info",
        message:
          overage <= 0
            ? `Line ${input.lineNumber ?? "?"} is at or below the contract rate.`
            : `Line ${input.lineNumber ?? "?"} is within the contract rate tolerance.`,
        context: {
          itemKeyword: input.invoiceKeyword,
          lineNumber: input.lineNumber,
          overage: Number(overage.toFixed(4)),
        },
      },
      contractUnitPrice: contractLine.unitPrice,
      overage,
    };
  }

  // Above contract by > warn threshold but ≤ block threshold.
  if (overage <= CONTRACT_BLOCKING_OVERAGE) {
    return {
      finding: {
        code: "above_contract_rate",
        severity: "warning",
        message: `Line ${input.lineNumber ?? "?"} is materially above the contract rate.`,
        context: {
          itemKeyword: input.invoiceKeyword,
          lineNumber: input.lineNumber,
          overage: Number(overage.toFixed(4)),
        },
      },
      contractUnitPrice: contractLine.unitPrice,
      overage,
    };
  }

  // Above contract by > block threshold — blocking finding. Reviewer
  // must either correct the price, exercise F02 Stop Work Authority,
  // or reject.
  return {
    finding: {
      code: "severely_above_contract_rate",
      severity: "blocking",
      message: `Line ${input.lineNumber ?? "?"} exceeds the contract rate by more than the blocking tolerance.`,
      context: {
        itemKeyword: input.invoiceKeyword,
        lineNumber: input.lineNumber,
        overage: Number(overage.toFixed(4)),
      },
    },
    contractUnitPrice: contractLine.unitPrice,
    overage,
  };
}
