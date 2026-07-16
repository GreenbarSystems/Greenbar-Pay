/**
 * AES-256-GCM encrypt / decrypt for OAuth tokens stored in
 * accounting_connections. Key from INTEGRATION_TOKEN_SECRET (base64, 32 bytes).
 *
 * Wire format (base64-encoded):  IV (12 bytes) | auth-tag (16 bytes) | ciphertext
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_ENV = "INTEGRATION_TOKEN_SECRET";

function getKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) throw new Error(`${KEY_ENV} is not set`);
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32)
    throw new Error(`${KEY_ENV} must decode to exactly 32 bytes`);
  return buf;
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptToken(ciphertext: string): string {
  const key = getKey();
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

/**
 * Encrypts a short string (state + PKCE verifier) for OAuth callback cookies.
 * Same algorithm — reuses the integration key.
 */
export function encryptOAuthState(payload: object): string {
  return encryptToken(JSON.stringify(payload));
}

export function decryptOAuthState<T>(ciphertext: string): T {
  return JSON.parse(decryptToken(ciphertext)) as T;
}
