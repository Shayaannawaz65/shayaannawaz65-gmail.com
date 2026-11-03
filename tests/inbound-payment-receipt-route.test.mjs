import test from "node:test";
import assert from "node:assert/strict";
import { createInboundPaymentReceiptHandler } from "../lib/routes/console/inbound-payment-receipt.mjs";
import { createInboundReceiptRuntime } from "../lib/cm/inbound-receipt-runtime.mjs";
import { createInMemoryPaymentReceiptRepository } from "../lib/receipts/payment-receipt-service.mjs";

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function createHandler(overrides = {}) {
  const calls = [];
  const handler = createInboundPaymentReceiptHandler({
    async parseRequest(req) {
      calls.push(["parse", req]);
      return { inboundRequest: req.body, operationKey: "operation-from-approved-adapter" };
    },
    async authenticateRequest(request) {
      calls.push(["authenticate", request]);
      return Object.freeze({ clientId: "authenticated-client" });
    },
    async resolvePaymentInstruction(parsed, principal) {
      calls.push(["instruction", parsed, principal]);
      return { paymentReference: "invoice-1", currency: "USD", expectedAmountUsdCents: "100" };
    },
    inboundReceiptAdapter: {
      async receive(input) {
        calls.push(["receive", input]);
        return { receipt: { cmRelease: { status: "RELEASE_REPORTED" }, loaderReceipt: { status: "AWAITING" } }, duplicate: false };
      }
    },
    async formatSuccess(result) { return { status: 202, body: { recorded: true, receipt: result.receipt } }; },
    async formatError() { return { status: 400, body: { error: "Rejected" } }; },
    ...overrides
  });
  return { handler, calls };
}

test("POST route resolves an authoritative instruction and returns only release-reported state", async () => {
  const { handler, calls } = createHandler();
  const req = { method: "POST", body: { opaque: true } };
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.receipt.cmRelease.status, "RELEASE_REPORTED");
  assert.equal(res.body.receipt.loaderReceipt.status, "AWAITING");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(calls[1][0], "authenticate");
  assert.equal(calls[2][0], "instruction");
  assert.equal(calls[2][2].clientId, "authenticated-client");
  assert.equal(calls[3][1].paymentInstruction.expectedAmountUsdCents, "100");
  assert.equal(calls[3][1].authenticatedPrincipal.clientId, "authenticated-client");
});

test("non-POST methods are rejected before parsing", async () => {
  const { handler, calls } = createHandler();
  const res = response();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
  assert.equal(calls.length, 0);
});

test("invalid parser output is rejected without resolving an instruction", async () => {
  const { handler, calls } = createHandler({ async parseRequest() { return null; } });
  const res = response();
  await handler({ method: "POST", body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("composed runtime authenticates before lookup and records reported state only", async () => {
  const dbCalls = [];
  const dbClient = {
    async query(sql) {
      dbCalls.push(sql);
      if (sql.includes("FROM public.t2t_s2s_client_keys")) {
        return { rowCount: 1, rows: [{ client_id: "skit-client-01", client_type: "POS", public_key_base64: "registered-key" }] };
      }
      if (sql.includes("FROM public.t2t_trusted_terminals")) {
        return { rowCount: 1, rows: [{ terminal_id: "terminal-01" }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const repository = createInMemoryPaymentReceiptRepository();
  const runtime = createInboundReceiptRuntime({
    repository,
    poolProvider: () => ({ connect: async () => dbClient }),
    parseRequest: async req => ({ inboundRequest: req, operationKey: "operation-001" }),
    parseAuthorization: async () => ({
      keyId: "skit-key-0001", terminalId: "terminal-01", timestampMs: 1_000_000,
      nonce: "b".repeat(32), signature: "signature"
    }),
    buildCanonicalPayload: async () => "contract-adapter canonical bytes",
    verifySignature: async () => true,
    maxClockSkewMs: 120_000,
    normalizeInboundRelease: async () => ({
      sourceReceiptReference: "skit-receipt-001", paymentReference: "invoice-001",
      reportedAmountUsdCents: "100", releaseEvidenceRef: "skit-release-001"
    }),
    resolvePaymentInstruction: async () => ({
      paymentReference: "invoice-001", currency: "USD", expectedAmountUsdCents: "100"
    }),
    verifyPaymentInstruction: async instruction => ({ ...instruction, verified: true }),
    verifyLoaderEvidence: async evidence => evidence,
    verifyBlockchainEvidence: async evidence => evidence,
    verifyExchangeEvidence: async evidence => evidence,
    verifyWalletSettlementEvidence: async evidence => evidence,
    formatSuccess: async result => ({ status: 202, body: result.receipt }),
    formatError: async () => ({ status: 400, body: { error: "Rejected" } }),
    now: () => 1_000_000
  });

  const res = response();
  await runtime.handler({ method: "POST", body: { opaque: "test-fixture" } }, res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.cmRelease.status, "RELEASE_REPORTED");
  assert.equal(res.body.loaderReceipt.status, "AWAITING");
  assert.equal(res.body.blockchain.status, "UNVERIFIED");
  assert.equal(res.body.walletSettlement.status, "NOT_STARTED");
  assert.ok(dbCalls.some(sql => sql.includes("INSERT INTO public.t2t_s2s_request_nonces")));
});
