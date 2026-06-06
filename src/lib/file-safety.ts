/**
 * Upload-boundary file safety (addendum §2.6). Runs before any `documents`
 * row exists; failures return a structured error and never touch the DB.
 *
 * Phase 1: size, MIME sniff (magic bytes — not the HTTP header), and content
 * hash. AV scan and qpdf sanitization are exposed as hook points but stubbed —
 * they wire up to real binaries in the deploy pipeline.
 */
import { createHash } from "node:crypto";

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB (§2.6)
export const MAX_FILES_PER_BATCH = 25;

export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff",
] as const;

export type SafeMime = (typeof ALLOWED_MIME_TYPES)[number];

export class FileSafetyError extends Error {
  readonly code:
    | "too_large"
    | "unsupported_mime"
    | "av_scan_failed"
    | "sanitization_failed"
    | "batch_too_large";
  constructor(code: FileSafetyError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Sniff the MIME type from magic bytes. The HTTP Content-Type header is
 * untrusted (§2.6 — "sniffed, not trusted from header").
 */
export function sniffMime(buf: Buffer): SafeMime | null {
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "%PDF") {
    return "application/pdf";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // TIFF: little-endian (II*\0) or big-endian (MM\0*).
  if (
    buf.length >= 4 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))
  ) {
    return "image/tiff";
  }
  return null;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Phase 1 stub. In production this shells out to clamdscan or a managed AV.
 * Implemented as an injectable hook so the upload pipeline can be tested
 * without ClamAV running locally.
 */
export type AvScanner = (buf: Buffer) => Promise<{ clean: boolean; reason?: string }>;

const passthroughAv: AvScanner = async () => ({ clean: true });

/**
 * Phase 1 stub. Production runs:
 *   qpdf --no-original-object-ids --object-streams=generate in.pdf out.pdf
 * to strip JS actions, embedded files, and XFA forms.
 */
export type PdfSanitizer = (buf: Buffer) => Promise<Buffer>;

const passthroughSanitizer: PdfSanitizer = async (buf) => buf;

export interface InspectResult {
  buf: Buffer; // post-sanitization
  mimeType: SafeMime;
  contentHash: string;
  byteSize: number;
}

/**
 * Single-file gate. Throws FileSafetyError on rejection; never returns a
 * partially-valid result.
 */
export async function inspectUpload(
  raw: Buffer,
  opts: { av?: AvScanner; sanitizer?: PdfSanitizer } = {},
): Promise<InspectResult> {
  if (raw.length > MAX_FILE_BYTES) {
    throw new FileSafetyError(
      "too_large",
      `file is ${raw.length} bytes; max ${MAX_FILE_BYTES}`,
    );
  }
  const sniffed = sniffMime(raw);
  if (!sniffed) {
    throw new FileSafetyError(
      "unsupported_mime",
      "file does not match an allowed type (pdf, png, jpeg, tiff)",
    );
  }

  const av = opts.av ?? passthroughAv;
  const scan = await av(raw);
  if (!scan.clean) {
    throw new FileSafetyError(
      "av_scan_failed",
      scan.reason ?? "antivirus rejected the file",
    );
  }

  let buf = raw;
  if (sniffed === "application/pdf") {
    const sanitize = opts.sanitizer ?? passthroughSanitizer;
    try {
      buf = await sanitize(raw);
    } catch (err) {
      throw new FileSafetyError(
        "sanitization_failed",
        (err as Error).message ?? "qpdf sanitization failed",
      );
    }
  }

  return {
    buf,
    mimeType: sniffed,
    contentHash: sha256(buf),
    byteSize: buf.length,
  };
}
