-- Add NetSuite and Sage Intacct to the export_format enum.
-- The accounting_connections table (0033) is already provider-agnostic
-- (provider is plain text), so no schema change is needed there.
ALTER TYPE export_format ADD VALUE IF NOT EXISTS 'netsuite';
ALTER TYPE export_format ADD VALUE IF NOT EXISTS 'intacct';
