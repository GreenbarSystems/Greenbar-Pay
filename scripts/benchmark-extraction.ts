/**
 * Extraction accuracy benchmark.
 *
 * Runs the production LLM extraction prompt against fixture invoices in
 * fixtures/benchmark/ and compares each extracted field to the known
 * ground truth. Outputs per-fixture scores and aggregate metrics.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/benchmark-extraction.ts
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/benchmark-extraction.ts --dry-run
 *
 * --dry-run skips the API call and uses pre-computed results from
 *   benchmark-results/latest.json for metric re-scoring.
 */

import fs from "node:fs";
import path from "node:path";
import { buildExtractionPrompt } from "../src/lib/llm/prompt";
import { InvoiceExtractionSchema, type InvoiceExtractionResult } from "../src/lib/llm/schema";

// ─── Configuration ───────────────────────────────────────────────────────────

const MODEL = process.env["ANTHROPIC_BENCHMARK_MODEL"] ?? "claude-sonnet-4-6";
const MAX_TOKENS = 4096;
const MONEY_TOLERANCE = 0.05;
const FIXTURES_DIR = path.join(process.cwd(), "fixtures", "benchmark");
const RESULTS_DIR = path.join(process.cwd(), "benchmark-results");

// ─── Types ───────────────────────────────────────────────────────────────────

interface GroundTruth extends InvoiceExtractionResult {
  _meta?: {
    fixture: string;
    description: string;
    notes?: string;
  };
}

interface FieldScore {
  field: string;
  expected: unknown;
  extracted: unknown;
  pass: boolean;
  note?: string;
}

interface FixtureResult {
  fixture: string;
  description: string;
  extractedConfidence: string;
  expectedConfidence: string;
  fieldScores: FieldScore[];
  passCount: number;
  totalFields: number;
  accuracy: number;
  lineItemCountMatch: boolean;
  lineItemAmountAccuracy: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  rawExtraction: InvoiceExtractionResult;
}

interface BenchmarkResults {
  runDate: string;
  model: string;
  promptVersion: string;
  fixtureCount: number;
  fixtureResults: FixtureResult[];
  aggregate: {
    overallFieldAccuracy: number;
    documentTypeAccuracy: number;
    vendorNameAccuracy: number;
    invoiceNumberAccuracy: number;
    invoiceDateAccuracy: number;
    dueDateAccuracy: number;
    totalAmountAccuracy: number;
    lineItemCountAccuracy: number;
    lineItemAmountAccuracy: number;
    currencyAccuracy: number;
    confidenceCalibration: {
      highLabelAccuracy: number;
      lowLabelCatchRate: number;
    };
    totalInputTokens: number;
    totalOutputTokens: number;
    avgLatencyMs: number;
  };
}

// ─── Comparison helpers ───────────────────────────────────────────────────────

