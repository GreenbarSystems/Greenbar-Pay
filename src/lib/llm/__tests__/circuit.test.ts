/**
 * §2.7 circuit breaker — opens when error rate ≥ 25% over a 5-minute
 * window AND we have at least MIN_SAMPLES observations. Half-opens
 * after 30 seconds to probe.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { checkCircuit, recordOutcome, __resetCircuit } from "@/lib/llm/circuit";

beforeEach(() => __resetCircuit());

describe("circuit breaker", () => {
  it("stays closed below threshold", () => {
    let t = 0;
    for (let i = 0; i < 7; i++) recordOutcome("anthropic", "ok", t++);
    recordOutcome("anthropic", "error", t++);
    expect(checkCircuit("anthropic", t).open).toBe(false);
  });

  it("opens at ≥ 25% error rate after MIN_SAMPLES", () => {
    let t = 0;
    // 6 ok, 2 err over 8 samples → 25%
    for (let i = 0; i < 6; i++) recordOutcome("anthropic", "ok", t++);
    for (let i = 0; i < 2; i++) recordOutcome("anthropic", "error", t++);
    expect(checkCircuit("anthropic", t).open).toBe(true);
  });

  it("half-opens after RESET_AFTER_MS", () => {
    let t = 0;
    for (let i = 0; i < 6; i++) recordOutcome("anthropic", "ok", t++);
    for (let i = 0; i < 4; i++) recordOutcome("anthropic", "error", t++);
    expect(checkCircuit("anthropic", t).open).toBe(true);
    // Wait beyond reset window — half-open.
    expect(checkCircuit("anthropic", t + 31_000).open).toBe(false);
  });

  it("is per-provider", () => {
    let t = 0;
    for (let i = 0; i < 8; i++) recordOutcome("openai", "error", t++);
    expect(checkCircuit("openai", t).open).toBe(true);
    expect(checkCircuit("anthropic", t).open).toBe(false);
  });
});
