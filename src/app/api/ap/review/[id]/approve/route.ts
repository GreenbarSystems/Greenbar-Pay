/**
 * POST /api/ap/review/:id/approve — finalize a reviewed invoice.
 *
 * Refuses to approve while blocking validation findings are present —
 * those have to be resolved via PATCH first.
 *
 * Refuses to approve while NO validation row exists yet — that closes
 * the race window between extract-invoice-data completing and
 * validate-extracted-invoice running.
 *
 * Refuses to approve when the same user uploaded the source document
 * (separation of duties — placeholder; PR2 wires this with audit
 * metadata).  TODO(SoD): see review #2.
 *
 * Compare-and-set on review_status (§4.5):
 *   WHERE review_status IN ('pending', 'needs_review')
 * `reviewed_at` is sourced from the DB clock (sql`now()`) — Node
 * `new Date()` would be a forgeable attestation timestamp.
 * Idempotency-Key honored (§4.6).
 *
 * Audit row carries a content snapshot in `beforeJson` so the
 * attestation event proves *what* was approved, not just that
 * someone clicked approve.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import {
  extractedInvoices,
  validationResults,
  auditEvents,
  documents,
  briefingCards,
  llmRuns,
  invoiceOverrideLog,
  users,
} from "@/db/schema";
import { riskBand } from "@/lib/briefing/risk-score";
import { can, loadEffectiveRole } from "@/lib/rbac";
import { withIdempotency } from "@/lib/review/idempotencyWrap";
import {
  requireUuid,
  pickFields,
  INVOICE_HEADER_FIELDS,
} from "@/lib/route-helpers";
import { bootstrapVendorOnApprove } from "@/lib/vendors/bootstrap";
import { getQueue, JOB } from "@/lib/queue";
import { scrubError } from "@/lib/llm/scrub";

/**
 * Phase 11 — F02 Stop Work Authority body schema. When blocking
 * findings exist, the route refuses unless the body includes a
 * justification of at least 20 chars (the DB CHECK echoes this floor).
 * Body is optional on the happy path — clean approves don't touch it.
 */
