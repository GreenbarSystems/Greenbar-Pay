# Greenbar Pay — Agent Instructions

## Product direction: solo-first

This repo is in a **multi-client freeze**. The product is shifting to a
solo-first SaaS shape: one customer organization per account, single-user
workflow (with multi-user-within-org coming back later), **no client
picker, no per-client routing, no CPA-firm features**.

The decision was made by the product owner on the date of this commit.
Direction: do not invest further in the multi-client surface until the
freeze is explicitly lifted.

## What is gated by the freeze

The repo's existing multi-client architecture stays in place — code,
schema, and tests — but is gated at runtime by `ENABLE_MULTI_CLIENT`
(see `src/lib/featureFlags.ts`, default off). The frozen surfaces are:

- **`clients` table** and `user_client_access` join table
- **Per-client AP inbox routing** (`ap+<org>--<client>@in.<domain>` —
  see `src/lib/inbox/address.ts`). Solo mode collapses to org-only.
- **Per-client RBAC scoping** (`src/lib/rbac/client-scope.ts`,
  `loadPermittedClientIds`). Solo mode treats the user as having
  org-wide read.
- **Client filters and pickers** in the UI: inbox, review queue,
  exports, upload, vendors.
- **The CPA-firm and firm-owner personas** in the PRD
  (`docs/ap-invoice-ai-mvp-technical-prd-merged.md`). The bookkeeper,
  controller, clerk, reviewer, and admin personas remain.

RLS (`addendum §1`) is **NOT** part of the freeze. Org isolation is still
non-negotiable — every tenant query goes through `withOrg`.

## Rule for new code

When you touch a code path that has a multi-client surface:

1. **Read `isMultiClientEnabled()`** from `src/lib/featureFlags.ts`.
2. **Render or accept the multi-client UI/parameter only when the flag
   is on.** When off, behave as if there is exactly one client per org
   (or no client concept at all — depending on the surface).
3. **Do not add new multi-client features** without first asking whether
   the freeze should be lifted. New work on the solo surface is fine
   and encouraged.
4. **Existing tests for multi-client code stay green** — they run with
   the flag forced on inside the test. Don't delete them.

## Why not rip the code out

The decision was explicitly to **freeze, not remove**. We may resurrect
multi-client work if a CPA-firm customer materializes. Ripping out the
schema would force a destructive migration that is hard to reverse.
Gating preserves optionality at near-zero ongoing cost.

## Other agent guidance

- **No direct ORM access outside `withOrg`** — enforced by ESLint.
- **No direct `@anthropic-ai/sdk` imports outside `src/lib/llm/internal/`**
  — also enforced by ESLint.
- **Worker code may not import from `src/app/`**. The worker is built
  from `Dockerfile.worker` with `tsconfig.worker.json` excluding
  `src/app/`. CI runs `npm run typecheck:worker` to enforce. If you add
  a new worker dependency, make sure it lives under `src/{db,jobs,lib}`
  or `scripts/`.
- **Status columns are Postgres ENUMs**, not `TEXT + CHECK`.
- **Mutating API endpoints take `Idempotency-Key`**; `PATCH` takes
  `If-Match` (addendum §4.6, §4.7).
- **CI gate**: `npm run test:rls` must pass on every PR.

## Operational notes

These aren't rules for new code — they're things that have surprised
people in deploy / pre-pilot review. Keep them in mind when touching
adjacent code.

### PgBouncer must be transaction-mode (not session-mode)

`withOrg` sets the tenant GUC via `SET LOCAL app.current_org_id = $1`
inside a transaction (`src/db/client.ts`). `SET LOCAL` ties the value
to the transaction, which is what makes pooling safe — the next
checkout from the same backend connection starts with the GUC reset.

PgBouncer in **transaction-mode** is the only pooling mode that
preserves this property under load. In session-mode, multiple
transactions in the same session share GUCs across checkouts, and the
tenant GUC from an earlier request can leak into a later one. In
statement-mode, prepared statements break.

Pool sizing today (see `src/db/internal/rawClient.ts`):

  - `app_user`   max 15 (overridable via `DATABASE_POOL_MAX_USER`)
  - `app_worker` max 25 (overridable via `DATABASE_POOL_MAX_WORKER`)
  - `app_admin`  max 4  (overridable via `DATABASE_POOL_MAX_ADMIN`)

The pre-pilot review math: a 15-invoice approval burst can produce
24+ concurrent connection requests against the worker pool through
`validateExtractedInvoice` (batchSize=16) + `recomputeVendorProfile`
(8) + `assembleEvidencePacket` (8). If you see "connection pool
exhausted" warnings in worker logs under load, either raise the
worker pool max or drop one of those batch sizes in `src/jobs/index.ts`.

### RLS migration load order

Sidecar migrations `0001_rls.sql` through `0005_rls_phase5.sql` were
written before `0021_issue3_rls_null_safe.sql` introduced the
`app_current_org_id()` helper that NULL-safely casts the GUC.

If you ever apply migrations in isolation (e.g. spinning up a fresh
DB at an earlier revision for repro purposes), 0001–0005's
`current_setting('app.current_org_id', true)::uuid` will throw on
queries made before the GUC is set (empty string → `''::uuid` fails).
The full migration set including 0021 is what production runs; the
order shipped in this repo is correct end-to-end. The risk is only
for ad-hoc partial replays.

If you find yourself wanting to backfill 0001–0005 to use the helper,
that's a fine cleanup — make sure 0021 still runs idempotently after.

See `README.md` for full stack, conventions, and local-dev instructions.
