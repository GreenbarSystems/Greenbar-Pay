/**
 * loadPermittedClientIds — PR6 review #5.
 *
 * Pure unit tests of the role → scope policy. The DB lookup is mocked
 * via a minimal Tx surface so we don't need a running Postgres for
 * these assertions.
 */
import { describe, it, expect, vi } from "vitest";
import { loadPermittedClientIds } from "@/lib/rbac/client-scope";

// Minimal mock that returns whatever rows we want.
function makeTx(grants: Array<{ clientId: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(grants),
      }),
    }),
  } as unknown as Parameters<typeof loadPermittedClientIds>[0];
}

describe("loadPermittedClientIds", () => {
  it("owner gets org-wide read (null)", async () => {
    const r = await loadPermittedClientIds(makeTx([]), {
      userId: "u1",
      orgRole: "owner",
    });
    expect(r).toBeNull();
  });

  it("admin gets org-wide read", async () => {
    const r = await loadPermittedClientIds(makeTx([]), {
      userId: "u1",
      orgRole: "admin",
    });
    expect(r).toBeNull();
  });

  it("reviewer gets org-wide read", async () => {
    const r = await loadPermittedClientIds(makeTx([]), {
      userId: "u1",
      orgRole: "reviewer",
    });
    expect(r).toBeNull();
  });

  it("clerk gets per-client grants only", async () => {
    const r = await loadPermittedClientIds(
      makeTx([{ clientId: "c1" }, { clientId: "c2" }]),
      { userId: "u1", orgRole: "clerk" },
    );
    expect(r).toEqual(["c1", "c2"]);
  });

  it("viewer with zero grants returns empty array", async () => {
    const r = await loadPermittedClientIds(makeTx([]), {
      userId: "u1",
      orgRole: "viewer",
    });
    expect(r).toEqual([]);
  });

  it("viewer with one grant returns single-element array", async () => {
    const r = await loadPermittedClientIds(makeTx([{ clientId: "c1" }]), {
      userId: "u1",
      orgRole: "viewer",
    });
    expect(r).toEqual(["c1"]);
  });
});
