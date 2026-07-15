/**
 * Unit tests for pdf-rasterize.ts.
 *
 * Focus: the F15 timeout added by the 2026-07-13 audit. The tests mock
 * node:child_process and node:fs/promises so no real pdftoppm or disk I/O
 * is required. Fake timers let us exercise the 60 s kill path instantly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// ── fs/promises mock ────────────────────────────────────────────────────────
// Hoisted by vitest before the module under test is imported.
vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn().mockResolvedValue("/tmp/gbp-rasterize-test"),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue(["page-001.png"]),
  readFile: vi.fn().mockResolvedValue(Buffer.from("PNG")),
  rm: vi.fn().mockResolvedValue(undefined),
}));

// ── child_process mock ──────────────────────────────────────────────────────
// vi.hoisted ensures the variable is initialised before vi.mock's factory runs.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// Static import AFTER mock declarations so vitest hoisting kicks in.
import { rasterizePdfPages, RasterizeError } from "../pdf-rasterize";

// ── helpers ─────────────────────────────────────────────────────────────────

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
  stderr: Readable;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = vi.fn();
  child.stderr = new Readable({ read() {} });
  return child;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("pdf-rasterize F15 — timeout enforcement", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with rasterize_failed and kills the child when the process hangs", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    vi.useFakeTimers();

    const gen = rasterizePdfPages(Buffer.from("pdf"));
    const pendingFirst = gen.next();
    // Suppress "unhandled rejection" warnings — the rejection is caught below
    // via expect(...).rejects, but timing with fake timers means Node.js sees
    // it unhandled for a brief moment before the await attaches.
    pendingFirst.catch(() => {});

    // Advance past the 60 s default timeout so the kill timer fires.
    await vi.advanceTimersByTimeAsync(60_001);

    await expect(pendingFirst).rejects.toBeInstanceOf(RasterizeError);
    await expect(pendingFirst).rejects.toMatchObject({
      code: "rasterize_failed",
      message: expect.stringContaining("timed out after 60s"),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("resolves successfully and does NOT kill the child when pdftoppm exits 0", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    vi.useFakeTimers();

    const gen = rasterizePdfPages(Buffer.from("pdf"));
    const pendingFirst = gen.next();
    // Suppress "unhandled rejection" warnings — the rejection is caught below
    // via expect(...).rejects, but timing with fake timers means Node.js sees
    // it unhandled for a brief moment before the await attaches.
    pendingFirst.catch(() => {});

    // Flush microtasks so the generator advances past mkdtemp/writeFile
    // into runPdftoppm, where it registers handlers and creates the kill timer.
    await vi.advanceTimersByTimeAsync(0);

    // Process exits quickly before the kill timer fires.
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);

    const page = await pendingFirst;
    expect(page.done).toBe(false);
    expect(page.value?.pageNumber).toBe(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects with rasterize_failed on non-zero exit and does NOT kill the child", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    vi.useFakeTimers();

    const gen = rasterizePdfPages(Buffer.from("pdf"));
    const pendingFirst = gen.next();
    // Suppress "unhandled rejection" warnings — the rejection is caught below
    // via expect(...).rejects, but timing with fake timers means Node.js sees
    // it unhandled for a brief moment before the await attaches.
    pendingFirst.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);

    child.stderr.push("syntax error\n");
    child.stderr.push(null);
    child.emit("close", 1);
    await vi.advanceTimersByTimeAsync(0);

    await expect(pendingFirst).rejects.toBeInstanceOf(RasterizeError);
    await expect(pendingFirst).rejects.toMatchObject({
      code: "rasterize_failed",
      message: expect.stringContaining("pdftoppm exited 1"),
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects with missing_binary on ENOENT and does NOT kill the child", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    vi.useFakeTimers();

    const gen = rasterizePdfPages(Buffer.from("pdf"));
    const pendingFirst = gen.next();
    // Suppress "unhandled rejection" warnings — the rejection is caught below
    // via expect(...).rejects, but timing with fake timers means Node.js sees
    // it unhandled for a brief moment before the await attaches.
    pendingFirst.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);

    const enoent = Object.assign(new Error("spawn pdftoppm ENOENT"), { code: "ENOENT" });
    child.emit("error", enoent);
    await vi.advanceTimersByTimeAsync(0);

    await expect(pendingFirst).rejects.toBeInstanceOf(RasterizeError);
    await expect(pendingFirst).rejects.toMatchObject({ code: "missing_binary" });
    expect(child.kill).not.toHaveBeenCalled();
  });
});
