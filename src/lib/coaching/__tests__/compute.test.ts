/**
 * Phase 10 — D5 deterministic coaching prompt generator.
 *
 * Covers each of the five triggers (cumulative_spend_alert,
 * terms_mismatch, new_line_item_coaching, unusual_total,
 * early_payment_discount) — fires + does-not-fire — plus the PII
 * boundary assertions (no vendor name, no exact-baseline disclosure
 * beyond what's needed for the loss-framed impact figure).
 */
import { describe, it, expect } from "vitest";
import { computeCoachingPrompts } from "@/lib/coaching/compute";
import type { ValidationFinding } from "@/modules/validation";

// Typecheck-sweep — explicit field types let individual tests override
// with number | null and string | null without the literal-narrowing
// inference rejecting the override.
const baseInvoice: {
  total: number;
  currency: string;
  paymentTerms: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  discountPct: number | null;
  discountAmount: number | null;
} = {
  total: 1000,
  currency: "USD",
  paymentTerms: "Net 30",
  invoiceDate: "2026-06-01",
  dueDate: "2026-07-01",
  discountPct: null,
  discountAmount: null,
};

const baseVendor: {
  invoiceCount: number;
  spend30d: string;
  avgInvoiceAmount: string;
  defaultPaymentTerms: string | null;
} = {
  invoiceCount: 12,
  spend30d: "2000",
  avgInvoiceAmount: "500",
  defaultPaymentTerms: "Net 30",
};

function inputs(
  overrides: {
    invoice?: Partial<typeof baseInvoice>;
    vendorProfile?: Partial<typeof baseVendor> | null;
    findings?: ValidationFinding[];
  } = {},
) {
  return {
    invoice: { ...baseInvoice, ...overrides.invoice },
    vendorProfile:
      overrides.vendorProfile === null
        ? null
        : { ...baseVendor, ...overrides.vendorProfile },
    findings: overrides.findings ?? [],
  };
}

