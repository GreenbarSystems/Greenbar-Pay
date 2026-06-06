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

**Phase 2.1 — PDF-OCR fallback** ✓ shipped
- `pdftoppm` (poppler-utils) rasterizes scanned PDFs to one PNG per page
- New `tesseract_pdf` extractor runs Tesseract page-by-page with averaged confidence
- Job picks the better of `native_pdf` vs `tesseract_pdf` by quality score
- Rasterizer failures (missing binary, too many pages) surface as structured warnings
- Worker Dockerfile installs `poppler-utils`

**Phase 3 — LLM gateway** ✓ shipped
- Anthropic tool-use forces strict-JSON output against `INVOICE_TOOL_JSON_SCHEMA`
- §2.2 compliance registry: gateway refuses to dispatch to any model lacking ZDR + US + non-retention. Adding a model means a registry entry — checked in CI.
- §2.3 `buildExtractionPrompt` is the single allowed prompt entry point; ESLint blocks `@anthropic-ai/sdk` imports outside `src/lib/llm/internal/`
- §2.4 log scrubber strips `vendor_name | invoice_number | account_number | routing | ein | ssn | tax_id` (and raw payloads) from anything logged
- §2.7 pre-flight: 80k-token char cap (`text_too_large`), per-org daily quota (1000/day), in-memory circuit breaker (25% error rate over 5 min, 30 s half-open)
- §"Retry malformed JSON": one correction-prompted retry on schema validation failure
- §4.2 supersede: partial unique index keeps at most one `pending|needs_review` row per document; reviewer-acted rows are immune to upstream retries
- §4.1 `llm_runs` table logs every dispatch (success, schema fail, provider error, pre-flight reject) with input hash only — never the prompt text

**Phase 4 — Validation & review queue** ✓ shipped
- Deterministic validation engine (PRD blocking + warning rules with ±0.02 math tolerance)
- `vendors` master + Jaccard-token vendor matcher with low / medium / high confidence
- `validation_results` (delete-then-insert per run) + `vendor_matches` (append-only)
- `validate-extracted-invoice` job advances docs to `review_required`; PATCH reuses the same engine after edits
- `/review` queue list with status tabs, warning pills, vendor / total / confidence at a glance
- `/review/:id` side-by-side: original file preview (signed URL) + editable header + line items + findings + vendor candidates + audit drawer
- `PATCH /api/ap/review/:id` with `If-Match: <updated_at>` per §4.7 — concurrent edits race-safe at the DB layer (vitest spec proves it)
- `POST /api/ap/review/:id/approve` and `…/reject` with `Idempotency-Key` (§4.6); approve refuses while blocking findings remain
- RBAC matrix (§1.5) enforced per endpoint; every mutation lands an `audit_events` row with before/after JSON

**Phase 5 — Export & pilot readiness** ✓ shipped — **MVP cut line reached**
- Generic CSV (RFC 4180 quoting, CRLF, Excel-friendly numeric pass-through) + JSON exporters
- `exports` + `export_items` tables with RLS; `export_format` and `export_status` ENUMs
- `POST /api/ap/exports` with `Idempotency-Key` (§4.6); creates the row up-front (§4.5 idempotency anchor), enqueues `export-invoices`, refuses when any selected invoice isn't `approved`
- `export-invoices` job: compare-and-set on `exports.status`; re-confirms approval at run time; renders + uploads; advances each `extracted_invoices.review_status` and `documents.status` `approved → exported` via compare-and-set
- `GET /api/ap/exports/:id/download` redirects to a 120s signed URL
- `/review?status=approved` gets multi-select + bulk Export action (CSV / JSON picker)
- `/exports` history page with status, size, item count, download link, error tooltip
- `/dashboard` pilot metrics — uploaded, reached extraction, awaiting review, approved, extraction method mix, LLM success rate + failure breakdown, confidence distribution, duplicates caught, export success rate

MVP scope (PRD §"MVP Cut Line") is now satisfied. Post-MVP: GL coding, PO matching, ERP draft-bill connectors, payment approvals, multi-level workflow.

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

### Worker prerequisites

The worker shells out to `pdftoppm` for PDF rasterization. Install it once
per dev machine:

```
# macOS
brew install poppler

# Debian/Ubuntu
sudo apt-get install poppler-utils

# Alpine (matches the production image)
apk add poppler-utils
```

Without `pdftoppm`, scanned PDFs land in `text_extracted` with a
`rasterize:missing_binary` warning instead of OCR text.

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
