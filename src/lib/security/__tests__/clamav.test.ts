/**
 * Three things to verify without a real ClamAV daemon:
 *   1. assertAvScanningConfiguredInProduction — pure logic, direct unit test.
 *   2. The INSTREAM wire protocol (chunk framing, zero-length terminator,
 *      "stream: OK" / "stream: ... FOUND" / garbage response parsing) —
 *      exercised against a tiny in-process TCP server that speaks just
 *      enough of the real clamd protocol to prove clamAvScan frames and
 *      parses correctly.
 *   3. Regression guard for a real bug this module shipped with once
 *      already: the production assertion must NEVER run at module
 *      import time, only when clamAvScan is actually invoked.
 *      `next build`'s "Collecting page data" step imports route
 *      handler modules with NODE_ENV=production but no runtime
 *      secrets available — a module-scope assertion call broke every
 *      production Docker build (see CLAUDE.md's file-safety
 *      Operational note for the full story).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { assertAvScanningConfiguredInProduction, clamAvScan } from "../clamav";

describe("assertAvScanningConfiguredInProduction", () => {
  it("throws when production has no CLAMD_HOST", () => {
    expect(() =>
      assertAvScanningConfiguredInProduction({ NODE_ENV: "production" }),
    ).toThrow(/CLAMD_HOST must be set in production/);
  });

  it("does not throw when production has CLAMD_HOST", () => {
    expect(() =>
      assertAvScanningConfiguredInProduction({
        NODE_ENV: "production",
        CLAMD_HOST: "clamav.internal",
      }),
    ).not.toThrow();
  });

  it("does not throw outside production regardless of CLAMD_HOST", () => {
    expect(() =>
      assertAvScanningConfiguredInProduction({ NODE_ENV: "development" }),
    ).not.toThrow();
    expect(() =>
      assertAvScanningConfiguredInProduction({ NODE_ENV: "test" }),
    ).not.toThrow();
  });
});

/** Minimal fake clamd: reads INSTREAM-framed chunks, replies once done. */
function startFakeClamd(reply: string): Promise<{ port: number; server: Server; received: Buffer }> {
  return new Promise((resolve) => {
    let received = Buffer.alloc(0);
    const server = createServer((socket) => {
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        // Zero-length chunk (4 zero bytes) after the "zINSTREAM\0" command
        // terminates the stream — reply and close, mirroring real clamd.
        if (received.length >= 4 && received.subarray(-4).equals(Buffer.alloc(4))) {
          socket.end(reply);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, server, received });
    });
  });
}

describe("clamAvScan (INSTREAM protocol against a fake clamd)", () => {
  let activeServer: Server | undefined;

  afterEach(async () => {
    if (activeServer) {
      await new Promise<void>((r) => activeServer!.close(() => r()));
      activeServer = undefined;
    }
  });

  it("frames the file correctly and parses a clean 'stream: OK' response", async () => {
    const { port, server } = await startFakeClamd("stream: OK\0");
    activeServer = server;
    const prevHost = process.env.CLAMD_HOST;
    const prevPort = process.env.CLAMD_PORT;
    process.env.CLAMD_HOST = "127.0.0.1";
    process.env.CLAMD_PORT = String(port);
    try {
      const result = await clamAvScan(Buffer.from("hello world"));
      expect(result).toEqual({ clean: true });
    } finally {
      process.env.CLAMD_HOST = prevHost;
      process.env.CLAMD_PORT = prevPort;
    }
  });

  it("parses a 'FOUND' response as unclean with the signature as the reason", async () => {
    const { port, server } = await startFakeClamd("stream: Eicar-Test-Signature FOUND\0");
    activeServer = server;
    const prevHost = process.env.CLAMD_HOST;
    const prevPort = process.env.CLAMD_PORT;
    process.env.CLAMD_HOST = "127.0.0.1";
    process.env.CLAMD_PORT = String(port);
    try {
      const result = await clamAvScan(Buffer.from("EICAR"));
      expect(result.clean).toBe(false);
      expect(result.reason).toContain("FOUND");
    } finally {
      process.env.CLAMD_HOST = prevHost;
      process.env.CLAMD_PORT = prevPort;
    }
  });

  it("rejects on an unrecognized response instead of defaulting to clean", async () => {
    const { port, server } = await startFakeClamd("garbage\0");
    activeServer = server;
    const prevHost = process.env.CLAMD_HOST;
    const prevPort = process.env.CLAMD_PORT;
    process.env.CLAMD_HOST = "127.0.0.1";
    process.env.CLAMD_PORT = String(port);
    try {
      await expect(clamAvScan(Buffer.from("x"))).rejects.toThrow(/unexpected clamd response/);
    } finally {
      process.env.CLAMD_HOST = prevHost;
      process.env.CLAMD_PORT = prevPort;
    }
  });

  it("returns clean:true with a warning when CLAMD_HOST is unset (dev pass-through)", async () => {
    const prevHost = process.env.CLAMD_HOST;
    delete process.env.CLAMD_HOST;
    try {
      const result = await clamAvScan(Buffer.from("anything"));
      expect(result).toEqual({ clean: true });
    } finally {
      process.env.CLAMD_HOST = prevHost;
    }
  });
});

describe("regression: module import must never throw, regardless of env", () => {
  let prevHost: string | undefined;
  let prevNodeEnv: string | undefined;

  beforeEach(() => {
    prevHost = process.env.CLAMD_HOST;
    prevNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.CLAMD_HOST = prevHost;
    // @ts-expect-error -- NODE_ENV is a plain string at runtime; TS's
    // ambient type marks it readonly, but restoring it here is safe.
    process.env.NODE_ENV = prevNodeEnv;
  });

  it("importing the module with NODE_ENV=production and no CLAMD_HOST does not throw (build-time safety)", async () => {
    delete process.env.CLAMD_HOST;
    // @ts-expect-error -- see afterEach.
    process.env.NODE_ENV = "production";
    vi.resetModules();
    // If assertAvScanningConfiguredInProduction were ever called at
    // module scope again, this import itself would throw — exactly
    // what broke the production Docker build the first time.
    await expect(import("../clamav")).resolves.toBeDefined();
  });

  it("but actually calling clamAvScan under the same conditions does throw", async () => {
    delete process.env.CLAMD_HOST;
    // @ts-expect-error -- see afterEach.
    process.env.NODE_ENV = "production";
    vi.resetModules();
    const fresh = await import("../clamav");
    await expect(fresh.clamAvScan(Buffer.from("x"))).rejects.toThrow(
      /CLAMD_HOST must be set in production/,
    );
  });
});