const ApproveBodySchema = z
  .object({
    overrideJustification: z
      .string()
      .min(20, "justification must be at least 20 characters")
      .max(2000)
      .optional(),
    secondApproverId: z.string().uuid().optional(),
  })
  .partial();

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const bad = requireUuid(params.id);
  if (bad) return bad;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role, id: userId } = session.user;

  // PR3 — review #16: org-role check is now the cheap fast path; if the
  // org-wide role doesn't grant, fall through to the per-client lookup
  // inside the tx (after we know the invoice's clientId). Skips a DB
  // round trip for the common case where the org role already permits.
  const hasOrgPermission = can(role, "invoice.approve");

  // Phase 11 F02 — parse override body when present. Empty body still
  // produces a valid (empty) object; only malformed JSON throws.
  let bodyJson: unknown = {};
  try {
    const raw = await req.text();
    if (raw.length > 0) bodyJson = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  let body: z.infer<typeof ApproveBodySchema>;
  try {
    body = ApproveBodySchema.parse(bodyJson);
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", issues: (err as z.ZodError).issues },
      { status: 400 },
    );
  }
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent");

  return withIdempotency(
    req,
    organizationId,
    `/api/ap/review/${params.id}/approve`,
    body,
    async () => {
      const txResult = await withOrg(organizationId, async (tx) => {
        // Block approval until an ACTIVE validation row EXISTS (closes the
        // race window between extract-invoice-data and validate-extracted-
        // invoice) AND, if it exists, has no blocking findings.
        //
        // PR2: validation_results is append-only — `WHERE superseded_at
        // IS NULL` selects the current row, prior runs are preserved.
        const [latest] = await tx
          .select()
          .from(validationResults)
          .where(
            and(
              eq(validationResults.entityType, "extracted_invoice"),
              eq(validationResults.entityId, params.id),
              isNull(validationResults.supersededAt),
            ),
          )
          .orderBy(desc(validationResults.createdAt))
          .limit(1);
        if (!latest) {
          return {
            status: 409,
            body: {
              error: "validation_pending",
              message:
                "Validation has not run yet for this invoice. Retry in a few seconds.",
            },
          };
        }
        // Phase 11 — F02 Stop Work Authority. With blocking findings
        // present, approve is refused UNLESS the caller provided an
        // override justification ≥ 20 chars. The override is recorded
        // before commit so it can never be missing from the audit
        // chain even on a partial write. Only admin/owner can use the
        // override path; reviewer can approve clean invoices only.
        const hasBlockingFindings =
          latest.severity === "blocking" && !latest.passed;
        const isOverrideAttempt =
          hasBlockingFindings && !!body.overrideJustification;
        if (hasBlockingFindings && !isOverrideAttempt) {
          return {
            status: 422,
            body: {
              error: "blocking_findings",
              message:
                "Invoice has blocking validation findings. Resolve via PATCH or supply an overrideJustification (Stop Work Authority).",
            },
          };
        }
        // PR14 C-RBAC-Override — the override check used to fire on the
        // org-level role only, which inverted the per-client RBAC rule
        // PR3 established for invoice.approve. A user who is `reviewer`
        // at the org but elevated to `admin` on a specific client
        // legitimately has override per effectiveRole = max(orgRole,
        // clientRole). We defer the override permission check until
        // AFTER the row snapshot below so we can resolve effectiveRole
        // against the invoice's clientId, mirroring invoice.approve.

        // Snapshot the row BEFORE the UPDATE so the audit event records
        // the content that was approved. PATCH already does this.
        const [before] = await tx
          .select()
          .from(extractedInvoices)
          .where(
            and(
              eq(extractedInvoices.id, params.id),
              eq(extractedInvoices.organizationId, organizationId),
            ),
          )
          .limit(1);
        if (!before) {
          return {
            status: 404,
            body: { error: "not_found" },
          };
        }

        // PR3 — per-client RBAC. If org role didn't grant, look up the
        // user's role for THIS client and compose. Per §1.5 effective
        // permission = max(orgRole, clientRole). PR14 — also resolves
        // effectiveRole for the override permission check below so the
        // two gates use the same role resolution.
        let effectiveRole = role;
        if (!hasOrgPermission) {
          effectiveRole = await loadEffectiveRole(tx, {
            userId,
            clientId: before.clientId,
            orgRole: role,
          });
          if (!can(effectiveRole, "invoice.approve")) {
            return {
              status: 403,
              body: {
                error: "forbidden",
                message: `${effectiveRole} lacks invoice.approve`,
              },
            };
          }
        }

        // PR14 C-RBAC-Override — effectiveRole is now resolved above;
        // gate Stop Work Authority on the same composed role used for
        // invoice.approve. Without this an org-level reviewer who's
        // admin-on-this-client couldn't use the override despite
        // having the equivalent permission for the approval itself.
        if (isOverrideAttempt && !can(effectiveRole, "invoice.override")) {
          return {
            status: 403,
            body: {
              error: "forbidden",
              message:
                "Override (Stop Work Authority) requires admin or owner role.",
            },
          };
        }

        // PR2 — separation of duties (review #2):
        // The user who uploaded the source document cannot also approve
        // the resulting invoice. This is the single highest-risk gap the
        // adversarial review flagged. Maker-checker enforced at the
        // service layer because the RBAC role does not differentiate
        // upload vs approve (both `reviewer` permissions).
        const [parentDoc] = await tx
          .select({ id: documents.id, createdBy: documents.createdBy })
          .from(documents)
          .where(eq(documents.id, before.documentId))
          .limit(1);
        if (parentDoc?.createdBy && parentDoc.createdBy === userId) {
          // PR6 — review #2 / #3 SoD denial audit. A SOX-style auditor
          // needs evidence the SoD control fired; a silent 403 leaves
          // the operation invisible. Insert BEFORE the return so the
          // event is captured in the same tx — the early return commits
          // the audit row along with no other state change.
          await tx.insert(auditEvents).values({
            organizationId,
            actorType: "user",
            actorId: userId,
            action: "invoice.sod_denied",
            entityType: "extracted_invoice",
            entityId: params.id,
            metadataJson: {
              attemptedAction: "approve",
              uploaderId: parentDoc.createdBy,
            },
          });
          return {
            status: 403,
            body: {
              error: "sod_violation",
              message:
                "The user who uploaded this document cannot approve it. Ask a second reviewer.",
            },
          };
        }

        const [updated] = await tx
          .update(extractedInvoices)
          .set({
            reviewStatus: "approved",
            reviewedBy: userId,
            // DB clock — Node `new Date()` is forgeable, every other
            // timestamp in this codebase is server-side.
            reviewedAt: sql`now()`,
          })
          .where(
            and(
              eq(extractedInvoices.id, params.id),
              eq(extractedInvoices.organizationId, organizationId),
              inArray(extractedInvoices.reviewStatus, ["pending", "needs_review"]),
            ),
          )
          .returning({
            id: extractedInvoices.id,
            documentId: extractedInvoices.documentId,
          });

        if (!updated) {
          return {
            status: 409,
            body: { error: "not_active", message: "Invoice is not in a reviewable state." },
          };
        }

        await tx
          .update(documents)
          .set({ status: "approved" })
          .where(
            and(
              eq(documents.id, updated.documentId),
              inArray(documents.status, ["review_required", "llm_extracted"]),
            ),
          );

        // Phase 7 — D1: auto-bootstrap the vendor master + promote any
        // fuzzy-matched alias. Done inside the same tx so the audit row
        // can record the resolved vendor_id.
        const bootstrap = await bootstrapVendorOnApprove(tx, {
          organizationId,
          clientId: before.clientId,
          extractedInvoiceId: params.id,
          extractedVendorName: before.vendorName,
          extractedPaymentTerms: before.paymentTerms,
          actorUserId: userId,
        });

        // PR6 — review #4: pin the active briefing card at approve time.
        //
        // Without this, a PATCH-triggered briefing regenerate that lands
        // milliseconds before the approve commit can supersede the card
        // the reviewer actually saw. Phase 11's evidence packet won't
        // know which card to bind to the attestation.
        //
        // Strategy:
        //   1. Read the active briefing_cards row inside the same tx.
        //   2. Record its id in invoice.approved.metadataJson so audit
        //      queries can resolve it even if it's later superseded.
        //   3. Lock it from further regenerate via the partial index —
        //      we mark it superseded at approve time BUT set a small
        //      `metadataJson.frozenAt` marker. Future Phase 11 code
        //      will pin via an FK on extracted_invoices; this PR keeps
        //      the audit-row reference as the minimum.
        // PR12 H1+H2 — pin the briefing card AND the full attestation
        // chain (llm_run id, prompt input hash, risk score + version +
        // band) into the audit event metadata. Without this, an audit
        // query starting from `audit_events` can't reproduce the score
        // without joining through briefing_cards and llm_runs — and
        // if the active briefing race produced a null card id, the
        // score / version / hash become unrecoverable from the audit
        // log alone.
        // PR17 M-Approve-LLM-Lookup — fold the llm_runs lookup into the
        // briefing card select with a leftJoin. The prior PR12 H1
        // sequence (select briefing, then conditionally select llm_run
        // by id) ran two serial round trips on the user-facing approve
        // hot path. The leftJoin gives the same result in one round
        // trip and leaves the schemas decoupled (briefingCards.llmRunId
        // is still the only FK; the join is a read-time concern).
        const [activeBriefing] = await tx
          .select({
            id: briefingCards.id,
            generatedAt: briefingCards.createdAt,
            llmRunId: briefingCards.llmRunId,
            riskScore: briefingCards.riskScore,
            riskScoreVersion: briefingCards.riskScoreVersion,
            llmInputHash: llmRuns.inputHash,
          })
          .from(briefingCards)
          .leftJoin(llmRuns, eq(llmRuns.id, briefingCards.llmRunId))
          .where(
            and(
              eq(briefingCards.extractedInvoiceId, params.id),
              isNull(briefingCards.supersededAt),
            ),
          )
          .orderBy(desc(briefingCards.createdAt))
          .limit(1);
        const llmInputHash = activeBriefing?.llmInputHash ?? null;

        // Phase 11 F02 — Stop Work Authority. Record the override
        // BEFORE the invoice.approved audit so the chain is:
        //   invoice.override_recorded → invoice.approved
        // never just invoice.approved with no preceding override.
        let overrideRowId: string | null = null;
        if (isOverrideAttempt && body.overrideJustification) {
          // PR20 — validate secondApproverId is a real user in this
          // org and not the overriding user. The audit chain claims a
          // second human reviewed; accepting an arbitrary caller-
          // supplied UUID (which the prior code did) trivialises that
          // claim. The user table lookup is org-scoped via RLS so a
          // cross-org id never matches.
          if (body.secondApproverId) {
            if (body.secondApproverId === userId) {
              return {
                status: 422,
                body: {
                  error: "invalid_second_approver",
                  message:
                    "Second approver must be a different user than the approver.",
                },
              };
            }
            const [secondApprover] = await tx
              .select({ id: users.id })
              .from(users)
              .where(eq(users.id, body.secondApproverId))
              .limit(1);
            if (!secondApprover) {
              return {
                status: 422,
                body: {
                  error: "invalid_second_approver",
                  message:
                    "Second approver id does not match a user in this organisation.",
                },
              };
            }
          }
          const blockingCodes = Array.isArray(latest.errorsJson)
            ? (latest.errorsJson as Array<{ code: string; severity: string }>)
                .filter((f) => f.severity === "blocking")
                .map((f) => f.code)
            : [];
          const [overrideRow] = await tx
            .insert(invoiceOverrideLog)
            .values({
              organizationId,
              extractedInvoiceId: params.id,
              documentId: before.documentId,
              overridingUserId: userId,
              secondApproverId: body.secondApproverId ?? null,
              justificationText: body.overrideJustification,
              overrideAmount:
                before.total === null ? null : String(before.total),
              blockingFindingCodes: blockingCodes,
              // PR14 C1 — invoice_override_log.ip_address is Postgres
              // INET; Drizzle's TS schema models it as text() but writes
              // need an explicit ::inet cast or Postgres throws
              // "column is of type inet but expression is of type text"
              // and the entire tx rolls back — taking the approve down
              // with it. The cast handles null safely (NULL::inet).
              ipAddress: sql`${ipAddress}::inet`,
              userAgent: userAgent?.slice(0, 500) ?? null,
              approvedAt: sql`now()`,
            })
            .returning({ id: invoiceOverrideLog.id });
          overrideRowId = overrideRow?.id ?? null;

          await tx.insert(auditEvents).values({
            organizationId,
            actorType: "user",
            actorId: userId,
            action: "invoice.override_recorded",
            entityType: "extracted_invoice",
            entityId: params.id,
            metadataJson: {
              overrideId: overrideRowId,
              blockingFindingCodes: blockingCodes,
              validationResultId: latest.id,
              hasSecondApprover: !!body.secondApproverId,
              secondApproverId: body.secondApproverId ?? null,
              justificationLength: body.overrideJustification.length,
              // PR15 M1 — explicit marker that the F02 spec's second-
              // approver requirement above a $-threshold is currently
              // unenforced. Auditor can query for this flag to know
              // the gap is visible (not silently deferred). When the
              // threshold lands the flag flips false and the audit
              // semantic is preserved.
              secondApproverEnforced: false,
              overrideAmount:
                before.total === null ? null : String(before.total),
            },
          });
        }

        await tx.insert(auditEvents).values({
          organizationId,
          actorType: "user",
          actorId: userId,
          action: "invoice.approved",
          entityType: "extracted_invoice",
          entityId: params.id,
          beforeJson: pickFields(
            before as unknown as Record<string, unknown>,
            INVOICE_HEADER_FIELDS,
          ),
          metadataJson: {
            validationResultId: latest.id,
            findingCount: Array.isArray(latest.errorsJson)
              ? (latest.errorsJson as unknown[]).length
              : 0,
            // PR18 — SoD outcome split into three states so the audit
            // log doesn't lie. Previously we recorded sodPassed=true
            // unconditionally, even when createdBy was null (email-
            // ingested documents): the gate short-circuited to "pass"
            // because `null === userId` is false, but the audit said
            // the control ran successfully. CPA-firm intake is mostly
            // email, so this defeated the maker-checker control for
            // the primary intake channel.
            //
            // States:
            //   "passed"       — uploader present AND ≠ approver
            //   "self_uploader"— uploader === approver (rejected earlier
            //                    with sod_denied event)
            //   "skipped_no_uploader"
            //                  — document has no human uploader
            //                    (email ingest); the control is not
            //                    applicable rather than passed
            sodChecked: parentDoc?.createdBy !== null && parentDoc?.createdBy !== undefined,
            sodResult:
              parentDoc?.createdBy === null || parentDoc?.createdBy === undefined
                ? "skipped_no_uploader"
                : "passed",
            vendorBootstrap: bootstrap,
            uploaderId: parentDoc?.createdBy ?? null,
            // Phase 11 F02 — link the override row so an audit query
            // starting from invoice.approved can resolve the override
            // without a separate join.
            overrideId: overrideRowId,
            overrideUsed: isOverrideAttempt,
            // PR6 — review #4: briefing card pinned at approve time.
            // null is valid (no card existed yet, e.g. validation race);
            // the pre-flight already blocks approval until validation
            // runs, so this should normally be non-null in practice.
            activeBriefingCardId: activeBriefing?.id ?? null,
            briefingGeneratedAt: activeBriefing?.generatedAt
              ? activeBriefing.generatedAt.toISOString()
              : null,
            // PR12 H1+H2 — full attestation chain. llmRunId + inputHash
            // bind the score to the exact prompt the model saw; the
            // riskScore / riskScoreVersion / riskBand triplet lets an
            // auditor verify the deterministic compute by checking out
            // the matching commit. All five fields are nullable: when
            // the briefing card race produces no active card, the
            // audit still records that the gap existed.
            briefingLlmRunId: activeBriefing?.llmRunId ?? null,
            briefingInputHash: llmInputHash,
            riskScore: activeBriefing?.riskScore ?? null,
            riskScoreVersion: activeBriefing?.riskScoreVersion ?? null,
            riskBand:
              activeBriefing?.riskScore !== undefined &&
              activeBriefing?.riskScore !== null
                ? riskBand(activeBriefing.riskScore)
                : null,
          },
        });

        return {
          status: 200,
          body: {
            extractedInvoiceId: params.id,
            reviewStatus: "approved",
            vendorBootstrap: bootstrap,
          },
          // Phase 7 — D1: vendor profile recompute is enqueued AFTER
          // commit, not inside the tx. Stashing the vendorId here.
          enqueueRecompute: bootstrap?.vendorId ?? null,
        };
      });

      // Phase 7 — D1: kick the profile recompute job once the approve
      // committed. PR5 — review C3: wrap in try/catch so a transient
      // pg-boss outage doesn't bleed back into the response (idempotency
      // cache wouldn't be written, retries would 409 since status is now
      // `approved`). The recompute job is idempotent and the next approve
      // for any vendor will pick up a missed run, so a swallowed enqueue
      // failure is recoverable. Failure is scrubbed-and-logged so an
      // operator can spot a pattern.
      if (
        "enqueueRecompute" in txResult &&
        typeof txResult.enqueueRecompute === "string"
      ) {
        try {
          const boss = await getQueue();
          await boss.send(
            JOB.recomputeVendorProfile,
            { vendorId: txResult.enqueueRecompute, organizationId },
            { singletonKey: `recompute-vendor-profile:${txResult.enqueueRecompute}` },
          );
        } catch (err) {
          console.warn(
            `[approve] recompute-vendor-profile enqueue failed for vendor=${txResult.enqueueRecompute}; approve committed, profile will refresh on next approve`,
            scrubError(err),
          );
        }
      }

      // Phase 11 D4 — kick the evidence-packet assemble job for every
      // approve (override or not). Same wrap-in-try pattern as the
      // recompute enqueue: a transient pg-boss outage shouldn't bleed
      // into the response. The assemble job is idempotent on
      // (org, invoiceId), so an operator can replay manually if needed.
      if (txResult.status === 200) {
        try {
          const boss = await getQueue();
          await boss.send(
            JOB.assembleEvidencePacket,
            { extractedInvoiceId: params.id, organizationId },
            { singletonKey: `assemble-evidence-packet:${params.id}` },
          );
        } catch (err) {
          console.warn(
            `[approve] assemble-evidence-packet enqueue failed for invoice=${params.id}; approve committed, packet can be re-enqueued by an operator`,
            scrubError(err),
          );
        }
      }

      return { status: txResult.status, body: txResult.body };
    },
  );
}