describe("computeCoachingPrompts", () => {
  it("returns an empty array when no triggers fire", () => {
    // Boring invoice: matches terms, total is unremarkable, no new
    // lines, projected spend stays within run-rate.
    //
    // Issue #3 fix: spend30d="100" + total=400 actually fires
    // cumulative_spend_alert (baseline=spend30=100 since >0, projected
    // 500 / 100 = 5× > 1.5× trigger). Use spend30d="2000" so projected
    // 2400 / 2000 = 1.2× and the alert correctly stays silent.
    const r = computeCoachingPrompts(
      inputs({ invoice: { total: 400 }, vendorProfile: { spend30d: "2000" } }),
    );
    expect(r).toEqual([]);
  });

  // ── cumulative_spend_alert ────────────────────────────────────────
  describe("cumulative_spend_alert", () => {
    it("fires when this invoice lifts 30-day spend > 1.5× the recent rate", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { total: 5000 },
          vendorProfile: { spend30d: "2000", avgInvoiceAmount: "500" },
        }),
      );
      const prompt = r.find((p) => p.code === "cumulative_spend_alert");
      expect(prompt).toBeDefined();
      expect(prompt!.severity).toBe("warning");
      expect(prompt!.dollarImpact).toBeGreaterThan(0);
    });

    it("does not fire when projected stays within 1.5× the baseline", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { total: 500 },
          vendorProfile: { spend30d: "2000", avgInvoiceAmount: "500" },
        }),
      );
      expect(r.find((p) => p.code === "cumulative_spend_alert")).toBeUndefined();
    });

    it("falls back to avgInvoiceAmount when spend30d is zero (dormant vendor)", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { total: 2000 },
          vendorProfile: { spend30d: "0", avgInvoiceAmount: "500" },
        }),
      );
      expect(r.find((p) => p.code === "cumulative_spend_alert")).toBeDefined();
    });

    it("does not fire when vendor has too little history", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { total: 5000 },
          vendorProfile: { invoiceCount: 2, spend30d: "100" },
        }),
      );
      expect(r.find((p) => p.code === "cumulative_spend_alert")).toBeUndefined();
    });

    it("does not fire when no vendor matched", () => {
      const r = computeCoachingPrompts(
        inputs({ invoice: { total: 5000 }, vendorProfile: null }),
      );
      expect(r.find((p) => p.code === "cumulative_spend_alert")).toBeUndefined();
    });
  });

  // ── terms_mismatch ─────────────────────────────────────────────────
  describe("terms_mismatch", () => {
    it("fires when invoice terms differ from on-file terms", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { paymentTerms: "Net 15" },
          vendorProfile: { defaultPaymentTerms: "Net 30" },
        }),
      );
      const prompt = r.find((p) => p.code === "terms_mismatch");
      expect(prompt).toBeDefined();
      expect(prompt!.severity).toBe("warning");
      expect(prompt!.message).toContain("accelerates");
    });

    it("describes the slow-down direction when terms lengthen", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { paymentTerms: "Net 60" },
          vendorProfile: { defaultPaymentTerms: "Net 30" },
        }),
      );
      const prompt = r.find((p) => p.code === "terms_mismatch")!;
      expect(prompt.message).toContain("slows");
      expect(prompt.message).toContain("30 days");
    });

    it("treats whitespace/case differences as equal (does not fire)", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { paymentTerms: " net  30 " },
          vendorProfile: { defaultPaymentTerms: "Net 30" },
        }),
      );
      expect(r.find((p) => p.code === "terms_mismatch")).toBeUndefined();
    });

    // PR17 I3 — "net30" (no space, common from OCR) used to fall
    // through the parse → fire as a generic mismatch against "Net 30".
    it("treats 'net30' and 'Net 30' as equal (no space variant)", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { paymentTerms: "net30" },
          vendorProfile: { defaultPaymentTerms: "Net 30" },
        }),
      );
      expect(r.find((p) => p.code === "terms_mismatch")).toBeUndefined();
    });

    it("parses 'net30' for the days-delta enrichment when mismatched", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { paymentTerms: "net45" },
          vendorProfile: { defaultPaymentTerms: "Net 30" },
        }),
      );
      const prompt = r.find((p) => p.code === "terms_mismatch")!;
      expect(prompt.message).toContain("15 days");
      expect(prompt.context).toMatchObject({
        invoiceDueDays: 45,
        onFileDueDays: 30,
      });
    });

    it("falls back to generic message when neither side parses as Net N", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { paymentTerms: "Due on receipt" },
          vendorProfile: { defaultPaymentTerms: "Pay-as-you-go" },
        }),
      );
      const prompt = r.find((p) => p.code === "terms_mismatch")!;
      expect(prompt.message).not.toContain("days");
      expect(prompt.dollarImpact).toBeNull();
    });

    it("does not fire when there is no on-file terms record", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { paymentTerms: "Net 15" },
          vendorProfile: { defaultPaymentTerms: null },
        }),
      );
      expect(r.find((p) => p.code === "terms_mismatch")).toBeUndefined();
    });

    // PR16 L1 — context no longer carries the literal contract strings;
    // numeric due-days are sufficient and aggregate-safe.
    it("context contains only the numeric due-days, not the literal terms strings", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { paymentTerms: "Net 15" },
          vendorProfile: { defaultPaymentTerms: "Net 30" },
        }),
      );
      const prompt = r.find((p) => p.code === "terms_mismatch")!;
      expect(prompt.context).not.toHaveProperty("invoiceTerms");
      expect(prompt.context).not.toHaveProperty("onFileTerms");
      expect(prompt.context).toMatchObject({
        invoiceDueDays: 15,
        onFileDueDays: 30,
      });
    });
  });

  // ── new_line_item_coaching ─────────────────────────────────────────
  describe("new_line_item_coaching", () => {
    it("repackages the validator's new_line_item finding as coaching", () => {
      const r = computeCoachingPrompts(
        inputs({
          findings: [
            {
              code: "new_line_item",
              severity: "warning",
              message: "Two line items not seen before from this vendor.",
              context: { lineNumbers: [1, 3] },
            },
          ],
        }),
      );
      const prompt = r.find((p) => p.code === "new_line_item_coaching")!;
      expect(prompt).toBeDefined();
      expect(prompt.message).toContain("2 line items");
    });

    it("singular phrasing when only one line is new", () => {
      const r = computeCoachingPrompts(
        inputs({
          findings: [
            {
              code: "new_line_item",
              severity: "warning",
              message: "x",
              context: { lineNumbers: [2] },
            },
          ],
        }),
      );
      const prompt = r.find((p) => p.code === "new_line_item_coaching")!;
      expect(prompt.message).toContain("1 line item");
      expect(prompt.message).not.toContain("1 line items");
    });

    it("does not fire when the validator did not flag any new line", () => {
      const r = computeCoachingPrompts(inputs({ findings: [] }));
      expect(r.find((p) => p.code === "new_line_item_coaching")).toBeUndefined();
    });
  });

  // ── unusual_total ─────────────────────────────────────────────────
  describe("unusual_total", () => {
    it("fires when total > 1.5× the vendor's typical amount", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { total: 1000 },
          vendorProfile: { avgInvoiceAmount: "500", invoiceCount: 8 },
        }),
      );
      const prompt = r.find((p) => p.code === "unusual_total");
      expect(prompt).toBeDefined();
      expect(prompt!.severity).toBe("info");
      expect(prompt!.message).toContain("typical invoice average");
    });

    it("does not fire when total is within the typical band", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { total: 550 },
          vendorProfile: { avgInvoiceAmount: "500", invoiceCount: 8 },
        }),
      );
      expect(r.find((p) => p.code === "unusual_total")).toBeUndefined();
    });

    it("does not fire on warming-up vendors (< 3 invoices)", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { total: 10000 },
          vendorProfile: { avgInvoiceAmount: "100", invoiceCount: 2 },
        }),
      );
      expect(r.find((p) => p.code === "unusual_total")).toBeUndefined();
    });

    // PR17 I1 — credit memos / large negative totals are exactly the
    // kind of anomaly that should fire (fraudulent reversal scenario).
    // Previously the strict `total > avg * mult` check silently let
    // them through.
    it("fires on large credit memos (negative totals) with isCredit=true", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { total: -5000 },
          vendorProfile: { avgInvoiceAmount: "500", invoiceCount: 8 },
        }),
      );
      const prompt = r.find((p) => p.code === "unusual_total");
      expect(prompt).toBeDefined();
      expect(prompt!.message).toContain("Credit/reversal");
      expect(prompt!.context).toMatchObject({ isCredit: true });
    });

    it("standard above-average invoices still mark isCredit=false", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: { total: 1000 },
          vendorProfile: { avgInvoiceAmount: "500", invoiceCount: 8 },
        }),
      );
      const prompt = r.find((p) => p.code === "unusual_total")!;
      expect(prompt.context).toMatchObject({ isCredit: false });
    });
  });

  // ── early_payment_discount ────────────────────────────────────────
  describe("early_payment_discount", () => {
    it("fires with loss-framed message when a discount % is provided", () => {
      const r = computeCoachingPrompts(
        inputs({
          invoice: {
            total: 1000,
            discountPct: 2,
            discountAmount: null,
          },
        }),
      );
      const prompt = r.find((p) => p.code === "early_payment_discount")!;
      expect(prompt).toBeDefined();
      expect(prompt.message).toContain("forgoes");
      // Loss framing: negative dollarImpact = money left on the table.
      expect(prompt.dollarImpact).toBeLessThan(0);
    });

    it("does not fire when no discountPct is set", () => {
      const r = computeCoachingPrompts(inputs());
      expect(r.find((p) => p.code === "early_payment_discount")).toBeUndefined();
    });

    it("does not fire when the discount value rounds below $0.50", () => {
      const r = computeCoachingPrompts(
        inputs({ invoice: { total: 10, discountPct: 1 } }),
      );
      expect(r.find((p) => p.code === "early_payment_discount")).toBeUndefined();
    });
  });

  // ── PII boundary ──────────────────────────────────────────────────
  describe("PII boundary", () => {
    it("no prompt message contains the vendor's name", () => {
      // We don't pass a vendor name in — but the safety property is
      // that the compute fn doesn't synthesise one or echo from any
      // hypothetical channel. Verify the messages use "this vendor"
      // generically.
      const r = computeCoachingPrompts(
        inputs({
          invoice: { total: 5000, paymentTerms: "Net 15" },
          vendorProfile: {
            spend30d: "2000",
            avgInvoiceAmount: "500",
            defaultPaymentTerms: "Net 30",
          },
          findings: [
            {
              code: "new_line_item",
              severity: "warning",
              message: "x",
              context: { lineNumbers: [1] },
            },
          ],
        }),
      );
      expect(r.length).toBeGreaterThan(0);
      for (const p of r) {
        expect(p.message).not.toMatch(/Acme|ABC Supplies|Vendor [A-Z]/);
        // generic ref or no vendor mention at all
        expect(p.message.toLowerCase()).toSatisfy(
          (msg: string) =>
            msg.includes("this vendor") ||
            !msg.includes("vendor") ||
            msg.includes("the vendor"),
        );
      }
    });
  });
});
