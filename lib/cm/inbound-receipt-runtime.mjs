import { createCmInboundReceiptAdapter } from "./inbound-receipt-adapter.mjs";
import { createInboundPaymentReceiptHandler } from "../routes/console/inbound-payment-receipt.mjs";
import { createS2sReceiptAuthenticator } from "../receipts/s2s-receipt-authenticator.mjs";
import {
  createPaymentReceiptService,
  createPostgresPaymentReceiptRepository,
  getPaymentReceiptPool
} from "../receipts/payment-receipt-service.mjs";

/**
 * Assemble the durable inbound receipt path. Protocol-specific parsing,
 * canonicalization, freshness window and response mapping remain mandatory
 * inputs; no SKIT wire contract is presumed by this runtime.
 */
export function createInboundReceiptRuntime({
  poolProvider,
  repository: repositoryOverride,
  parseRequest,
  parseAuthorization,
  buildCanonicalPayload,
  verifySignature,
  maxClockSkewMs,
  normalizeInboundRelease,
  resolvePaymentInstruction,
  verifyPaymentInstruction,
  verifyLoaderEvidence,
  verifyBlockchainEvidence,
  verifyExchangeEvidence,
  verifyWalletSettlementEvidence,
  formatSuccess,
  formatError,
  now
} = {}) {
  const effectivePoolProvider = poolProvider || getPaymentReceiptPool;
  const repository = repositoryOverride || createPostgresPaymentReceiptRepository({ poolProvider: effectivePoolProvider });
  const authenticate = createS2sReceiptAuthenticator({
    poolProvider: effectivePoolProvider,
    parseAuthorization,
    buildCanonicalPayload,
    verifySignature,
    maxClockSkewMs,
    now: now ? () => now() : undefined
  });
  const paymentReceiptService = createPaymentReceiptService({
    repository,
    verifyPaymentInstruction,
    authenticateCmRequest: authenticate,
    verifyLoaderEvidence,
    verifyBlockchainEvidence,
    verifyExchangeEvidence,
    verifyWalletSettlementEvidence,
    now: now ? () => new Date(now()).toISOString() : undefined
  });
  const inboundReceiptAdapter = createCmInboundReceiptAdapter({
    normalizeInboundRelease,
    paymentReceiptService
  });
  const handler = createInboundPaymentReceiptHandler({
    parseRequest,
    authenticateRequest: authenticate,
    resolvePaymentInstruction,
    inboundReceiptAdapter,
    formatSuccess,
    formatError
  });

  return Object.freeze({ handler, authenticate, paymentReceiptService, repository, inboundReceiptAdapter });
}
