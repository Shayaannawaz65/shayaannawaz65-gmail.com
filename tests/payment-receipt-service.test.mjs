import test from "node:test";
import assert from "node:assert/strict";
import {
  createInMemoryPaymentReceiptRepository,
  createPaymentReceiptService
} from "../lib/receipts/payment-receipt-service.mjs";

const txid = "a".repeat(64);
const principal = { clientId: "cm-client-001", keyId: "cm-key-0001", terminalId: "OFFLINE-201.3-001" };

function setup(overrides = {}) {
  const repo = createInMemoryPaymentReceiptRepository();
  const calls = { auth: 0 };
  const service = createPaymentReceiptService({
    repository: repo,
    async verifyPaymentInstruction(instruction) {
      if (instruction?.verified !== true) throw new Error("Payment instruction source did not verify instruction");
      return instruction;
    },
    async authenticateCmRequest(request) {
      calls.auth++;
      if (request?.valid !== true) throw new Error("S2S signature or replay validation failed");
      return principal;
    },
    async verifyLoaderEvidence(value) { return value; },
    async verifyBlockchainEvidence(value) { return value; },
    async verifyExchangeEvidence(value) { return value; },
    async verifyWalletSettlementEvidence(value) { return value; },
    now: () => "2026-11-01T00:00:00.000Z",
    ...overrides
  });
  return { repo, service, calls };
}

async function createRelease(service, extra = {}, authorizationRequest = { valid: true }) {
  return service.recordCmRelease({
    authorizationRequest,
    operationKey: "event-001",
    normalizedRelease: {
      sourceReceiptReference: "source-receipt-001",
      paymentReference: "payment-001",
      reportedAmountUsdCents: "12345",
      releaseEvidenceRef: "release-evidence-001",
      ...extra
    },
    paymentInstruction: { verified: true, paymentReference: "payment-001", currency: "USD", expectedAmountUsdCents: "12345" }
  });
}

test("requires authenticated S2S principal before recording a CM release", async () => {
  const { service } = setup();
  await assert.rejects(createRelease(service, {}, { valid: false }), /S2S signature or replay/);
});

test("does not trust a caller supplied receipt principal", async () => {
  const { service } = setup();
  await assert.rejects(service.recordCmRelease({
    authorizationRequest: { valid: true },
    authenticatedPrincipal: { clientId: "forged-client", keyId: "forged-key", terminalId: "forged-terminal" },
    normalizedRelease: {
      sourceReceiptReference: "forged-source",
      paymentReference: "payment-001",
      reportedAmountUsdCents: "12345",
      releaseEvidenceRef: "forged-evidence"
    },
    paymentInstruction: { verified: true, paymentReference: "payment-001", currency: "USD", expectedAmountUsdCents: "12345" },
    operationKey: "forged-operation"
  }), /Authenticated S2S client, key, and authorized terminal are required/);
});

test("CM release is idempotent and never marks loader receipt or funds settled", async () => {
  const { service } = setup();
  const first = await createRelease(service);
  const second = await createRelease(service);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.receipt.currency, "USD");
  assert.equal(first.receipt.expectedAmountUsdCents, "12345");
  assert.equal(first.receipt.cmRelease.reportedAmountUsdCents, "12345");
  assert.equal(first.receipt.loaderReceipt.status, "AWAITING");
  assert.equal(first.receipt.blockchain.status, "UNVERIFIED");
  assert.equal(first.receipt.walletSettlement.status, "NOT_STARTED");
});

test("rejects receipt-reference reuse with changed amount and invalid USD values", async () => {
  const { service } = setup();
  await createRelease(service);
  await assert.rejects(createRelease(service, { reportedAmountUsdCents: "12346" }), /Idempotency conflict/);
  await assert.rejects(createRelease(service, { reportedAmountUsdCents: "1.25" }), /positive canonical decimal/);
  await assert.rejects(createRelease(service, { paymentReference: "bad reference" }), /payment reference is invalid/);
  await assert.rejects(service.recordCmRelease({
    authorizationRequest: { valid: true }, operationKey: "bad-instruction",
    normalizedRelease: { sourceReceiptReference: "source-02", paymentReference: "payment-001", reportedAmountUsdCents: "12345", releaseEvidenceRef: "release-2" },
    paymentInstruction: { verified: false }
  }), /did not verify/);
});

