/**
 * ClamAV (clamd) client — fixes "F3: AV scan + PDF sanitizer are no-op
 * stubs" from the 2026-07-13 security audit.
 *
 * Talks to a clamd daemon over its INSTREAM protocol: connect, send
 * "zINSTREAM\0", stream the file as <4-byte big-endian length><chunk>
 * pairs terminated by a zero-length chunk, then read back either
 * "stream: OK" or "stream: <signature> FOUND".
 * https://linux.die.net/man/8/clamd — INSTREAM command.
 *
 * Fail-closed by design: if CLAMD_HOST is unset with NODE_ENV=production,
 * the module-scope assertion below throws at import time, mirroring
 * assertNoDevAuthInProduction's "fail loud at startup, not silently at
 * request time" pattern from the F1 fix (src/lib/auth-dev-login.ts).
 * Outside production, an unset CLAMD_HOST degrades to a loud
 * console.warn + pass-through so local dev doesn't require running
 * ClamAV — set CLAMD_HOST (docker-compose provides a `clamav` service)
 * to exercise the real scanner locally.
 */
import { connect } from "node:net";
import type { AvScanner } from "../file-safety";

const DEFAULT_PORT = 3310;
const DEFAULT_TIMEOUT_MS = 15_000;
const CHUNK_SIZE = 64 * 1024;

/**
 * Throws if AV scanning has no configured daemon while NODE_ENV is
 * "production". Called on every real scan (not at module load time —
 * `next build`'s "Collecting page data" step imports route handler
 * modules with NODE_ENV=production but intentionally has no runtime
 * secrets available, so a module-scope call here would fail every
 * production build regardless of how the deployed container is
 * actually configured). This still fails loudly on the very first
 * real upload/email-scan in a misconfigured production deploy —
 * before any file is treated as scanned.
 */
export function assertAvScanningConfiguredInProduction(env: {
  NODE_ENV?: string;
  CLAMD_HOST?: string;
}): void {
  if (env.NODE_ENV === "production" && !env.CLAMD_HOST) {
    throw new Error(
      "CLAMD_HOST must be set in production — without a reachable ClamAV " +
        "daemon, every uploaded/emailed file would be accepted unscanned " +
        "(2026-07-13 audit F3). Point CLAMD_HOST/CLAMD_PORT at a clamd instance.",
    );
  }
}

interface ClamdConfig {
  host: string;
  port: number;
  timeoutMs: number;
}

function loadConfig(): ClamdConfig | null {
  const host = process.env.CLAMD_HOST;
  if (!host) return null;
  return {
    host,
    port: Number(process.env.CLAMD_PORT ?? DEFAULT_PORT),
    timeoutMs: Number(process.env.CLAMD_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };
}

let warnedOnce = false;

export const clamAvScan: AvScanner = async (buf) => {
  assertAvScanningConfiguredInProduction(process.env);
  const config = loadConfig();
  if (!config) {
    // Only reachable outside production — the assertion above already
    // refused a production call with no CLAMD_HOST configured.
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[clamav] CLAMD_HOST not set — AV scanning is DISABLED. Every " +
          "upload/email attachment is being accepted unscanned. This is " +
          "only acceptable in local development.",
      );
    }
    return { clean: true };
  }
  return scanViaInstream(buf, config);
};

function scanViaInstream(
  buf: Buffer,
  config: ClamdConfig,
): Promise<{ clean: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(config.port, config.host);
    let response = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };

    socket.setTimeout(config.timeoutMs, () =>
      finish(() => reject(new Error(`clamd scan timed out after ${config.timeoutMs}ms`))),
    );
    socket.on("error", (err) => finish(() => reject(err)));

    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      let offset = 0;
      while (offset < buf.length) {
        const end = Math.min(offset + CHUNK_SIZE, buf.length);
        const chunk = buf.subarray(offset, end);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length, 0);
        socket.write(header);
        socket.write(chunk);
        offset = end;
      }
      socket.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
    });

    socket.on("data", (data) => {
      response += data.toString("utf8");
    });

    socket.on("end", () => {
      finish(() => {
        const trimmed = response.replace(/\0/g, "").trim();
        if (trimmed.includes("FOUND")) {
          resolve({ clean: false, reason: trimmed });
        } else if (trimmed.includes("OK")) {
          resolve({ clean: true });
        } else {
          reject(new Error(`unexpected clamd response: ${trimmed || "(empty)"}`));
        }
      });
    });
  });
}
