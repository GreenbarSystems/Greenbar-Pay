import { describe, it, expect } from "vitest";
import { detectRemitToDrift } from "../remit-drift";

describe("detectRemitToDrift", () => {
  it("no drift when there's no prior invoice to compare against", () => {
    const r = detectRemitToDrift(
      { remitToName: "Acme Corp", remitToAddress: "1 Main St" },
      null,
    );
    expect(r.changed).toBe(false);
  });

  it("no drift when the prior invoice never carried remit-to info", () => {
    const r = detectRemitToDrift(
      { remitToName: "Acme Corp", remitToAddress: "1 Main St" },
      { remitToName: null, remitToAddress: null },
    );
    expect(r.changed).toBe(false);
  });

  it("no drift when the current invoice has no remit-to info to check", () => {
    const r = detectRemitToDrift(
      { remitToName: null, remitToAddress: null },
      { remitToName: "Acme Corp", remitToAddress: "1 Main St" },
    );
    expect(r.changed).toBe(false);
  });

  it("no drift when remit-to matches after normalization (case/punctuation-insensitive)", () => {
    const r = detectRemitToDrift(
      { remitToName: "ACME Corp.", remitToAddress: "1 Main St., Suite 100" },
      { remitToName: "acme corp", remitToAddress: "1 main st suite 100" },
    );
    expect(r.changed).toBe(false);
  });

  it("flags a changed remit-to name", () => {
    const r = detectRemitToDrift(
      { remitToName: "Attacker LLC", remitToAddress: "1 Main St" },
      { remitToName: "Acme Corp", remitToAddress: "1 Main St" },
    );
    expect(r.changed).toBe(true);
    expect(r.priorRemitToName).toBe("Acme Corp");
  });

  it("flags a changed remit-to address even when the name matches", () => {
    const r = detectRemitToDrift(
      { remitToName: "Acme Corp", remitToAddress: "999 Attacker Ave" },
      { remitToName: "Acme Corp", remitToAddress: "1 Main St" },
    );
    expect(r.changed).toBe(true);
    expect(r.priorRemitToAddress).toBe("1 Main St");
  });

  it("does not flag when only the name is provided this time and it still matches", () => {
    const r = detectRemitToDrift(
      { remitToName: "Acme Corp", remitToAddress: null },
      { remitToName: "Acme Corp", remitToAddress: "1 Main St" },
    );
    expect(r.changed).toBe(false);
  });
});
