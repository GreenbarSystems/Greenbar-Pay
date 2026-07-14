/**
 * Public surface of the invoice-validation module. Presentation code
 * (routes), jobs, and other modules should import from here — never
 * reach into src/modules/validation/{domain,infrastructure}/* directly.
 */
export {
  validateInvoice,
  blockingPresent,
  duplicateKey,
  normalizeVendor,
  MATH_TOLERANCE,
  LOW_TEXT_LENGTH,
} from "./domain/engine";
export type {
  FindingSeverity,
  FindingCode,
  ValidationFinding,
  InvoiceForValidation,
  ValidationInputs,
} from "./domain/engine";

export { matchVendor } from "./domain/vendor-matching";
export type {
  VendorCandidate,
  MatchMethod,
  VendorMatchResult,
} from "./domain/vendor-matching";

export {
  scoreLine,
  isRateDrift,
  RATE_DRIFT_THRESHOLD,
  RATE_DRIFT_MIN_SAMPLES,
} from "./domain/line-scoring";
export type {
  LineConfidence,
  LinePricingStats,
  LineConfidenceResult,
  LineToScore,
} from "./domain/line-scoring";

export {
  scoreLineAgainstContract,
  CONTRACT_WARNING_OVERAGE,
  CONTRACT_BLOCKING_OVERAGE,
} from "./domain/contract-scoring";
export type {
  ContractLineMatch,
  ScoreLineAgainstContractInput,
  ContractScoreResult,
} from "./domain/contract-scoring";

export { detectRemitToDrift } from "./domain/remit-drift";
export type { RemitToInfo, RemitToDriftResult } from "./domain/remit-drift";

export {
  runInvoiceValidation,
} from "./application/use-cases/run-invoice-validation.usecase";
export type {
  RunInvoiceValidationDeps,
  RunInvoiceValidationArgs,
  RunInvoiceValidationResult,
} from "./application/use-cases/run-invoice-validation.usecase";

export {
  validateExtractedInvoiceJob,
} from "./application/use-cases/validate-extracted-invoice.usecase";
export type {
  ValidateExtractedInvoiceArgs,
} from "./application/use-cases/validate-extracted-invoice.usecase";

import { drizzleInvoiceRepository } from "./infrastructure/drizzle-invoice.repository";
import { drizzleVendorCandidateRepository } from "./infrastructure/drizzle-vendor-candidate.repository";
import { drizzleVendorContractRepository } from "./infrastructure/drizzle-vendor-contract.repository";
import { drizzleDocumentRepository } from "./infrastructure/drizzle-document.repository";
import { drizzleValidationResultsRepository } from "./infrastructure/drizzle-validation-results.repository";
import { drizzleVendorMatchWriteRepository } from "./infrastructure/drizzle-vendor-match-write.repository";
import { drizzleValidationAuditRepository } from "./infrastructure/drizzle-validation-audit.repository";

/**
 * Default, Drizzle-backed dependency bundle. Callers (the PATCH route,
 * the job) pass this to a use case; tests substitute in-memory fakes
 * that implement the same ports instead.
 */
export const validationModule = {
  invoiceRepository: drizzleInvoiceRepository,
  vendorCandidateRepository: drizzleVendorCandidateRepository,
  vendorContractRepository: drizzleVendorContractRepository,
  documentRepository: drizzleDocumentRepository,
  validationResultsRepository: drizzleValidationResultsRepository,
  vendorMatchWriteRepository: drizzleVendorMatchWriteRepository,
  auditRepository: drizzleValidationAuditRepository,
};
