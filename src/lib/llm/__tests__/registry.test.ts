/**
 * Addendum §2.2 gate. The gateway must refuse to dispatch invoice
 * payloads to any model that isn't ZDR + US + non-retaining.
 */
import { describe, it, expect } from "vitest";
import {
  assertCompliantForInvoiceData,
  NonCompliantModelError,
  MODELS,
  DEFAULT_INVOICE_MODEL,
} from "@/lib/llm/registry";

describe("LLM compliance registry", () => {
  it("accepts the default invoice model", () => {
    const m = assertCompliantForInvoiceData(DEFAULT_INVOICE_MODEL);
    expect(m.id).toBe(DEFAULT_INVOICE_MODEL);
    expect(m.retentionDays).toBe(0);
    expect(m.allowsCustomerData).toBe(true);
    expect(m.region).toBe("us");
  });

  it("refuses an unknown model id", () => {
    expect(() =>
      assertCompliantForInvoiceData("anthropic:not-real"),
    ).toThrow(NonCompliantModelError);
  });

  it("refuses a model with retention > 0", () => {
    const fake = "anthropic:retains-data";
    MODELS[fake] = {
      id: fake,
      provider: "anthropic",
      apiModelId: "x",
      allowsCustomerData: true,
      retentionDays: 30,
      region: "us",
    };
    try {
      expect(() => assertCompliantForInvoiceData(fake)).toThrow(
        /retentionDays=30/,
      );
    } finally {
      delete MODELS[fake];
    }
  });

  it("refuses a model with allowsCustomerData=false", () => {
    const fake = "anthropic:blocked";
    MODELS[fake] = {
      id: fake,
      provider: "anthropic",
      apiModelId: "x",
      allowsCustomerData: false,
      retentionDays: 0,
      region: "us",
    };
    try {
      expect(() => assertCompliantForInvoiceData(fake)).toThrow(
        /allowsCustomerData=false/,
      );
    } finally {
      delete MODELS[fake];
    }
  });

  it("refuses a non-US model", () => {
    const fake = "anthropic:eu-only";
    MODELS[fake] = {
      id: fake,
      provider: "anthropic",
      apiModelId: "x",
      allowsCustomerData: true,
      retentionDays: 0,
      region: "eu",
    };
    try {
      expect(() => assertCompliantForInvoiceData(fake)).toThrow(/region=eu/);
    } finally {
      delete MODELS[fake];
    }
  });
});
