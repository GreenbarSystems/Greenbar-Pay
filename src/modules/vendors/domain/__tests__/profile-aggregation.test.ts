/**
 * aggregateVendorProfile previously had no direct unit test — it only
 * ran inline inside recompute-vendor-profile's DB transaction, which
 * needs a live Postgres to exercise at all. Extracting it as a pure
 * function (see profile-aggregation.ts) makes this coverage possible
 * without a database.
 */
import { describe, it, expect } from "vitest";
import { aggregateVendorProfile } from "@/modules/vendors/domain/profile-aggregation";

const NOW = new Date("2026-06-30T00:00:00Z");

describe("aggregateVendorProfile", () => {
  it("returns zeroed-out stats for an empty invoice set", () => {
    const r = aggregateVendorProfile([], NOW);
    expect(r).toEqual({
      invoiceCount: 0,
      lastInvoiceDate: null,
      spend30d: 0,
      spend90d: 0,
      avgInvoiceAmount: 0,
      termsDrift: false,
      modeTerms: null,
    });
  });

  it("sums totals, picks the latest date, and windows spend30d/90d", () => {
    const r = aggregateVendorProfile(
      [
        { total: "100.00", invoiceDate: "2026-06-25", paymentTerms: "net_30" }, // within 30d
        { total: "200.00", invoiceDate: "2026-05-15", paymentTerms: "net_30" }, // within 90d, not 30d
        { total: "300.00", invoiceDate: "2026-01-01", paymentTerms: "net_30" }, // outside 90d
      ],
      NOW,
    );
    expect(r.invoiceCount).toBe(3);
    expect(r.lastInvoiceDate).toBe("2026-06-25");
    expect(r.spend30d).toBe(100);
    expect(r.spend90d).toBe(300);
    expect(r.avgInvoiceAmount).toBeCloseTo(200, 5);
  });

  it("treats a null total as 0 without affecting other rows", () => {
    const r = aggregateVendorProfile(
      [
        { total: null, invoiceDate: "2026-06-20", paymentTerms: null },
        { total: "50.00", invoiceDate: "2026-06-10", paymentTerms: null },
      ],
      NOW,
    );
    expect(r.spend30d).toBe(50);
    expect(r.avgInvoiceAmount).toBe(25);
  });

  it("a null invoiceDate contributes to the count/avg but not to spend windows or lastInvoiceDate", () => {
    const r = aggregateVendorProfile(
      [
        { total: "1000.00", invoiceDate: null, paymentTerms: null },
        { total: "10.00", invoiceDate: "2026-06-01", paymentTerms: null },
      ],
      NOW,
    );
    expect(r.invoiceCount).toBe(2);
    expect(r.lastInvoiceDate).toBe("2026-06-01");
    expect(r.spend30d).toBe(10);
    expect(r.avgInvoiceAmount).toBe(505);
  });

  it("termsDrift is false below the profile-ready threshold even if terms differ", () => {
    const r = aggregateVendorProfile(
      [
        { total: "10", invoiceDate: "2026-06-01", paymentTerms: "net_60" },
        { total: "10", invoiceDate: "2026-05-01", paymentTerms: "net_30" },
      ],
      NOW,
    );
    expect(r.invoiceCount).toBe(2);
    expect(r.termsDrift).toBe(false);
  });

  it("termsDrift is true once invoiceCount >= 3 and the latest terms differ from the mode", () => {
    const r = aggregateVendorProfile(
      [
        { total: "10", invoiceDate: "2026-06-25", paymentTerms: "net_60" }, // latest, different
        { total: "10", invoiceDate: "2026-05-01", paymentTerms: "net_30" },
        { total: "10", invoiceDate: "2026-04-01", paymentTerms: "net_30" },
        { total: "10", invoiceDate: "2026-03-01", paymentTerms: "net_30" },
      ],
      NOW,
    );
    expect(r.modeTerms).toBe("net_30");
    expect(r.termsDrift).toBe(true);
  });

  it("termsDrift is false once the vendor has permanently moved to the new terms (mode catches up)", () => {
    const r = aggregateVendorProfile(
      [
        { total: "10", invoiceDate: "2026-06-25", paymentTerms: "net_60" },
        { total: "10", invoiceDate: "2026-05-01", paymentTerms: "net_60" },
        { total: "10", invoiceDate: "2026-04-01", paymentTerms: "net_60" },
        { total: "10", invoiceDate: "2026-03-01", paymentTerms: "net_30" },
      ],
      NOW,
    );
    expect(r.modeTerms).toBe("net_60");
    expect(r.termsDrift).toBe(false);
  });
});
