/**
 * Runtime feature flags.
 *
 * Currently the only flag is the multi-client freeze. The repo was
 * built around the CPA-firm persona (one org, many client companies)
 * via the `clients`, `user_client_access`, and per-client AP inbox
 * routing surfaces. Product direction is now solo-first: a single
 * customer org per account, no client picker.
 *
 * The multi-client schema and code remain in place (RLS isolation, the
 * tables, the address parser, the per-client RBAC scope helper) so we
 * can resurrect the feature without a migration. They are gated off at
 * runtime by `ENABLE_MULTI_CLIENT` (default: off).
 *
 * Read this flag in any code path that exposes a client picker, a
 * client filter, or a per-client routing decision. Do NOT add new
 * multi-client surfaces without first lifting the freeze — see
 * CLAUDE.md and the "Multi-Client Freeze" section in the README.
 */

function readBoolEnv(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isMultiClientEnabled(): boolean {
  // Freeze lifted 2026-07-16. Multi-client is now on by default.
  // Set ENABLE_MULTI_CLIENT=false to revert to solo mode.
  const raw = process.env["ENABLE_MULTI_CLIENT"];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off");
}
