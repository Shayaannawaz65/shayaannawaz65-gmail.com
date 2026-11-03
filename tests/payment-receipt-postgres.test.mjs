import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import {
  createPaymentReceiptService,
  createPostgresPaymentReceiptRepository
} from "../lib/receipts/payment-receipt-service.mjs";

const databaseUrl = process.env.T2T_RECEIPT_TEST_DATABASE_URL || "";
const parsedUrl = databaseUrl ? new URL(databaseUrl) : null;
const isolatedTestDatabase = parsedUrl?.pathname === "/t2t_receipt_test";
const require = createRequire(import.meta.url);

test("migration 020 and durable receipt repository operate transactionally on PostgreSQL", {
  skip: !isolatedTestDatabase ? "Set T2T_RECEIPT_TEST_DATABASE_URL to the isolated t2t_receipt_test database" : false
}, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.t2t_s2s_clients (client_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS public.t2t_s2s_client_keys (
        key_id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES public.t2t_s2s_clients(client_id)
      );
      CREATE TABLE IF NOT EXISTS public.t2t_trusted_terminals (terminal_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS public.t2t_s2s_key_terminals (
        key_id TEXT NOT NULL REFERENCES public.t2t_s2s_client_keys(key_id),
        terminal_id TEXT NOT NULL REFERENCES public.t2t_trusted_terminals(terminal_id),
        PRIMARY KEY (key_id, terminal_id)
      );
    `);
    const migration = await readFile(new URL("../migrations/020_payment_receipts.sql", import.meta.url), "utf8");
    await pool.query(migration);
    await pool.query(migration);

    const suffix = crypto.randomUUID();
    const principal = {
      clientId: `client-${suffix}`,
      keyId: `key-${suffix}`,
      terminalId: `terminal-${suffix}`
    };
    await pool.query("INSERT INTO public.t2t_s2s_clients(client_id) VALUES ($1)", [principal.clientId]);
    await pool.query("INSERT INTO public.t2t_s2s_client_keys(key_id, client_id) VALUES ($1,$2)", [principal.keyId, principal.clientId]);
    await pool.query("INSERT INTO public.t2t_trusted_terminals(terminal_id) VALUES ($1)", [principal.terminalId]);
    await pool.query("INSERT INTO public.t2t_s2s_key_terminals(key_id, terminal_id) VALUES ($1,$2)", [principal.keyId, principal.terminalId]);

    const repository = createPostgresPaymentReceiptRepository({ poolProvider: () => pool });
    const service = createPaymentReceiptService({
      repository,
      async verifyPaymentInstruction(instruction) { return instruction; },
      async authenticateCmRequest() { return principal; },
      async verifyLoaderEvidence(evidence) { return evidence; },
      async verifyBlockchainEvidence(evidence) { return evidence; },
      async verifyExchangeEvidence(evidence) { return evidence; },
      async verifyWalletSettlementEvidence(evidence) { return evidence; }
    });
    const paymentReference = `payment-${suffix}`;
    const exactExpectedUsdCents = "90071992547409931234567890123456789012345678901234567890";
    const release = {
      authorizationRequest: {},
      paymentInstruction: { verified: true, paymentReference, currency: "USD", expectedAmountUsdCents: exactExpectedUsdCents },
      normalizedRelease: {
        sourceReceiptReference: `source-${suffix}`,
        paymentReference,
        reportedAmountUsdCents: exactExpectedUsdCents,
        releaseEvidenceRef: `release-${suffix}`
      },
      operationKey: `release-${suffix}`
    };
    const first = await service.recordCmRelease(release);
    const duplicate = await service.recordCmRelease(release);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(first.receipt.cmRelease.status, "RELEASE_REPORTED");
    assert.equal(first.receipt.loaderReceipt.status, "AWAITING");
    await assert.rejects(service.recordCmRelease({
      ...release,
      paymentInstruction: { ...release.paymentInstruction, expectedAmountUsdCents: "9002" }
    }), /Idempotency conflict/);

    const receiptId = first.receipt.receiptId;
    const rollbackOperationKey = `loader:rollback-${suffix}`;
    await assert.rejects(repository.applyOnce({
      receiptId,
      operationKey: rollbackOperationKey,
      payloadHash: "a".repeat(64),
      mutate(receipt) {
        // Invalid persisted state violates migration 020's loader-state CHECK
        // after the repository has entered its transaction.
        receipt.loaderReceipt = { status: "RECEIVED", receivedAmountUsdCents: "9001", evidenceRef: null };
      }
    }));
    const afterRollback = await repository.get(receiptId);
    assert.equal(afterRollback.loaderReceipt.status, "AWAITING");
    assert.equal(afterRollback.loaderReceipt.receivedAmountUsdCents, null);

    const loaderEvidence = { verified: true, receivedAmountUsdCents: exactExpectedUsdCents, evidenceRef: `loader-${suffix}` };
    const loaderResult = await service.recordLoaderReceipt({ receiptId, operationKey: `rollback-${suffix}`, evidence: loaderEvidence });
    const loaderDuplicate = await service.recordLoaderReceipt({ receiptId, operationKey: `rollback-${suffix}`, evidence: loaderEvidence });
    assert.equal(loaderResult.duplicate, false);
    assert.equal(loaderDuplicate.duplicate, true);
    await assert.rejects(service.recordLoaderReceipt({
      receiptId, operationKey: `rollback-${suffix}`,
      evidence: { verified: true, receivedAmountUsdCents: "9000", evidenceRef: `different-loader-${suffix}` }
    }), /Idempotency conflict/);
    const txid = "bc".repeat(32);
    await service.verifyBlockchainReceipt({
      receiptId,
      operationKey: `chain-${suffix}`,
      evidence: { verified: true, transactionId: txid, eventIndex: 0, tokenAmountRaw: "9001000", evidenceRef: `chain-${suffix}` }
    });
    await service.recordExchangeConversion({ receiptId, operationKey: `exchange-${suffix}`, evidence: { verified: true, evidenceRef: `exchange-${suffix}` } });
    await service.recordWalletSettlement({ receiptId, operationKey: `settlement-${suffix}`, evidence: { verified: true, evidenceRef: `wallet-${suffix}` } });

    const durable = await repository.get(receiptId);
    assert.equal(durable.expectedAmountUsdCents, exactExpectedUsdCents);
    assert.equal(durable.loaderReceipt.receivedAmountUsdCents, exactExpectedUsdCents);
    assert.equal(durable.blockchain.status, "VERIFIED");
    assert.equal(durable.exchange.status, "CONVERTED");
    assert.equal(durable.walletSettlement.status, "SETTLED");

    const mismatchReference = `payment-mismatch-${suffix}`;
    const mismatchRelease = await service.recordCmRelease({
      ...release,
      operationKey: `release-mismatch-${suffix}`,
      paymentInstruction: { verified: true, paymentReference: mismatchReference, currency: "USD", expectedAmountUsdCents: "9001" },
      normalizedRelease: { ...release.normalizedRelease, sourceReceiptReference: `source-mismatch-${suffix}`, paymentReference: mismatchReference }
    });
    await service.recordLoaderReceipt({ receiptId: mismatchRelease.receipt.receiptId, operationKey: `loader-mismatch-${suffix}`, evidence: { verified: true, receivedAmountUsdCents: "9000", evidenceRef: `loader-mismatch-${suffix}` } });
    await assert.rejects(service.verifyBlockchainReceipt({
      receiptId: mismatchRelease.receipt.receiptId,
      operationKey: `chain-mismatch-${suffix}`,
      evidence: { verified: true, transactionId: "de".repeat(32), eventIndex: 0, tokenAmountRaw: "9000000", evidenceRef: `chain-mismatch-${suffix}` }
    }), /does not match the authoritative payment instruction/);
    const mismatch = await repository.get(mismatchRelease.receipt.receiptId);
    assert.equal(mismatch.loaderReceipt.receivedAmountUsdCents, "9000");
    assert.equal(mismatch.blockchain.status, "UNVERIFIED");
    assert.equal(mismatch.walletSettlement.status, "NOT_STARTED");
  } finally {
    await pool.end();
  }
});
