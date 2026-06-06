/**
 * RFC 822 / MIME parsing for the AP inbox.
 *
 * Wraps `mailparser` and applies the addendum §3.3 attachment filter
 * rules. The result is a structured `ParsedEmail` the ingest pipeline
 * persists to email_messages + email_attachments.
 *
 * Reuses the §2.6 controls via `inspectUpload` for each attachment —
 * same size / MIME / AV / qpdf path as the upload route. Identical
 * trust boundaries for both ingestion sources.
 */
import { simpleParser, type ParsedMail, type Attachment } from "mailparser";
import {
  inspectUpload,
  FileSafetyError,
  type InspectResult,
} from "@/lib/file-safety";

export interface ParsedEmail {
  /** Provider Message-ID header (sans angle brackets). May be empty. */
  messageId: string;
  from: { email: string | null; name: string | null };
  /** All recipient addresses lowercased — both `to` and `cc`. */
  recipients: string[];
  subject: string | null;
  bodyText: string;
  receivedAt: Date;
  attachments: ParsedAttachment[];
}

export interface ParsedAttachment {
  filename: string;
  /** MIME from the Content-Type header. NOT trusted for routing (§2.6). */
  headerMimeType: string | null;
  /** Whether the part was an inline image small enough to be a signature. */
  isInlineSignature: boolean;
  /** Raw bytes — keep around so the caller can re-stream to storage. */
  bytes: Buffer;
  /**
   * Outcome of inspectUpload() — present when the part passed (or was
   * actively rejected by) §2.6 controls. Null when we skipped the part
   * (e.g. inline signature, or content-type not in the allow list).
   */
  inspected: InspectResult | null;
  /** Set when the part was rejected; surfaces in email_attachments. */
  rejectionCode: FileSafetyError["code"] | "skipped_inline" | "skipped_mime" | null;
  rejectionReason: string | null;
}

// PRD §"AP Inbox": skip parts that look like signature blocks.
const SIGNATURE_FILENAME_RE = /^image\d{3}\.(png|jpg|jpeg)$/i;
const SIGNATURE_BYTE_LIMIT = 64 * 1024; // 64 KB — a real invoice scan is bigger

const ALLOWED_HEADER_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/tif",
]);

export async function parseEml(emlBytes: Buffer): Promise<ParsedEmail> {
  const mail: ParsedMail = await simpleParser(emlBytes);

  const recipients = collectAddresses(mail);
  const attachments: ParsedAttachment[] = [];

  for (const att of mail.attachments ?? []) {
    const parsed = await screenAttachment(att);
    attachments.push(parsed);
  }

  return {
    messageId: stripBrackets(mail.messageId ?? ""),
    from: {
      email: mail.from?.value?.[0]?.address?.toLowerCase() ?? null,
      name: mail.from?.value?.[0]?.name ?? null,
    },
    recipients,
    subject: mail.subject ?? null,
    bodyText: (mail.text ?? "").trim(),
    receivedAt: mail.date ?? new Date(),
    attachments,
  };
}

function collectAddresses(mail: ParsedMail): string[] {
  const out: string[] = [];
  const sources = [mail.to, mail.cc, mail.bcc];
  for (const src of sources) {
    if (!src) continue;
    const list = Array.isArray(src) ? src : [src];
    for (const group of list) {
      for (const addr of group?.value ?? []) {
        if (addr.address) out.push(addr.address.toLowerCase());
      }
    }
  }
  return [...new Set(out)];
}

async function screenAttachment(att: Attachment): Promise<ParsedAttachment> {
  const filename = att.filename ?? "unnamed";
  const headerMime = (att.contentType ?? "").toLowerCase().split(";")[0].trim();
  const bytes = att.content as Buffer;

  // §3.3 — skip inline image parts that look like signatures or logos.
  if (
    att.contentDisposition === "inline" &&
    typeof headerMime === "string" &&
    headerMime.startsWith("image/") &&
    (SIGNATURE_FILENAME_RE.test(filename) || bytes.length < SIGNATURE_BYTE_LIMIT)
  ) {
    return {
      filename,
      headerMimeType: headerMime || null,
      isInlineSignature: true,
      bytes,
      inspected: null,
      rejectionCode: "skipped_inline",
      rejectionReason: "inline image part below signature threshold",
    };
  }

  // §3.3 — skip parts whose declared MIME isn't in the allow list. This is
  // a cheap pre-filter before we burn cycles on inspectUpload; the real
  // gate is the sniff inside inspectUpload.
  if (headerMime && !ALLOWED_HEADER_MIME.has(headerMime)) {
    return {
      filename,
      headerMimeType: headerMime,
      isInlineSignature: false,
      bytes,
      inspected: null,
      rejectionCode: "skipped_mime",
      rejectionReason: `header content-type '${headerMime}' not allowed`,
    };
  }

  // Reuse the upload-boundary inspector (§2.6 + §3.3 share the same gate).
  try {
    const inspected = await inspectUpload(bytes);
    return {
      filename,
      headerMimeType: headerMime || null,
      isInlineSignature: false,
      bytes,
      inspected,
      rejectionCode: null,
      rejectionReason: null,
    };
  } catch (err) {
    if (err instanceof FileSafetyError) {
      return {
        filename,
        headerMimeType: headerMime || null,
        isInlineSignature: false,
        bytes,
        inspected: null,
        rejectionCode: err.code,
        rejectionReason: err.message,
      };
    }
    throw err;
  }
}

function stripBrackets(s: string): string {
  return s.replace(/^[<]|[>]$/g, "");
}
