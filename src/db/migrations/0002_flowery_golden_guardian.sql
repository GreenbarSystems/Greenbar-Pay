-- Hand-edited from drizzle-kit's raw `generate` output.
--
-- drizzle-kit's snapshot (meta/0001_snapshot.json) had drifted from
-- schema.ts across several prior sessions: extraction_corrections,
-- llm_circuit_state, verification_tokens, and the llm_run_status enum
-- widening were all added to schema.ts and applied via hand-written
-- sidecar SQL (0024, 0025, 0027, 0028), but drizzle-kit's own
-- generated-migration track was never regenerated to match. Running
-- `db:generate` after this session's audit_events PK change surfaced
-- ALL of that accumulated drift at once as one large migration —
-- including duplicate CREATE TABLE statements for tables the sidecars
-- already created, in some cases with a WEAKER shape (e.g. its version
-- of idx_extraction_corrections_vendor is missing the sidecar's
-- `WHERE vendor_id IS NOT NULL` partial clause). Blindly committing
-- that generated file would let it "win" the CREATE TABLE IF NOT
-- EXISTS race against the correct sidecar version on a fresh database,
-- silently downgrading several indexes.
--
-- Reconciling ALL of that historical drift is a separate, dedicated
-- cleanup — out of scope here. This file keeps ONLY the one statement
-- that's actually new and needed: making audit_events's primary key
-- composite (id, created_at), required because migration 0030
-- partitions audit_events by RANGE(created_at), and Postgres requires
-- the partition key to be part of any PK on a partitioned table.
--
-- Guarded with IF EXISTS / IF NOT EXISTS throughout so this is a safe
-- no-op on any environment where 0030 has already replaced this table
-- with the partitioned version (which declares its own composite PK
-- inline and never had a constraint literally named "audit_events_pkey").
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'audit_events'::regclass
      AND contype = 'p'
      AND conname = 'audit_events_pkey'
  ) THEN
    ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_pkey";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'audit_events'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE "audit_events"
      ADD CONSTRAINT "audit_events_id_created_at_pk" PRIMARY KEY ("id", "created_at");
  END IF;
END $$;