test("rejects unverified loader receipt and does not accept invalid actual USD amounts", async () => {
  const { service } = setup();
  const { receipt } = await createRelease(service);
  await assert.rejects(service.recordLoaderReceipt({ receiptId: receipt.receiptId, operationKey: "loader-1", evidence: { verified: false } }), /not verified/);
  await assert.rejects(service.recordLoaderReceipt({ receiptId: receipt.receiptId, operationKey: "loader-2", evidence: { verified: true, receivedAmountUsdCents: "0", evidenceRef: "loader-proof" } }), /positive canonical decimal/);
});

test("requires loader evidence before blockchain proof and exchange conversion", async () => {
  const { service } = setup();
  const { receipt } = await createRelease(service);
  await assert.rejects(service.verifyBlockchainReceipt({
    receiptId: receipt.receiptId, operationKey: "chain-early",
    evidence: { verified: true, transactionId: txid, eventIndex: 0, tokenAmountRaw: "123", evidenceRef: "chain-proof" }
  }), /requires a recorded Loader receipt/);
  await assert.rejects(service.recordExchangeConversion({ receiptId: receipt.receiptId, operationKey: "exchange-early", evidence: { verified: true, evidenceRef: "exchange-proof" } }), /requires blockchain-verified funds/);
});

test("records a different actual USD amount without allowing it to settle against the instruction", async () => {
  const { service } = setup();
  const { receipt } = await createRelease(service);
  const loader = await service.recordLoaderReceipt({ receiptId: receipt.receiptId, operationKey: "loader-short", evidence: { verified: true, receivedAmountUsdCents: "12000", evidenceRef: "loader-proof-short" } });
  assert.equal(loader.receipt.expectedAmountUsdCents, "12345");
  assert.equal(loader.receipt.loaderReceipt.receivedAmountUsdCents, "12000");
  await assert.rejects(service.verifyBlockchainReceipt({
    receiptId: receipt.receiptId, operationKey: "chain-short",
    evidence: { verified: true, transactionId: txid, eventIndex: 0, tokenAmountRaw: "12000000", evidenceRef: "chain-proof-short" }
  }), /does not match the authoritative payment instruction/);
});

test("records separate verified loader, chain, conversion, and wallet settlement states idempotently", async () => {
  const { service } = setup();
  const { receipt: initial } = await createRelease(service);
  const loader = await service.recordLoaderReceipt({
    receiptId: initial.receiptId, operationKey: "loader-verified-1",
    evidence: { verified: true, receivedAmountUsdCents: "12345", evidenceRef: "loader-proof-1" }
  });
  assert.equal(loader.receipt.loaderReceipt.receivedAmountUsdCents, "12345");
  assert.equal(loader.receipt.expectedAmountUsdCents, "12345");
  const duplicateLoader = await service.recordLoaderReceipt({
    receiptId: initial.receiptId, operationKey: "loader-verified-1",
    evidence: { verified: true, receivedAmountUsdCents: "12345", evidenceRef: "loader-proof-1" }
  });
  assert.equal(duplicateLoader.duplicate, true);
  await assert.rejects(service.recordLoaderReceipt({
    receiptId: initial.receiptId, operationKey: "loader-verified-1",
    evidence: { verified: true, receivedAmountUsdCents: "12344", evidenceRef: "different-proof" }
  }), /Idempotency conflict/);

  const chain = await service.verifyBlockchainReceipt({
    receiptId: initial.receiptId, operationKey: "chain-verified-1",
    evidence: { verified: true, transactionId: txid, eventIndex: 2, tokenAmountRaw: "12000000", evidenceRef: "chain-proof-1" }
  });
  assert.equal(chain.receipt.blockchain.status, "VERIFIED");
  const converted = await service.recordExchangeConversion({ receiptId: initial.receiptId, operationKey: "exchange-1", evidence: { verified: true, evidenceRef: "exchange-proof-1" } });
  assert.equal(converted.receipt.exchange.status, "CONVERTED");
  await assert.rejects(service.recordWalletSettlement({ receiptId: initial.receiptId, operationKey: "settle-unverified", evidence: { verified: false } }), /not verified/);
  const settled = await service.recordWalletSettlement({ receiptId: initial.receiptId, operationKey: "settle-1", evidence: { verified: true, evidenceRef: "wallet-proof-1" } });
  assert.equal(settled.receipt.walletSettlement.status, "SETTLED");
});
