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
- **Status columns are Postgres ENUMs**, not `TEXT + CHECK`.
- **Mutating API endpoints take `Idempotency-Key`**; `PATCH` takes
  `If-Match` (addendum §4.6, §4.7).
- **CI gate**: `npm run test:rls` must pass on every PR.

See `README.md` for full stack, conventions, and local-dev instructions.
