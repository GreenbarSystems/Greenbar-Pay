import { describe, it, expect } from "vitest";
import { requireOrgAdmin } from "../route-guards";
import type { UserRole } from "@/lib/rbac";

describe("requireOrgAdmin", () => {
  it("allows owner and admin", async () => {
    expect(requireOrgAdmin("owner")).toBeNull();
    expect(requireOrgAdmin("admin")).toBeNull();
  });

  it("rejects reviewer, clerk, and viewer with 403", async () => {
    const nonAdminRoles: UserRole[] = ["reviewer", "clerk", "viewer"];
    for (const role of nonAdminRoles) {
      const res = requireOrgAdmin(role);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
      const body = await res!.json();
      expect(body).toEqual({ error: "forbidden" });
    }
  });
});
