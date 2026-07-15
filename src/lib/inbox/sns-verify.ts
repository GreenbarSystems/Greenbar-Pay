/**
 * SNS message signature verification — fixes "F8: SQS consumer trusts
 * SNS envelope without verifying the signature" from the 2026-07-13
 * security audit.
 *
 * SES → SNS → SQS delivers each inbound message with an RSA signature
 * that proves it was published by the named SNS topic. Without
 * verification, an attacker who can write to the SQS queue (via a
 * misconfigured queue policy, SSRF, or stolen SQS credentials) can inject
 * crafted messages that would be processed as legitimate inbound email.
 *
 * Algorithm (AWS-documented):
 *   https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 *   1. Validate SigningCertURL is from a trusted AWS domain (prevents
 *      certificate substitution — an attacker supplying their own cert).
 *   2. Fetch (and cache) the PEM signing certificate.
 *   3. Build the canonical string for the message type.
 *   4. Verify the base64-encoded Signature against the canonical string
 *      using the algorithm indicated by SignatureVersion (1 = SHA1, 2 = SHA256).
 */
import { createVerify } from "node:crypto";

// SigningCertURL must be HTTPS from the SNS service subdomain of amazonaws.com
// (standard, CN, and GovCloud regions). Reject anything else before fetching.
const TRUSTED_CERT_URL_RE =
  /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?(\/|$)/;

// In-process certificate cache. SNS reuses the same signing certificate for
// months; there is no need to fetch it on every message. The cache persists
// for the life of the worker process — certificates rotate rarely and the
// process restarts on deploy, so no TTL is needed.
const certCache = new Map<string, string>();

export interface SnsEnvelope {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: "1" | "2";
  Signature: string;
  SigningCertURL: string;
  // Present on Notification only:
  Subject?: string;
  // Present on SubscriptionConfirmation / UnsubscribeConfirmation only:
  Token?: string;
  SubscribeURL?: string;
}

/**
 * Parses and type-checks an already-decoded JSON value as an SNS envelope.
 * Returns null if the value is missing required fields or has an unsupported
 * signature version — callers treat null as "not an SNS message."
 */
export function parseSnsEnvelope(value: unknown): SnsEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;

  if (
    (o["Type"] !== "Notification" &&
      o["Type"] !== "SubscriptionConfirmation" &&
      o["Type"] !== "UnsubscribeConfirmation") ||
    typeof o["MessageId"] !== "string" ||
    typeof o["TopicArn"] !== "string" ||
    typeof o["Message"] !== "string" ||
    typeof o["Timestamp"] !== "string" ||
    (o["SignatureVersion"] !== "1" && o["SignatureVersion"] !== "2") ||
    typeof o["Signature"] !== "string" ||
    typeof o["SigningCertURL"] !== "string"
  ) {
    return null;
  }

  return {
    Type: o["Type"],
    MessageId: o["MessageId"],
    TopicArn: o["TopicArn"],
    Message: o["Message"],
    Timestamp: o["Timestamp"],
    SignatureVersion: o["SignatureVersion"],
    Signature: o["Signature"],
    SigningCertURL: o["SigningCertURL"],
    Subject: typeof o["Subject"] === "string" ? o["Subject"] : undefined,
    Token: typeof o["Token"] === "string" ? o["Token"] : undefined,
    SubscribeURL: typeof o["SubscribeURL"] === "string" ? o["SubscribeURL"] : undefined,
  };
}

/**
 * Builds the canonical string that SNS signed. Field order and presence are
 * fixed per message type per the AWS spec — this is NOT alphabetical.
 */
export function buildCanonicalString(env: SnsEnvelope): string {
  const parts: string[] = [];
  const push = (key: string, value: string) => parts.push(`${key}\n${value}\n`);

  if (env.Type === "Notification") {
    push("Message", env.Message);
    push("MessageId", env.MessageId);
    if (env.Subject !== undefined) push("Subject", env.Subject);
    push("Timestamp", env.Timestamp);
    push("TopicArn", env.TopicArn);
    push("Type", env.Type);
  } else {
    // SubscriptionConfirmation and UnsubscribeConfirmation share the same shape.
    push("Message", env.Message);
    push("MessageId", env.MessageId);
    if (env.SubscribeURL !== undefined) push("SubscribeURL", env.SubscribeURL);
    push("Timestamp", env.Timestamp);
    if (env.Token !== undefined) push("Token", env.Token);
    push("TopicArn", env.TopicArn);
    push("Type", env.Type);
  }

  return parts.join("");
}

async function defaultFetchCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch SNS signing certificate (${res.status}): ${url}`);
  }
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
}

/**
 * Verifies the SNS signature on a parsed SNS envelope.
 *
 * Throws on any verification failure:
 *   - SigningCertURL is not from a trusted AWS domain
 *   - Certificate fetch failed
 *   - Signature is cryptographically invalid
 *
 * @param fetchCert - injectable for tests; defaults to a caching HTTPS fetch
 */
export async function verifySnsSignature(
  envelope: SnsEnvelope,
  fetchCert: (url: string) => Promise<string> = defaultFetchCert,
): Promise<void> {
  if (!TRUSTED_CERT_URL_RE.test(envelope.SigningCertURL)) {
    throw new Error(
      `SNS SigningCertURL is not from a trusted AWS domain: ${envelope.SigningCertURL}`,
    );
  }

  const cert = await fetchCert(envelope.SigningCertURL);
  const canonical = buildCanonicalString(envelope);
  const algo = envelope.SignatureVersion === "2" ? "SHA256" : "SHA1";

  const verifier = createVerify(algo);
  verifier.update(canonical);
  const valid = verifier.verify(cert, envelope.Signature, "base64");

  if (!valid) {
    throw new Error(
      `SNS signature verification failed for message ${envelope.MessageId}`,
    );
  }
}
