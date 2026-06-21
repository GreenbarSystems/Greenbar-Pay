/**
 * Phase 9.5 PR2 — POST /api/ap/contracts/:id/activate
 *
 * Admin/owner action that promotes an `extracted` contract to `active`.
 * Side effects:
 *   · If the contract has no vendor_id, body.vendorId becomes the
 *     assignment (validated org/client scoped).
 *   · The prior active contract for the same (org, vendor) is
 *     superseded (status='superseded', superseded_at = now()).
 *   · status flips to 'active'.
 *
 * Compliance: gated on invoice.override (admin/owner). Same role
 * required for Stop Work Authority — activating a contract has
 * comparable downstream weight (every future invoice for the vendor
 * gets validated against this rate card).
 *
 * Idempotency-Key honoured (§4.6). The partial unique index
 * uniq_vendor_contracts_active_per_vendor enforces "at most one
 * active" at the DB layer — a concurrent activate attempt for the
 * same vendor will fail with the unique violation, which we map to
 * 409.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import {
  vendorContracts,
  vendors,
  documents,
  auditEvents,
} from "@/db/schema";
import { can, loadEffectiveRole } from "@/lib/rbac";
import { withIdempotency } from "@/lib/review/idempotencyWrap";
import { requireUuid } from "@/lib/route-helpers";

const ActivateBodySchema = z
  .object({
    vendorId: z.string().uuid().optional(),
  })
  .partial();

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const bad = requireUuid(params.id);
  if (bad) return bad;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { organizationId, role, id: userId } = session.user;

  let bodyJson: unknown = {};
  try {
    const raw = await req.text();
    if (raw.length > 0) bodyJson = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  let body: z.infer<typeof ActivateBodySchema>;
  try {
    body = ActivateBodySchema.parse(bodyJson);
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", issues: (err as z.ZodError).issues },
      { status: 400 },
    );
  }

  return withIdempotency(
    req,
    organizationId,
    `/api/ap/contracts/${params.id}/activate`,
    body,
    async () => {
      return withOrg(organizationId, async (tx) => {
        const [contract] = await tx
          .select()
          .from(vendorContracts)
          .where(
            and(
              eq(vendorContracts.id, params.id),
              eq(vendorContracts.organizationId, organizationId),
            ),
          )
          .limit(1);

        if (!contract) {
          return { status: 404, body: { error: "not_found" } };
        }

        if (contract.status !== "extracted") {
          return {
            status: 422,
            body: {
              error: "invalid_state",
              message: `Contract is ${contract.status}; only 'extracted' contracts can be activated.`,
              currentStatus: contract.status,
            },
          };
        }

        // PR21 C1 — Maker-checker. The user who uploaded the contract
        // PDF cannot activate it. Activation gates every future invoice
        // for this vendor against the rate card; allowing one actor to
        // both install and ratify is the textbook separation-of-duties
        // failure an auditor reads as a fabricated-rate-card risk.
        // Mirrors §1.5's invoice-side guard: uploader cannot approve
        // their own submission (see PR — task #65).
        const [uploader] = await tx
          .select({ createdBy: documents.createdBy })
          .from(documents)
          .where(eq(documents.id, contract.documentId))
          .limit(1);
        if (uploader?.createdBy && uploader.createdBy === userId) {
          await tx.insert(auditEvents).values({
            organizationId,
            actorType: "user",
            actorId: userId,
            action: "contract.activate_denied_sod",
            entityType: "vendor_contract",
            entityId: contract.id,
            metadataJson: {
              reason: "uploader_cannot_activate_own_submission",
              documentId: contract.documentId,
            },
          });
          return {
            status: 403,
            body: {
              error: "separation_of_duties",
              message:
                "The user who uploaded a contract cannot activate it. Ask a second admin to ratify.",
            },
          };
        }

        // RBAC — resolve effective role against the linked vendor's
        // client when known (per §1.5). Contracts with vendor_id NULL
        // fall back to the org-wide role check; the body.vendorId
        // assignment below re-resolves once we know the vendor.
        let effectiveRole = role;
        if (contract.vendorId) {
          const [v] = await tx
            .select({ clientId: vendors.clientId })
            .from(vendors)
            .where(eq(vendors.id, contract.vendorId))
            .limit(1);
          effectiveRole = await loadEffectiveRole(tx, {
            userId,
            clientId: v?.clientId ?? null,
            orgRole: role,
          });
        }
        if (!can(effectiveRole, "invoice.override")) {
          return {
            status: 403,
            body: {
              error: "forbidden",
              message: `${effectiveRole} lacks invoice.override (required to activate contracts).`,
            },
          };
        }

        // Resolve the vendor: prefer the row's vendor_id; fall back to
        // body.vendorId for contracts that landed unresolved.
        let vendorId = contract.vendorId;
        if (!vendorId) {
          if (!body.vendorId) {
            return {
              status: 422,
              body: {
                error: "vendor_required",
                message:
                  "Contract has no resolved vendor. Supply vendorId in the body.",
              },
            };
          }
          const [v] = await tx
            .select({ id: vendors.id })
            .from(vendors)
            .where(
              and(
                eq(vendors.id, body.vendorId),
                eq(vendors.organizationId, organizationId),
              ),
            )
            .limit(1);
          if (!v) {
            return {
              status: 422,
              body: {
                error: "invalid_vendor",
                message: "vendorId does not match a vendor in this organisation.",
              },
            };
          }
          vendorId = v.id;
        }

        // Supersede the prior active contract for the same vendor (if
        // any). Same tx so an audit trail observer sees the supersede
        // and the activation as atomic.
        const [priorActive] = await tx
          .update(vendorContracts)
          .set({
            status: "superseded",
            supersededAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(vendorContracts.organizationId, organizationId),
              eq(vendorContracts.vendorId, vendorId),
              eq(vendorContracts.status, "active"),
            ),
          )
          .returning({ id: vendorContracts.id });

        // Promote this contract.
        const [activated] = await tx
          .update(vendorContracts)
          .set({
            status: "active",
            vendorId,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(vendorContracts.id, params.id),
              eq(vendorContracts.status, "extracted"),
            ),
          )
          .returning({ id: vendorContracts.id });

        if (!activated) {
          // A racing activate hit the CAS first. Map to 409 so the
          // caller knows to refetch state.
          return {
            status: 409,
            body: { error: "not_extracted", message: "Contract is no longer in 'extracted' state." },
          };
        }

        if (priorActive) {
          await tx.insert(auditEvents).values({
            organizationId,
            actorType: "user",
            actorId: userId,
            action: "contract.superseded",
            entityType: "vendor_contract",
            entityId: priorActive.id,
            metadataJson: {
              supersededBy: activated.id,
              vendorId,
            },
          });
        }

        await tx.insert(auditEvents).values({
          organizationId,
          actorType: "user",
          actorId: userId,
          action: "contract.activated",
          entityType: "vendor_contract",
          entityId: activated.id,
          metadataJson: {
            vendorId,
            priorActiveContractId: priorActive?.id ?? null,
            assignedVendorAtActivation: !contract.vendorId,
          },
        });

        return {
          status: 200,
          body: {
            contractId: activated.id,
            vendorId,
            supersededContractId: priorActive?.id ?? null,
            status: "active",
          },
        };
      });
    },
  );
}
