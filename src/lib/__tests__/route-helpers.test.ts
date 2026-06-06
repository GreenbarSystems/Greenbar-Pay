import { describe, it, expect } from "vitest";
import { requireUuid, pickFields } from "@/lib/route-helpers";

describe("requireUuid", () => {
  it("returns null for valid UUIDs", () => {
    expect(requireUuid("3b95f4e1-2b3c-4d5e-9f6a-7b8c9d0e1f23")).toBeNull();
  });

  it("accepts uppercase hex", () => {
    expect(requireUuid("3B95F4E1-2B3C-4D5E-9F6A-7B8C9D0E1F23")).toBeNull();
  });

  it("rejects non-UUID strings", () => {
    const r = requireUuid("not-a-uuid");
    expect(r).not.toBeNull();
    expect(r?.status).toBe(404);
  });

  it("rejects empty string", () => {
    const r = requireUuid("");
    expect(r?.status).toBe(404);
  });

  it("rejects almost-UUID (wrong segment lengths)", () => {
    expect(requireUuid("3b95f4e1-2b3c-4d5e-9f6a-7b8c9d0e1f2")).not.toBeNull();
    expect(requireUuid("3b95f4e1-2b3c-4d5e-9f6a-7b8c9d0e1f234")).not.toBeNull();
  });
});

describe("pickFields", () => {
  it("returns only the listed keys", () => {
    const row = { a: 1, b: 2, c: 3, d: 4 };
    expect(pickFields(row, ["a", "c"] as const)).toEqual({ a: 1, c: 3 });
  });

  it("preserves undefined values", () => {
    const row: Record<string, unknown> = { a: undefined, b: 2 };
    expect(pickFields(row, ["a", "b"] as const)).toEqual({ a: undefined, b: 2 });
  });
});
