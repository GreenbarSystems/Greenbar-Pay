-- Per-org 3-way PO matching toggle (phase 2).
-- Adds a boolean to organizations so each org can opt-in independently
-- without relying on a global env var. Default false (2-way only).
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS po_three_way_enabled BOOLEAN NOT NULL DEFAULT false;
