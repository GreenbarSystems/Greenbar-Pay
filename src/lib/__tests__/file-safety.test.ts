import { describe, it, expect, vi, beforeEach } from "vitest";

const clamAvScanMock = vi.fn(async (_buf: Buffer) => ({ clean: true }));
const pdfLibSanitizeMock = vi.fn(async (buf: Buffer) => buf);

vi.mock("../security/clamav", () => ({ clamAvScan: (buf: Buffer) => clamAvScanMock(buf) }));
vi.mock("../security/pdf-sanitize", () => ({
  pdfLibSanitize: (buf: Buffer) => pdfLibSanitizeMock(buf),
}));

const { inspectUpload, sniffMime, sha256, FileSafetyError, MAX_FILE_BYTES } = await import(
  "../file-safety"
);

const PDF_MAGIC = Buffer.from("%PDF-1.4\n%mock");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0, 0]);
const TIFF_LE_MAGIC = Buffer.from([0x49, 0x49, 0x2a, 0x00]);

beforeEach(() => {
  clamAvScanMock.mockClear();
  pdfLibSanitizeMock.mockClear();
});

describe("sniffMime", () => {
  it("identifies each allowed magic-byte signature", () => {
    expect(sniffMime(PDF_MAGIC)).toBe("application/pdf");
    expect(sniffMime(PNG_MAGIC)).toBe("image/png");
    expect(sniffMime(JPEG_MAGIC)).toBe("image/jpeg");
    expect(sniffMime(TIFF_LE_MAGIC)).toBe("image/tiff");
  });

  it("returns null for content that doesn't match any allowed magic bytes", () => {
    expect(sniffMime(Buffer.from("plain text file"))).toBeNull();
    expect(sniffMime(Buffer.from([0x4d, 0x5a]))).toBeNull(); // MZ (Windows EXE)
  });
});

describe("sha256", () => {
  it("is deterministic and content-sensitive", () => {
    const a = sha256(Buffer.from("hello"));
    const b = sha256(Buffer.from("hello"));
    const c = sha256(Buffer.from("hellO"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("inspectUpload", () => {
  it("rejects files over MAX_FILE_BYTES before ever calling AV/sanitizer", async () => {
    const oversized = Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_FILE_BYTES)]);
    await expect(inspectUpload(oversized)).rejects.toMatchObject({ code: "too_large" });
    expect(clamAvScanMock).not.toHaveBeenCalled();
  });

  it("rejects content with no recognized magic bytes", async () => {
    await expect(inspectUpload(Buffer.from("not a real file"))).rejects.toMatchObject({
      code: "unsupported_mime",
    });
  });

  it("uses the real clamAvScan/pdfLibSanitize by default when opts are omitted", async () => {
    const result = await inspectUpload(PDF_MAGIC);
    expect(clamAvScanMock).toHaveBeenCalledTimes(1);
    expect(pdfLibSanitizeMock).toHaveBeenCalledTimes(1);
    expect(result.mimeType).toBe("application/pdf");
  });

  it("does not call the sanitizer for non-PDF files", async () => {
    await inspectUpload(PNG_MAGIC);
    expect(clamAvScanMock).toHaveBeenCalledTimes(1);
    expect(pdfLibSanitizeMock).not.toHaveBeenCalled();
  });

  it("rejects when the injected AV scanner reports unclean", async () => {
    await expect(
      inspectUpload(PNG_MAGIC, {
        av: async () => ({ clean: false, reason: "Eicar-Test-Signature FOUND" }),
      }),
    ).rejects.toMatchObject({ code: "av_scan_failed", message: "Eicar-Test-Signature FOUND" });
  });

  it("rejects when the injected sanitizer throws, without leaking the original bytes", async () => {
    await expect(
      inspectUpload(PDF_MAGIC, {
        av: async () => ({ clean: true }),
        sanitizer: async () => {
          throw new Error("malformed PDF structure");
        },
      }),
    ).rejects.toMatchObject({ code: "sanitization_failed" });
  });

  it("returns the sanitizer's output buffer, not the original, for PDFs", async () => {
    const sanitizedBytes = Buffer.from("%PDF-1.4\n%sanitized-version");
    const result = await inspectUpload(PDF_MAGIC, {
      av: async () => ({ clean: true }),
      sanitizer: async () => sanitizedBytes,
    });
    expect(result.buf).toBe(sanitizedBytes);
    expect(result.contentHash).toBe(sha256(sanitizedBytes));
  });

  it("FileSafetyError carries the code for HTTP-status mapping at call sites", async () => {
    try {
      await inspectUpload(Buffer.alloc(0));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FileSafetyError);
      expect((err as InstanceType<typeof FileSafetyError>).code).toBe("unsupported_mime");
    }
  });
});
