-- Add actual token counts and estimated cost to llm_runs.
-- input_tokens / output_tokens: actual values from the provider response
--   (null for pre-flight failures that never reached the provider).
-- estimated_cost_usd: (input_tokens * inputCostPerMToken + output_tokens * outputCostPerMToken) / 1_000_000
--   stored as numeric(10,6) for sub-cent precision; null when tokens are null.
ALTER TABLE llm_runs
  ADD COLUMN IF NOT EXISTS input_tokens        integer,
  ADD COLUMN IF NOT EXISTS output_tokens       integer,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd  numeric(10,6);
