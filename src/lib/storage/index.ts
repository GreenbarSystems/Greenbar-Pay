/**
 * Storage abstraction. Phase 1 ships an S3/MinIO impl; the interface is
 * narrow on purpose so a future R2/Supabase swap is mechanical.
 */
export interface ObjectStorage {
  putObject(input: {
    key: string;
    body: Buffer | Uint8Array;
    contentType?: string;
  }): Promise<void>;

  /** Stream the bytes back. Worker uses this to re-read the original file. */
  getObject(key: string): Promise<Buffer>;

  /** Pre-signed GET URL, default 5-minute TTL. */
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;

  deleteObject(key: string): Promise<void>;
}

export { s3Storage as storage } from "./s3";

/**
 * Storage key convention:
 *   documents/<org_id>/<yyyy>/<mm>/<doc_id>.<ext>
 *
 * Org-prefixed so a misconfigured bucket policy fails closed at the
 * org boundary, not the world.
 */
export function documentStorageKey(args: {
  organizationId: string;
  documentId: string;
  extension: string;
  receivedAt?: Date;
}): string {
  const d = args.receivedAt ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const ext = args.extension.replace(/^\./, "");
  return `documents/${args.organizationId}/${yyyy}/${mm}/${args.documentId}.${ext}`;
}

/**
 * Raw extracted text key. One per attempt — the suffix (extractionId)
 * keeps retries from clobbering prior text. Append-only by construction.
 */
export function rawTextStorageKey(args: {
  organizationId: string;
  documentId: string;
  extractionId: string;
}): string {
  return `extractions/${args.organizationId}/${args.documentId}/${args.extractionId}.txt`;
}
