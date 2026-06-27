-- Slice 2: correction-aware RAG flywheel.
--
-- Enables pgvector and creates extraction_corrections — one row per
-- approved invoice that had reviewer edits. The embedding column
-- (voyage-3, 1024 dims) is populated by the capture-and-embed worker
-- job after each approval. A null embedding falls back to vendor_id
-- exact-match retrieval in generateBriefingCard.
--
-- Requires: pgvector >= 0.5.0 (HNSW index) on Postgres 15+.
-- On RDS: available from Postgres 15.3 / Aurora Postgres 15.2.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS extraction_corrections (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      uuid        NOT NULL
                                     REFERENCES organizations(id)
                                     ON DELETE RESTRICT,
    extracted_invoice_id uuid        NOT NULL
                                     REFERENCES extracted_invoices(id)
                                     ON DELETE CASCADE,
    vendor_id            uuid
                                     REFERENCES vendors(id)
                                     ON DELETE SET NULL,
    -- [{field, extracted, corrected}]
    corrected_fields     jsonb       NOT NULL,
    -- text passed to Voyage AI for the embedding
    context_text         text        NOT NULL,
    -- voyage-3 embedding; null until capture-and-embed job runs
    embedding            vector(1024),
    confirmed_at         timestamptz NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now()
);

-- One correction row per approved invoice (idempotent captures on retry).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_extraction_corrections_invoice
    ON extraction_corrections (extracted_invoice_id);

-- ── RLS — same pattern as all tenant-scoped tables. ─────────────────
ALTER TABLE extraction_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_corrections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON extraction_corrections;
CREATE POLICY tenant_isolation ON extraction_corrections
    USING      (organization_id = app_current_org_id())
    WITH CHECK (organization_id = app_current_org_id());

-- ── Indexes ─────────────────────────────────────────────────────────
-- Fast vendor-based fallback (no embedding required).
CREATE INDEX IF NOT EXISTS idx_extraction_corrections_vendor
    ON extraction_corrections (vendor_id)
    WHERE vendor_id IS NOT NULL;

-- Org-scoped time ordering for the vendor fallback query.
CREATE INDEX IF NOT EXISTS idx_extraction_corrections_org_confirmed
    ON extraction_corrections (organization_id, confirmed_at DESC);

-- HNSW index for approximate cosine similarity search on non-null embeddings.
-- Requires pgvector >= 0.5.0. m=16 / ef_construction=64 are the defaults
-- and suit pilot-scale row counts well. Tune to m=32 when corrections > 50k.
CREATE INDEX IF NOT EXISTS idx_extraction_corrections_embedding
    ON extraction_corrections
    USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;
