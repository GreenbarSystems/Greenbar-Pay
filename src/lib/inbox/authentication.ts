/**
 * Inbound sender authentication — fixes "F11: Inbound email has no
 * sender authentication (SPF/DKIM/DMARC/allowlist)" from the
 * 2026-07-13 security audit.
 *
 * Deliberately NOT an allowlist: this is an AP inbox that accepts
 * invoices from arbitrary external vendors an org has never emailed
 * before — there is no fixed set of "known senders" to allow, so an
 * allowlist would break the actual use case. What's real to check is
 * whether the `From:` domain is who it claims to be — SPF/DKIM/DMARC,
 * not WHO is allowed to send.
 *
 * SES evaluates SPF/DKIM/DMARC on every inbound message by default and
 * includes the verdicts in the same `ses.receipt` object the ingest
 * pipeline already reads for `recipients` (src/lib/inbox/sqs.ts) — no
 * additional AWS configuration is needed, just reading fields that
 * were already being delivered and discarded.
 *
 * Policy: reject only on affirmative, unambiguous authentication
 * failure. GRAY / PROCESSING_FAILED / missing verdicts (e.g. local
 * dev via scripts/ingest-eml.ts, which has no SES receipt at all) fail
 * OPEN — there's no evidence of spoofing, only an inconclusive check.
 * A single passing mechanism is normal for legitimate mail (forwarded
 * mail commonly breaks SPF but DKIM survives), so PASS on either SPF
 * or DKIM is accepted. The sending domain's own DMARC policy, when
 * published and enforcing, is honored as the strongest signal.
 */

export type SesVerdictStatus = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";
export type DmarcPolicy = "none" | "quarantine" | "reject";

export interface SesAuthenticationVerdicts {
  spfVerdict?: SesVerdictStatus;
  dkimVerdict?: SesVerdictStatus;
  dmarcVerdict?: SesVerdictStatus;
  dmarcPolicy?: DmarcPolicy;
}

export interface AuthenticationDecision {
  accepted: boolean;
  /** Populated only when rejected — goes to email_messages.status_reason. */
  reason: string | null;
}

export function evaluateSenderAuthentication(
  verdicts: SesAuthenticationVerdicts | undefined,
): AuthenticationDecision {
  if (!verdicts) {
    // No verdict data available at all (local dev/CLI ingestion via
    // scripts/ingest-eml.ts, or a future non-SES provider) — fail
    // open. We have no basis to reject.
    return { accepted: true, reason: null };
  }

  // The sending domain's own DMARC policy is the strongest signal: if
  // they've published "quarantine" or "reject" and DMARC evaluation
  // failed, honor their stated intent.
  if (
    verdicts.dmarcVerdict === "FAIL" &&
    (verdicts.dmarcPolicy === "quarantine" || verdicts.dmarcPolicy === "reject")
  ) {
    return {
      accepted: false,
      reason: `sender authentication failed: DMARC failed with an enforcing policy (${verdicts.dmarcPolicy})`,
    };
  }

  // Otherwise: reject only when BOTH SPF and DKIM explicitly failed.
  if (verdicts.spfVerdict === "FAIL" && verdicts.dkimVerdict === "FAIL") {
    return {
      accepted: false,
      reason: "sender authentication failed: SPF and DKIM both failed",
    };
  }

  return { accepted: true, reason: null };
}
