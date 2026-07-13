/**
 * Regression coverage for "F1 — password-less Credentials provider =
 * full auth bypass" (2026-07-12 security audit). The original bug: the
 * Credentials provider accepted only an email, with no secret/password
 * check, and was registered unconditionally regardless of environment.
 *
 * These tests pin down the fixed behavior:
 *   1. The provider is disabled whenever NODE_ENV === "production",
 *      no matter what DEV_LOGIN_SECRET is set to.
 *   2. The provider is disabled whenever no secret is configured.
 *   3. A request without a matching secret is rejected even outside
 *      production.
 *   4. Only a correct, non-empty secret succeeds outside production.
 *   5. Boot-time assertion throws if production + a secret are ever
 *      combined, so a misconfigured deploy fails loudly.
 */
import { describe, it, expect } from "vitest";
import {
  assertNoDevAuthInProduction,
  isDevAuthEnabled,
  constantTimeEquals,
  devLoginSecretIsValid,
} from "@/lib/auth-dev-login";

describe("dev-login production guard (F1 fix)", () => {
  it("is disabled in production even with a secret configured", () => {
    expect(
      isDevAuthEnabled({
        NODE_ENV: "production",
        DEV_LOGIN_SECRET: "correct-secret",
      }),
    ).toBe(false);
  });

  it("is disabled outside production when no secret is configured", () => {
    expect(isDevAuthEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(
      isDevAuthEnabled({ NODE_ENV: "development", DEV_LOGIN_SECRET: "" }),
    ).toBe(false);
  });

  it("is enabled outside production with a non-empty secret", () => {
    expect(
      isDevAuthEnabled({
        NODE_ENV: "development",
        DEV_LOGIN_SECRET: "correct-secret",
      }),
    ).toBe(true);
    expect(
      isDevAuthEnabled({
        NODE_ENV: "test",
        DEV_LOGIN_SECRET: "correct-secret",
      }),
    ).toBe(true);
  });

  it("throws at boot if production + a secret are ever combined", () => {
    expect(() =>
      assertNoDevAuthInProduction({
        NODE_ENV: "production",
        DEV_LOGIN_SECRET: "should-never-be-set",
      }),
    ).toThrow(/must not be set in production/);
  });

  it("does not throw at boot in production with no secret set", () => {
    expect(() =>
      assertNoDevAuthInProduction({ NODE_ENV: "production" }),
    ).not.toThrow();
  });

  it("does not throw at boot outside production with a secret set", () => {
    expect(() =>
      assertNoDevAuthInProduction({
        NODE_ENV: "development",
        DEV_LOGIN_SECRET: "correct-secret",
      }),
    ).not.toThrow();
  });
});

describe("constantTimeEquals", () => {
  it("matches identical non-empty strings", () => {
    expect(constantTimeEquals("abc123", "abc123")).toBe(true);
  });

  it("rejects differing strings", () => {
    expect(constantTimeEquals("abc123", "abc124")).toBe(false);
  });

  it("rejects differing lengths", () => {
    expect(constantTimeEquals("abc", "abcdef")).toBe(false);
  });

  it("rejects when either side is empty (regression: no email-only bypass)", () => {
    expect(constantTimeEquals("", "")).toBe(false);
    expect(constantTimeEquals("", "abc")).toBe(false);
    expect(constantTimeEquals("abc", "")).toBe(false);
  });
});

describe("devLoginSecretIsValid — the exact check authorize() relies on", () => {
  const env = { NODE_ENV: "development", DEV_LOGIN_SECRET: "correct-secret" };

  it("rejects a missing secret (this was the original F1 bypass)", () => {
    expect(devLoginSecretIsValid(undefined, env)).toBe(false);
    expect(devLoginSecretIsValid("", env)).toBe(false);
  });

  it("rejects an incorrect secret", () => {
    expect(devLoginSecretIsValid("wrong", env)).toBe(false);
  });

  it("accepts the correct secret outside production", () => {
    expect(devLoginSecretIsValid("correct-secret", env)).toBe(true);
  });

  it("rejects the correct secret when NODE_ENV is production", () => {
    expect(
      devLoginSecretIsValid("correct-secret", {
        ...env,
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });

  it("rejects any secret when none is configured in env", () => {
    expect(
      devLoginSecretIsValid("anything", { NODE_ENV: "development" }),
    ).toBe(false);
  });
});
