# Greenbar Pay

AP invoice intake, OCR, and LLM extraction with a human review queue. See
`docs/ap-invoice-ai-mvp-technical-prd-merged.md` for the PRD; the addendum
overrides the base PRD where they conflict.

## Status

**Phase 1 — Foundation** ✓ shipped
- Next.js App Router + Tailwind
- Postgres + Drizzle with **RLS enabled on every tenant-scoped table** (addendum §1.2)
- `withOrg(orgId, fn)` helper; raw Drizzle access blocked by ESLint (§1.4)
- `user_role` enum + `user_client_access` matrix (§1.5)
- Status columns as ENUMs (§4.3)
- Upload endpoint with §2.6 file-safety controls (size, MIME sniff, hash; AV + qpdf hooks stubbed)
- AP inbox page that lists documents by status

**Phase 2 — OCR & text pipeline** ✓ shipped
- pg-boss background queue (uses `FOR UPDATE SKIP LOCKED`, addendum §4.4)
- `process-document` job: native PDF extraction → Tesseract fallback for image inputs
- `document_extractions` append-only table with RLS (§4.1)
- Text quality scoring drives the OCR-fallback decision
- Compare-and-set status transitions (§4.5) make retries safe
- Worker service in docker-compose; same image as web

LLM extraction, validation, review queue, and export ship in later phases.

## Local dev

```
cp .env.example .env
docker compose up -d              # postgres + minio
pnpm install
pnpm db:migrate                   # schema + RLS + app_user / app_worker roles
pnpm dev                          # web at http://localhost:3000
pnpm worker:dev                   # worker (separate terminal)

# OR run everything in containers:
docker compose --profile app up   # postgres + minio + worker
```

## Tests

```
pnpm test:rls    # cross-tenant isolation test (addendum §1.6) — CI gate
pnpm test        # full suite
```

## Conventions

- **No direct ORM calls.** Every tenant query goes through `withOrg` so the
  GUC `app.current_org_id` is set before any read/write. The ESLint rule
  enforces this; CI fails on violations.
- **ENUMs over TEXT.** Status columns are constrained types — bad values
  fail at the DB, not in app logic.
- **Append vs. upsert.** Tables that retry-by-attempt (`document_extractions`,
  `llm_runs`, `validation_results`, `audit_events`) append; tables that
  retry-by-supersede (`extracted_invoices`) use the unique-partial-index
  pattern from §4.2.
