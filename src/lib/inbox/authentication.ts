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
 * Policy (2026-08 hardening — see below for what changed): accept only
 * when at least one of SPF or DKIM explicitly PASSES, or reject when
 * DMARC fails under an enforcing policy. GRAY/PROCESSING_FAILED/absent
 * verdicts on BOTH mechanisms are now treated as "no authentication
 * signal" and rejected, not accepted. Fully missing verdict data
 * (undefined — local dev via scripts/ingest-eml.ts, which has no SES
 * receipt at all) still fails OPEN, since that's a tooling gap, not a
 * production message SES actually evaluated and found nothing on.
 *
 * A single passing mechanism is normal and sufficient for legitimate
 * mail (forwarded mail commonly breaks SPF but DKIM survives), so PASS
 * on either SPF or DKIM alone is still accepted. The sending domain's
 * own DMARC policy, when published and enforcing, is honored as the
 * strongest signal and checked first.
 *
 * Why this changed from the original "reject only on explicit FAIL":
 * a domain with NO SPF record and NO DKIM signature configured at all
 * gets GRAY on both from SES — not FAIL — since there's nothing to
 * evaluate, not something that failed evaluation. Under the original
 * policy that sailed through untouched: it's meaningfully EASIER for
 * an attacker to use a domain with zero email authentication than one
 * that actively fails an explicit check, which inverts the intended
 * defense. By 2026, DMARC alignment requirements from Gmail/Yahoo's
 * bulk-sender rules mean virtually every legitimate business domain
 * that sends invoice email configures at least one of SPF/DKIM to
 * avoid being spam-filtered everywhere else — a domain with genuinely
 * neither is now the unusual case, not the common one, so requiring
 * one PASS is a real bar rather than a blanket vendor-hostile change.
 * A rejected message is never silently dropped either way: it still
 * gets an email_messages row with status='failed' and a status_reason
 * an operator can review (src/lib/inbox/ingest.ts).
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

  // Accept as soon as either mechanism explicitly PASSes — a single
  // pass is a real, positive authentication signal and is normal for
  // legitimate mail (see module comment on forwarded mail).
  if (verdicts.spfVerdict === "PASS" || verdicts.dkimVerdict === "PASS") {
    return { accepted: true, reason: null };
  }

  // Neither passed. Distinguish "actively failed" from "no
  // authentication configured at all" for the audit trail
  // (email_messages.status_reason) — both are rejected, but they're
  // different situations for whoever triages a failed message.
  if (verdicts.spfVerdict === "FAIL" && verdicts.dkimVerdict === "FAIL") {
    return {
      accepted: false,
      reason: "sender authentication failed: SPF and DKIM both failed",
    };
  }

  return {
    accepted: false,
    reason:
      `sender authentication failed: no SPF or DKIM authentication passed ` +
      `(spf=${verdicts.spfVerdict ?? "none"}, dkim=${verdicts.dkimVerdict ?? "none"})`,
  };
}
