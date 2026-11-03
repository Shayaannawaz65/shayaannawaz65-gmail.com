import crypto from "node:crypto";
import { createRequire } from "node:module";
import { isVerifiedS2sReceiptPrincipal } from "./s2s-receipt-authenticator.mjs";
const REFERENCE_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const USD_CENTS_RE = /^[1-9][0-9]{0,77}$/;
const RAW_AMOUNT_RE = /^[1-9][0-9]{0,77}$/;
const TXID_RE = /^[0-9a-f]{64}$/i;

function amount(value, label, pattern = USD_CENTS_RE) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${label} must be a positive canonical decimal string`);
  }
  return value;
}

function reference(value, label) {
  if (typeof value !== "string" || !REFERENCE_RE.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function receiptSnapshot(receipt) {
  return structuredClone(receipt);
}

function payloadHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function createInitialReceipt(input) {
  const paymentReference = reference(input.paymentReference, "Internal payment reference");
  const expectedAmountUsdCents = amount(input.expectedAmountUsdCents, "Authoritative expected USD amount");
  return {
    receiptId: input.receiptId,
    paymentReference,
    currency: "USD",
    expectedAmountUsdCents,
    cmRelease: { status: "NOT_REPORTED", reportedAmountUsdCents: null, evidenceRef: null },
    loaderReceipt: { status: "AWAITING", receivedAmountUsdCents: null, evidenceRef: null },
    blockchain: { status: "UNVERIFIED", transactionId: null, eventIndex: null, tokenAmountRaw: null, evidenceRef: null },
    exchange: { status: "NOT_STARTED", evidenceRef: null },
    walletSettlement: { status: "NOT_STARTED", evidenceRef: null },
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.createdAt ?? new Date().toISOString()
  };
}

/**
 * Local repository contract for exercising the domain service. Production
 * wiring must supply a durable transactional repository; this in-memory
 * implementation is deliberately for tests and local development only.
 */
export function createInMemoryPaymentReceiptRepository() {
  const byId = new Map();
  const bySourceReceipt = new Map();
  const operations = new Map();
  return Object.freeze({
    async createOrGet(input) {
      const priorOperationId = operations.get(input.operationKey);
      if (priorOperationId && (priorOperationId.receiptId !== bySourceReceipt.get(input.sourceReceiptReference) ||
          priorOperationId.payloadHash !== input.payloadHash)) {
        throw new Error("Idempotency conflict: operation key reused with different data");
      }
      const priorId = bySourceReceipt.get(input.sourceReceiptReference);
      if (priorId) {
        const prior = byId.get(priorId);
        if (prior.paymentReference !== input.paymentReference ||
            prior.expectedAmountUsdCents !== input.expectedAmountUsdCents ||
            prior.cmRelease.reportedAmountUsdCents !== input.reportedAmountUsdCents ||
            prior.cmRelease.evidenceRef !== input.releaseEvidenceRef) {
          throw new Error("Idempotency conflict: receipt reference was reused with different data");
        }
        operations.set(input.operationKey, { receiptId: priorId, payloadHash: input.payloadHash });
        return { receipt: receiptSnapshot(prior), duplicate: true };
      }
      const receipt = createInitialReceipt({ ...input, receiptId: crypto.randomUUID() });
      receipt.sourceReceiptReference = input.sourceReceiptReference;
      receipt.cmRelease = {
        status: "RELEASE_REPORTED",
        reportedAmountUsdCents: input.reportedAmountUsdCents,
        evidenceRef: input.releaseEvidenceRef
      };
      byId.set(receipt.receiptId, receipt);
      bySourceReceipt.set(input.sourceReceiptReference, receipt.receiptId);
      operations.set(input.operationKey, { receiptId: receipt.receiptId, payloadHash: input.payloadHash });
      return { receipt: receiptSnapshot(receipt), duplicate: false };
    },
    async get(receiptId) {
      const receipt = byId.get(receiptId);
      return receipt ? receiptSnapshot(receipt) : null;
    },
    async applyOnce({ receiptId, operationKey, payloadHash: operationPayloadHash, mutate }) {
      const prior = operations.get(operationKey);
      if (prior) {
        if (prior.receiptId !== receiptId || prior.payloadHash !== operationPayloadHash) throw new Error("Idempotency conflict: operation key reused with different data");
        return { receipt: receiptSnapshot(byId.get(receiptId)), duplicate: true };
      }
      const current = byId.get(receiptId);
      if (!current) throw new Error("Payment receipt not found");
      const next = receiptSnapshot(current);
      mutate(next);
      next.updatedAt = new Date().toISOString();
      byId.set(receiptId, next);
      operations.set(operationKey, { receiptId, payloadHash: operationPayloadHash });
      return { receipt: receiptSnapshot(next), duplicate: false };
    }
  });
}

let defaultPool;
let Pool;
function getPool() {
  if (!defaultPool) {
    if (!Pool) ({ Pool } = createRequire(import.meta.url)("pg"));
    const connectionString = process.env.T2T_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED ||
      process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString || connectionString.includes("[SENSITIVE]")) throw new Error("Database configuration missing");
    const parsed = new URL(connectionString);
    if (parsed.searchParams.get("sslmode") === "require") parsed.searchParams.set("sslmode", "verify-full");
    defaultPool = new Pool({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: true }, max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
  }
  return defaultPool;
}

export function getPaymentReceiptPool() {
  return getPool();
}

/** Durable PostgreSQL repository. State changes and idempotency keys commit together. */
export function createPostgresPaymentReceiptRepository({ poolProvider = getPool } = {}) {
  return Object.freeze({
    async createOrGet(input) {
      const client = await poolProvider().connect();
      try {
        await client.query("BEGIN");
        const state = createInitialReceipt({ ...input, receiptId: crypto.randomUUID() });
        state.sourceReceiptReference = input.sourceReceiptReference;
        state.cmRelease = { status: "RELEASE_REPORTED", reportedAmountUsdCents: input.reportedAmountUsdCents, evidenceRef: input.releaseEvidenceRef };
        const inserted = await client.query(
          `INSERT INTO public.t2t_payment_receipts
             (receipt_id, source_receipt_reference, payment_reference, currency,
              expected_amount_usd_cents, cm_reported_amount_usd_cents,
              cm_release_evidence_ref, cm_client_id, cm_key_id, cm_terminal_id,
              cm_release_status, loader_status, blockchain_status, exchange_status,
              wallet_settlement_status, state)
           VALUES ($1::uuid,$2,$3,'USD',$4::numeric,$5::numeric,$6,$7,$8,$9,
                   'RELEASE_REPORTED','AWAITING','UNVERIFIED','NOT_STARTED','NOT_STARTED',$10::jsonb)
           ON CONFLICT (source_receipt_reference) DO NOTHING
           RETURNING receipt_id, state`,
          [state.receiptId, input.sourceReceiptReference, input.paymentReference, input.expectedAmountUsdCents,
            input.reportedAmountUsdCents, input.releaseEvidenceRef, input.principal.clientId,
            input.principal.keyId, input.principal.terminalId,
            JSON.stringify(state)]
        );
        if (inserted.rowCount === 1) {
          await client.query(
            `INSERT INTO public.t2t_payment_receipt_operations (operation_key, receipt_id, operation_type, payload_hash)
             VALUES ($1,$2,'CM-RELEASE',$3)`, [input.operationKey, inserted.rows[0].receipt_id, input.payloadHash]
          );
          await client.query("COMMIT");
          return { receipt: { ...state, receiptId: inserted.rows[0].receipt_id }, duplicate: false };
        }
        const existing = await client.query(
          `SELECT receipt_id, payment_reference, expected_amount_usd_cents::text,
                  cm_reported_amount_usd_cents::text, cm_release_evidence_ref, state
             FROM public.t2t_payment_receipts WHERE source_receipt_reference = $1 FOR UPDATE`,
          [input.sourceReceiptReference]
        );
        if (existing.rowCount !== 1) throw new Error("Idempotent receipt lookup failed");
        const row = existing.rows[0];
        if (row.payment_reference !== input.paymentReference || row.expected_amount_usd_cents !== input.expectedAmountUsdCents ||
            row.cm_reported_amount_usd_cents !== input.reportedAmountUsdCents || row.cm_release_evidence_ref !== input.releaseEvidenceRef) {
          throw new Error("Idempotency conflict: receipt reference was reused with different data");
        }
        const priorOperation = await client.query(
          "SELECT receipt_id, payload_hash FROM public.t2t_payment_receipt_operations WHERE operation_key = $1",
          [input.operationKey]
        );
        if (priorOperation.rowCount && (priorOperation.rows[0].receipt_id !== row.receipt_id || priorOperation.rows[0].payload_hash !== input.payloadHash)) {
          throw new Error("Idempotency conflict: operation key reused with different data");
        }
        if (!priorOperation.rowCount) {
          await client.query(
            `INSERT INTO public.t2t_payment_receipt_operations (operation_key, receipt_id, operation_type, payload_hash)
             VALUES ($1,$2,'CM-RELEASE',$3)`, [input.operationKey, row.receipt_id, input.payloadHash]
          );
        }
        await client.query("COMMIT");
        return { receipt: row.state, duplicate: true };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        if (error?.code === "23505") throw new Error("Idempotency key was already used");
        throw error;
      } finally { client.release(); }
    },
    async get(receiptId) {
      const result = await poolProvider().query("SELECT state FROM public.t2t_payment_receipts WHERE receipt_id = $1", [receiptId]);
      return result.rowCount === 1 ? result.rows[0].state : null;
    },
    async applyOnce({ receiptId, operationKey, payloadHash: operationPayloadHash, mutate }) {
      const client = await poolProvider().connect();
      try {
        await client.query("BEGIN");
        const found = await client.query("SELECT state FROM public.t2t_payment_receipts WHERE receipt_id = $1 FOR UPDATE", [receiptId]);
        if (found.rowCount !== 1) throw new Error("Payment receipt not found");
        const prior = await client.query("SELECT receipt_id, payload_hash FROM public.t2t_payment_receipt_operations WHERE operation_key = $1", [operationKey]);
        if (prior.rowCount) {
          if (prior.rows[0].receipt_id !== receiptId || prior.rows[0].payload_hash !== operationPayloadHash) throw new Error("Idempotency conflict: operation key reused with different data");
          await client.query("COMMIT");
          return { receipt: found.rows[0].state, duplicate: true };
        }
        const next = receiptSnapshot(found.rows[0].state);
        mutate(next);
        next.updatedAt = new Date().toISOString();
        await client.query(
          `UPDATE public.t2t_payment_receipts
              SET state = $2::jsonb,
                  loader_status = $3,
                  loader_received_amount_usd_cents = $4::numeric,
                  loader_evidence_ref = $5,
                  blockchain_status = $6,
                  blockchain_transaction_id = $7,
                  blockchain_event_index = $8,
                  blockchain_token_amount_raw = $9::numeric,
                  blockchain_evidence_ref = $10,
                  exchange_status = $11,
                  exchange_evidence_ref = $12,
                  wallet_settlement_status = $13,
                  wallet_settlement_evidence_ref = $14,
                  updated_at = NOW()
            WHERE receipt_id = $1`,
          [receiptId, JSON.stringify(next), next.loaderReceipt.status,
            next.loaderReceipt.receivedAmountUsdCents, next.loaderReceipt.evidenceRef,
            next.blockchain.status, next.blockchain.transactionId, next.blockchain.eventIndex,
            next.blockchain.tokenAmountRaw, next.blockchain.evidenceRef,
            next.exchange.status, next.exchange.evidenceRef,
            next.walletSettlement.status, next.walletSettlement.evidenceRef]
        );
        await client.query("INSERT INTO public.t2t_payment_receipt_operations (operation_key, receipt_id, operation_type, payload_hash) VALUES ($1,$2,$3,$4)", [operationKey, receiptId, operationKey.split(":", 1)[0].toUpperCase(), operationPayloadHash]);
        await client.query("COMMIT");
        return { receipt: next, duplicate: false };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        if (error?.code === "23505") throw new Error("Idempotency key was already used");
        throw error;
      } finally { client.release(); }
    }
  });
}

function requireVerifier(verifier, label) {
  if (typeof verifier !== "function") throw new TypeError(`${label} verifier is required`);
}

/**
 * Internal receipt state service. CM wire parsing and CM's signature
 * canonicalization are intentionally injected and unspecified pending CM's
 * approved contract. The authenticator must enforce the existing P-256 S2S
 * client/key ownership, terminal authorization, timestamp window, signature,
 * and persistent nonce replay checks before it returns a principal.
 */
export function createPaymentReceiptService({
  repository,
  verifyPaymentInstruction,
  authenticateCmRequest,
  verifyLoaderEvidence,
  verifyBlockchainEvidence,
  verifyExchangeEvidence,
  verifyWalletSettlementEvidence,
  now = () => new Date().toISOString()
} = {}) {
  if (!repository || typeof repository.createOrGet !== "function" ||
      typeof repository.get !== "function" || typeof repository.applyOnce !== "function") {
    throw new TypeError("A receipt repository is required");
  }
  for (const [verifier, label] of [
    [verifyPaymentInstruction, "Approved payment instruction source"],
    [authenticateCmRequest, "CM S2S authenticator"],
    [verifyLoaderEvidence, "Payment Loader evidence"],
    [verifyBlockchainEvidence, "Blockchain evidence"],
    [verifyExchangeEvidence, "Exchange conversion evidence"],
    [verifyWalletSettlementEvidence, "Wallet settlement evidence"]
  ]) requireVerifier(verifier, label);

  return Object.freeze({
    async recordCmRelease({ authorizationRequest, authenticatedPrincipal, normalizedRelease, paymentInstruction, operationKey }) {
      const principal = authenticatedPrincipal === undefined
        ? await authenticateCmRequest(authorizationRequest)
        : isVerifiedS2sReceiptPrincipal(authenticatedPrincipal)
          ? authenticatedPrincipal
          : null;
      if (!principal || typeof principal.clientId !== "string" || !principal.clientId ||
          typeof principal.keyId !== "string" || !principal.keyId ||
          typeof principal.terminalId !== "string" || !principal.terminalId) {
        throw new Error("Authenticated S2S client, key, and authorized terminal are required");
      }
      if (!normalizedRelease || typeof normalizedRelease !== "object") {
        throw new TypeError("Normalized CM release is required");
      }
      const sourceReceiptReference = reference(normalizedRelease.sourceReceiptReference, "Source receipt reference");
      const paymentReference = reference(normalizedRelease.paymentReference, "Internal payment reference");
      const reportedAmountUsdCents = amount(normalizedRelease.reportedAmountUsdCents, "CM reported USD amount");
      const releaseEvidenceRef = reference(normalizedRelease.releaseEvidenceRef, "CM release evidence reference");
      const instruction = await verifyPaymentInstruction(paymentInstruction);
      if (!instruction || instruction.verified !== true || instruction.currency !== "USD" ||
          instruction.paymentReference !== paymentReference) {
        throw new Error("Approved USD payment instruction is invalid or does not match the payment reference");
      }
      const expectedAmountUsdCents = amount(instruction.expectedAmountUsdCents, "Authoritative expected USD amount");
      const operation = reference(operationKey, "Idempotency operation key");
      return repository.createOrGet({
        sourceReceiptReference,
        paymentReference,
        expectedAmountUsdCents,
        reportedAmountUsdCents,
        releaseEvidenceRef,
        operationKey: `cm-release:${operation}`,
        payloadHash: payloadHash([sourceReceiptReference, paymentReference, expectedAmountUsdCents, reportedAmountUsdCents, releaseEvidenceRef]),
        createdAt: now(),
        principal: { clientId: principal.clientId, keyId: principal.keyId, terminalId: principal.terminalId }
      });
    },

    async recordLoaderReceipt({ receiptId, operationKey, evidence }) {
      const verified = await verifyLoaderEvidence(evidence);
      if (!verified || verified.verified !== true) throw new Error("Payment Loader receipt evidence is not verified");
      const receivedAmountUsdCents = amount(verified.receivedAmountUsdCents, "Actual received USD amount");
      const evidenceRef = reference(verified.evidenceRef, "Loader evidence reference");
      return repository.applyOnce({ receiptId, operationKey: `loader:${reference(operationKey, "Idempotency operation key")}`, payloadHash: payloadHash([receivedAmountUsdCents, evidenceRef]), mutate: receipt => {
        if (receipt.loaderReceipt.status !== "AWAITING") throw new Error("Loader receipt transition is not allowed");
        receipt.loaderReceipt = { status: "RECEIVED", receivedAmountUsdCents, evidenceRef };
      }});
    },

    async verifyBlockchainReceipt({ receiptId, operationKey, evidence }) {
      const verified = await verifyBlockchainEvidence(evidence);
      if (!verified || verified.verified !== true || !TXID_RE.test(String(verified.transactionId ?? "")) ||
          !Number.isInteger(verified.eventIndex) || verified.eventIndex < 0) {
        throw new Error("Verifiable blockchain evidence is required");
      }
      const tokenAmountRaw = amount(verified.tokenAmountRaw, "Blockchain received amount", RAW_AMOUNT_RE);
      const evidenceRef = reference(verified.evidenceRef, "Blockchain evidence reference");
      return repository.applyOnce({ receiptId, operationKey: `blockchain:${reference(operationKey, "Idempotency operation key")}`, payloadHash: payloadHash([verified.transactionId.toLowerCase(), verified.eventIndex, tokenAmountRaw, evidenceRef]), mutate: receipt => {
        if (receipt.loaderReceipt.status !== "RECEIVED" || receipt.blockchain.status !== "UNVERIFIED") {
          throw new Error("Blockchain verification requires a recorded Loader receipt");
        }
        if (receipt.loaderReceipt.receivedAmountUsdCents !== receipt.expectedAmountUsdCents) {
          throw new Error("Actual USD receipt does not match the authoritative payment instruction amount");
        }
        receipt.blockchain = { status: "VERIFIED", transactionId: verified.transactionId.toLowerCase(), eventIndex: verified.eventIndex, tokenAmountRaw, evidenceRef };
      }});
    },

    async recordExchangeConversion({ receiptId, operationKey, evidence }) {
      const verified = await verifyExchangeEvidence(evidence);
      if (!verified || verified.verified !== true) throw new Error("Exchange conversion evidence is not verified");
      const evidenceRef = reference(verified.evidenceRef, "Exchange evidence reference");
      return repository.applyOnce({ receiptId, operationKey: `exchange:${reference(operationKey, "Idempotency operation key")}`, payloadHash: payloadHash([evidenceRef]), mutate: receipt => {
        if (receipt.blockchain.status !== "VERIFIED" || receipt.exchange.status !== "NOT_STARTED") {
          throw new Error("Exchange conversion requires blockchain-verified funds");
        }
        receipt.exchange = { status: "CONVERTED", evidenceRef };
      }});
    },

    async recordWalletSettlement({ receiptId, operationKey, evidence }) {
      const verified = await verifyWalletSettlementEvidence(evidence);
      if (!verified || verified.verified !== true) throw new Error("Wallet settlement evidence is not verified");
      const evidenceRef = reference(verified.evidenceRef, "Wallet settlement evidence reference");
      return repository.applyOnce({ receiptId, operationKey: `settlement:${reference(operationKey, "Idempotency operation key")}`, payloadHash: payloadHash([evidenceRef]), mutate: receipt => {
        if (receipt.exchange.status !== "CONVERTED" || receipt.walletSettlement.status !== "NOT_STARTED") {
          throw new Error("Wallet settlement requires verified exchange conversion");
        }
        receipt.walletSettlement = { status: "SETTLED", evidenceRef };
      }});
    },

    get(receiptId) { return repository.get(receiptId); }
  });
}
