/**
 * GET   /api/ap/settings/workflow — return org's approvalStagesRequired
 * PATCH /api/ap/settings/workflow — update approvalStagesRequired (1 or 2)
 *
 * Requires users.manage or clients.manage (owner + admin only).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { organizations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireOrgAdmin } from "@/lib/api/route-guards";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role } = session.user;

  const gate = requireOrgAdmin(role);
  if (gate) return gate;

  const [org] = await withOrg(organizationId, async (tx) =>
    tx
      .select({ approvalStagesRequired: organizations.approvalStagesRequired })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1),
  );

  if (!org) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ approvalStagesRequired: org.approvalStagesRequired });
}

const PatchSchema = z.object({
  approvalStagesRequired: z.number().int().min(1).max(2),
});

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role } = session.user;

  const gate = requireOrgAdmin(role);
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
      .set({ approvalStagesRequired: body.approvalStagesRequired })
      .where(eq(organizations.id, organizationId))
      .returning({ approvalStagesRequired: organizations.approvalStagesRequired }),
  );

  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ approvalStagesRequired: updated.approvalStagesRequired });
}
