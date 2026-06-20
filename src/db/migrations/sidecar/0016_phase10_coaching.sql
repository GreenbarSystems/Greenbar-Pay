-- Phase 10 — Pre-Approval Coaching (D5).
--
-- Coaching prompts are persisted as a JSONB array on briefing_cards.
-- Same append-only / supersede lifecycle as the rest of the briefing —
-- regenerated on every revalidation, prior rows soft-superseded by
-- generateBriefingCard. Putting coaching here (vs. a separate table)
-- keeps the read path single-query and ensures the coaching the
-- approver saw at decision time is bound to the same briefing row
-- pinned in invoice.approved.metadataJson (PR6).

ALTER TABLE briefing_cards
  ADD COLUMN IF NOT EXISTS coaching_prompts_json JSONB NOT NULL DEFAULT '[]';
