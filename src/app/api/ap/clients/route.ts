/**
 * GET  /api/ap/clients — list all clients in the org
 * POST /api/ap/clients — create a new client
 *
 * Gated by isMultiClientEnabled() (freeze lifted 2026-07-16).
 * Requires clients.manage permission (owner + admin).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { clients, extractedInvoices } from "@/db/schema";
import { and, count, eq, sql } from "drizzle-orm";
import { can } from "@/lib/rbac";
import { isMultiClientEnabled } from "@/lib/featureFlags";

function featureGate() {
  if (!isMultiClientEnabled()) {
    return NextResponse.json({ error: "multi_client_disabled" }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const gate = featureGate();
  if (gate) return gate;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role } = session.user;

  if (!can(role, "clients.manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const rows = await withOrg(organizationId, async (tx) => {
    return tx
      .select({
        id: clients.id,
        name: clients.name,
        slug: clients.slug,
        externalAccountingSystem: clients.externalAccountingSystem,
        createdAt: clients.createdAt,
        invoiceCount: count(extractedInvoices.id),
        pendingCount: sql<number>`count(${extractedInvoices.id}) filter (where ${extractedInvoices.reviewStatus} in ('pending', 'needs_review', 'pending_final_approval'))`,
      })
      .from(clients)
      .leftJoin(extractedInvoices, and(
        eq(extractedInvoices.clientId, clients.id),
        eq(extractedInvoices.organizationId, organizationId),
      ))
      .where(eq(clients.organizationId, organizationId))
      .groupBy(clients.id)
      .orderBy(clients.name);
  });

  return NextResponse.json({ clients: rows });
}

const CreateClientSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  externalAccountingSystem: z.string().max(100).nullable().optional(),
});

export async function POST(req: Request) {
  const gate = featureGate();
  if (gate) return gate;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role } = session.user;

  if (!can(role, "clients.manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: z.infer<typeof CreateClientSchema>;
  try {
    body = CreateClientSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", issues: (err as z.ZodError).issues },
      { status: 400 },
    );
  }

  const [created] = await withOrg(organizationId, async (tx) => {
    return tx
      .insert(clients)
      .values({
        organizationId,
        name: body.name,
        slug: body.slug,
        externalAccountingSystem: body.externalAccountingSystem ?? null,
      })
      .returning({ id: clients.id, name: clients.name, slug: clients.slug });
  });

  return NextResponse.json({ client: created }, { status: 201 });
}
