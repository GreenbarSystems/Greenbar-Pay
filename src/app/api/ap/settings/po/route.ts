/**
 * GET   /api/ap/settings/po — return org's PO matching settings
 * PATCH /api/ap/settings/po — update poThreeWayEnabled
 *
 * Requires users.manage (owner + admin only), same gate as the
 * workflow settings route.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { organizations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { can } from "@/lib/rbac";

function requireAdmin(role: string) {
  if (!can(role as Parameters<typeof can>[0], "users.manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role } = session.user;

  const gate = requireAdmin(role);
  if (gate) return gate;

  const [org] = await withOrg(organizationId, async (tx) =>
    tx
      .select({ poThreeWayEnabled: organizations.poThreeWayEnabled })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1),
  );

  if (!org) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ poThreeWayEnabled: org.poThreeWayEnabled });
}

const PatchSchema = z.object({
  poThreeWayEnabled: z.boolean(),
});

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role } = session.user;

  const gate = requireAdmin(role);
  if (gate) return gate;

  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", issues: (err as z.ZodError).issues },
      { status: 400 },
    );
  }

  const [updated] = await withOrg(organizationId, async (tx) =>
    tx
      .update(organizations)
      .set({ poThreeWayEnabled: body.poThreeWayEnabled })
      .where(eq(organizations.id, organizationId))
      .returning({ poThreeWayEnabled: organizations.poThreeWayEnabled }),
  );

  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ poThreeWayEnabled: updated.poThreeWayEnabled });
}