function normStr(s: string | null | undefined): string {
  if (s == null) return "";
  return s.toLowerCase().replace(/[.,\-_#]/g, " ").replace(/\s+/g, " ").trim();
}

function vendorNameMatch(extracted: string | null, truth: string | null): boolean {
  if (truth == null) return extracted == null;
  if (extracted == null) return false;
  const e = normStr(extracted);
  const t = normStr(truth);
  // Accept if extracted contains all words from truth (>3 chars) or vice versa
  const truthWords = t.split(" ").filter((w) => w.length > 3);
  return truthWords.every((w) => e.includes(w));
}

function invoiceNumberMatch(extracted: string | null, truth: string | null): boolean {
  if (truth == null) return extracted == null;
  if (extracted == null) return false;
  const e = normStr(extracted).replace(/\s/g, "");
  const t = normStr(truth).replace(/\s/g, "");
  return e === t || e.includes(t) || t.includes(e);
}

function moneyMatch(
  extracted: number | null,
  truth: number | null,
  flexSign = false,
): boolean {
  if (truth == null) return extracted == null || extracted === 0;
  if (extracted == null) return false;
  const diff = flexSign
    ? Math.abs(Math.abs(extracted) - Math.abs(truth))
    : Math.abs(extracted - truth);
  return diff <= MONEY_TOLERANCE;
}

function paymentTermsMatch(extracted: string | null, truth: string | null): boolean {
  if (truth == null) return extracted == null;
  if (extracted == null) return false;
  const e = normStr(extracted);
  const t = normStr(truth);
  // "net 30" or "2 10 net 30" — check key tokens
  const tokens = t.split(" ").filter(Boolean);
  return tokens.filter((tok) => e.includes(tok)).length >= Math.ceil(tokens.length * 0.7);
}

function poNumberMatch(extracted: string | null, truth: string | null): boolean {
  if (truth == null) return extracted == null;
  if (extracted == null) return false;
  return normStr(extracted).replace(/\s/g, "") === normStr(truth).replace(/\s/g, "");
}

// ─── Field scoring ────────────────────────────────────────────────────────────

function scoreFields(
  extracted: InvoiceExtractionResult,
  truth: GroundTruth,
  fixtureName: string,
): FieldScore[] {
  const isCreditMemo = truth.documentType === "credit_memo";
  const isOcr = fixtureName.includes("scanned") || fixtureName.includes("ocr");

  const scores: FieldScore[] = [
    {
      field: "documentType",
      expected: truth.documentType,
      extracted: extracted.documentType,
      pass: extracted.documentType === truth.documentType,
    },
    {
      field: "vendorName",
      expected: truth.vendorName,
      extracted: extracted.vendorName,
      pass: vendorNameMatch(extracted.vendorName, truth.vendorName),
    },
    {
      field: "invoiceNumber",
      expected: truth.invoiceNumber,
      extracted: extracted.invoiceNumber,
      pass: invoiceNumberMatch(extracted.invoiceNumber, truth.invoiceNumber),
    },
    {
      field: "invoiceDate",
      expected: truth.invoiceDate,
      extracted: extracted.invoiceDate,
      pass: extracted.invoiceDate === truth.invoiceDate,
    },
    {
      field: "dueDate",
      expected: truth.dueDate,
      extracted: extracted.dueDate,
      // For credit memos, dueDate is optional (null ok)
      pass:
        truth.dueDate == null
          ? extracted.dueDate == null
          : extracted.dueDate === truth.dueDate,
    },
    {
      field: "currency",
      expected: truth.currency,
      extracted: extracted.currency,
      pass:
        truth.currency == null
          ? true
          : extracted.currency?.toUpperCase() === truth.currency.toUpperCase(),
    },
    {
      field: "paymentTerms",
      expected: truth.paymentTerms,
      extracted: extracted.paymentTerms,
      pass: paymentTermsMatch(extracted.paymentTerms, truth.paymentTerms),
    },
    {
      field: "purchaseOrderNumber",
      expected: truth.purchaseOrderNumber,
      extracted: extracted.purchaseOrderNumber,
      pass: poNumberMatch(extracted.purchaseOrderNumber, truth.purchaseOrderNumber),
    },
    {
      field: "total",
      expected: truth.total,
      extracted: extracted.total,
      // Credit memos: accept either sign
      pass: moneyMatch(extracted.total, truth.total, isCreditMemo),
    },
    {
      field: "subtotal",
      expected: truth.subtotal,
      extracted: extracted.subtotal,
      pass: moneyMatch(extracted.subtotal, truth.subtotal, false),
    },
    {
      field: "tax",
      expected: truth.tax,
      extracted: extracted.tax,
      pass: moneyMatch(extracted.tax, truth.tax, false),
    },
    {
      field: "discount",
      expected: truth.discount,
      extracted: extracted.discount,
      pass: moneyMatch(extracted.discount, truth.discount, false),
    },
    {
      field: "confidence",
      expected: truth.confidence,
      extracted: extracted.confidence,
      // For OCR fixture: accept low OR medium (either shows awareness of quality)
      pass: isOcr
        ? extracted.confidence === "low" || extracted.confidence === "medium"
        : extracted.confidence === truth.confidence,
      note: isOcr ? "OCR fixture — low or medium both accepted" : undefined,
    },
  ];

  return scores.map((s) => ({ ...s }));
}

function scoreLineItems(
  extracted: InvoiceExtractionResult,
  truth: GroundTruth,
): { countMatch: boolean; amountAccuracy: number } {
  const countMatch = extracted.lineItems.length === truth.lineItems.length;

  if (truth.lineItems.length === 0) {
    return { countMatch: true, amountAccuracy: 1 };
  }

  // For each truth line item, find the best-matching extracted line item by amount
  let matchedAmounts = 0;
  const usedExtracted = new Set<number>();

  for (const tItem of truth.lineItems) {
    if (tItem.amount == null) {
      matchedAmounts++;
      continue;
    }
    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < extracted.lineItems.length; i++) {
      if (usedExtracted.has(i)) continue;
      const eAmt = extracted.lineItems[i]?.amount ?? null;
      if (eAmt == null) continue;
      const diff = Math.abs(Math.abs(eAmt) - Math.abs(tItem.amount));
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestDiff <= MONEY_TOLERANCE) {
      matchedAmounts++;
      usedExtracted.add(bestIdx);
    }
  }

  return {
    countMatch,
    amountAccuracy: matchedAmounts / truth.lineItems.length,
  };
}

// ─── Anthropic API call ───────────────────────────────────────────────────────

async function callAnthropic(
  builtPrompt: ReturnType<typeof buildExtractionPrompt>,
): Promise<{ result: InvoiceExtractionResult; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: builtPrompt.systemPrompt,
    messages: [{ role: "user", content: builtPrompt.userText }],
    tools: [builtPrompt.tool],
    tool_choice: { type: "tool", name: "emit_invoice" },
  });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }

  const data = (await resp.json()) as {
    content: Array<{ type: string; name?: string; input?: unknown }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const toolBlock = data.content.find((b) => b.type === "tool_use" && b.name === "emit_invoice");
  if (!toolBlock || !toolBlock.input) {
    throw new Error("No emit_invoice tool call in response");
  }

  const parsed = InvoiceExtractionSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    throw new Error(`Schema validation failed: ${parsed.error.message}`);
  }

  return {
    result: parsed.data,
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const fixtureDirs = fs
    .readdirSync(FIXTURES_DIR)
    .filter((d) => fs.statSync(path.join(FIXTURES_DIR, d)).isDirectory())
    .sort();

  if (fixtureDirs.length === 0) {
    console.error("No fixture directories found in", FIXTURES_DIR);
    process.exit(1);
  }

  console.log(`\nGreenbar Pay — Extraction Accuracy Benchmark`);
  console.log(`Model: ${MODEL}  |  Fixtures: ${fixtureDirs.length}  |  Dry run: ${dryRun}\n`);

  const fixtureResults: FixtureResult[] = [];

  for (const dir of fixtureDirs) {
    const docPath = path.join(FIXTURES_DIR, dir, "document.txt");
    const gtPath = path.join(FIXTURES_DIR, dir, "ground-truth.json");

    if (!fs.existsSync(docPath) || !fs.existsSync(gtPath)) {
      console.warn(`  [SKIP] ${dir} — missing document.txt or ground-truth.json`);
      continue;
    }

    const documentText = fs.readFileSync(docPath, "utf-8");
    const truth: GroundTruth = JSON.parse(fs.readFileSync(gtPath, "utf-8"));
    const description = truth._meta?.description ?? dir;

    console.log(`  ▸ ${dir}`);
    if (!dryRun) process.stdout.write("    calling API...");

    const builtPrompt = buildExtractionPrompt({
      documentText,
      mimeType: "application/pdf",
      pageCount: 1,
    });

    let extracted: InvoiceExtractionResult;
    let inputTokens = 0;
    let outputTokens = 0;
    let latencyMs = 0;

    if (dryRun) {
      // Dry run: load pre-saved result if available, otherwise skip
      const savedPath = path.join(RESULTS_DIR, "latest.json");
      if (fs.existsSync(savedPath)) {
        const saved: BenchmarkResults = JSON.parse(fs.readFileSync(savedPath, "utf-8"));
        const savedFixture = saved.fixtureResults.find((f) => f.fixture === dir);
        if (savedFixture) {
          extracted = savedFixture.rawExtraction;
          inputTokens = savedFixture.inputTokens;
          outputTokens = savedFixture.outputTokens;
          latencyMs = savedFixture.latencyMs;
        } else {
          console.log("    (no saved result — skipping)");
          continue;
        }
      } else {
        console.log("    (no latest.json — run without --dry-run first)");
        continue;
      }
    } else {
      const t0 = Date.now();
      const apiResult = await callAnthropic(builtPrompt);
      latencyMs = Date.now() - t0;
      extracted = apiResult.result;
      inputTokens = apiResult.inputTokens;
      outputTokens = apiResult.outputTokens;
      process.stdout.write(` done (${latencyMs}ms)\n`);
    }

    const fieldScores = scoreFields(extracted, truth, dir);
    const { countMatch, amountAccuracy } = scoreLineItems(extracted, truth);

    const passingFields = fieldScores.filter((s) => s.pass).length;
    const accuracy = passingFields / fieldScores.length;

    const failures = fieldScores.filter((s) => !s.pass);
    if (failures.length > 0) {
      for (const f of failures) {
        console.log(
          `    ✗ ${f.field}: expected ${JSON.stringify(f.expected)} → got ${JSON.stringify(f.extracted)}`,
        );
      }
    }

    const lineItemEmoji = countMatch && amountAccuracy === 1 ? "✓" : "⚠";
    console.log(
      `    ${lineItemEmoji} lines: count ${extracted.lineItems.length}/${truth.lineItems.length}, amount accuracy ${Math.round(amountAccuracy * 100)}%`,
    );
    console.log(
      `    field accuracy: ${Math.round(accuracy * 100)}% (${passingFields}/${fieldScores.length})`,
    );
    console.log(
      `    tokens: ${inputTokens} in / ${outputTokens} out  |  confidence: ${extracted.confidence}\n`,
    );

    fixtureResults.push({
      fixture: dir,
      description,
      extractedConfidence: extracted.confidence,
      expectedConfidence: truth.confidence,
      fieldScores,
      passCount: passingFields,
      totalFields: fieldScores.length,
      accuracy,
      lineItemCountMatch: countMatch,
      lineItemAmountAccuracy: amountAccuracy,
      latencyMs,
      inputTokens,
      outputTokens,
      rawExtraction: extracted,
    });
  }

  // ─── Aggregate metrics ───────────────────────────────────────────────────

  const byField = (fieldName: string) => {
    const relevant = fixtureResults.filter((r) =>
      r.fieldScores.some((s) => s.field === fieldName),
    );
    if (relevant.length === 0) return 1;
    const passing = relevant.filter((r) => r.fieldScores.find((s) => s.field === fieldName)?.pass)
      .length;
    return passing / relevant.length;
  };

  const overall =
    fixtureResults.reduce((sum, r) => sum + r.accuracy, 0) / fixtureResults.length;

  const lineItemCountAcc =
    fixtureResults.filter((r) => r.lineItemCountMatch).length / fixtureResults.length;
  const lineItemAmtAcc =
    fixtureResults.reduce((sum, r) => sum + r.lineItemAmountAccuracy, 0) / fixtureResults.length;

  // Confidence calibration
  const highLabelResults = fixtureResults.filter((r) => r.extractedConfidence === "high");
  const highLabelAccuracy =
    highLabelResults.length > 0
      ? highLabelResults.reduce((sum, r) => sum + r.accuracy, 0) / highLabelResults.length
      : 0;

  const expectedLowResults = fixtureResults.filter((r) => r.expectedConfidence === "low");
  const lowLabelCatchRate =
    expectedLowResults.length > 0
      ? expectedLowResults.filter(
          (r) => r.extractedConfidence === "low" || r.extractedConfidence === "medium",
        ).length / expectedLowResults.length
      : 1;

  const aggregate = {
    overallFieldAccuracy: overall,
    documentTypeAccuracy: byField("documentType"),
    vendorNameAccuracy: byField("vendorName"),
    invoiceNumberAccuracy: byField("invoiceNumber"),
    invoiceDateAccuracy: byField("invoiceDate"),
    dueDateAccuracy: byField("dueDate"),
    totalAmountAccuracy: byField("total"),
    lineItemCountAccuracy: lineItemCountAcc,
    lineItemAmountAccuracy: lineItemAmtAcc,
    currencyAccuracy: byField("currency"),
    confidenceCalibration: {
      highLabelAccuracy,
      lowLabelCatchRate,
    },
    totalInputTokens: fixtureResults.reduce((sum, r) => sum + r.inputTokens, 0),
    totalOutputTokens: fixtureResults.reduce((sum, r) => sum + r.outputTokens, 0),
    avgLatencyMs:
      fixtureResults.reduce((sum, r) => sum + r.latencyMs, 0) / fixtureResults.length,
  };

  console.log("─────────────────────────────────────────────────────");
  console.log("AGGREGATE RESULTS");
  console.log(`  Overall field accuracy:    ${pct(aggregate.overallFieldAccuracy)}`);
  console.log(`  Document type:             ${pct(aggregate.documentTypeAccuracy)}`);
  console.log(`  Vendor name:               ${pct(aggregate.vendorNameAccuracy)}`);
  console.log(`  Invoice number:            ${pct(aggregate.invoiceNumberAccuracy)}`);
  console.log(`  Invoice date:              ${pct(aggregate.invoiceDateAccuracy)}`);
  console.log(`  Due date:                  ${pct(aggregate.dueDateAccuracy)}`);
  console.log(`  Total amount:              ${pct(aggregate.totalAmountAccuracy)}`);
  console.log(`  Currency:                  ${pct(aggregate.currencyAccuracy)}`);
  console.log(`  Line item count:           ${pct(aggregate.lineItemCountAccuracy)}`);
  console.log(`  Line item amounts:         ${pct(aggregate.lineItemAmountAccuracy)}`);
  console.log(`  High-conf label accuracy:  ${pct(aggregate.confidenceCalibration.highLabelAccuracy)}`);
  console.log(`  Low-quality catch rate:    ${pct(aggregate.confidenceCalibration.lowLabelCatchRate)}`);
  console.log(`  Avg latency:               ${Math.round(aggregate.avgLatencyMs)}ms`);
  console.log("─────────────────────────────────────────────────────\n");

  // ─── Write results ───────────────────────────────────────────────────────

  const { PROMPT_VERSION } = await import("../src/lib/llm/prompt");

  const results: BenchmarkResults = {
    runDate: new Date().toISOString().slice(0, 10),
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    fixtureCount: fixtureResults.length,
    fixtureResults,
    aggregate,
  };

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const latestPath = path.join(RESULTS_DIR, "latest.json");
  const datedPath = path.join(RESULTS_DIR, `${results.runDate}.json`);

  fs.writeFileSync(latestPath, JSON.stringify(results, null, 2));
  fs.writeFileSync(datedPath, JSON.stringify(results, null, 2));

  console.log(`Results written to benchmark-results/${results.runDate}.json\n`);
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
