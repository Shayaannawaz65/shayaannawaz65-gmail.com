import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../lib/routes/console/m1-settlement-admin.mjs";

const adminToken = "m1-admin-token-for-integration-tests-at-least-32";
const secret = "m1-test-secret-for-hmac-derived-identifiers-at-least-32";
const txHash = "a".repeat(64);
const order = {
  order_id: "00000000-0000-4000-8000-000000000011",
  invoice_reference: "INV-M1-001",
  currency: "USD",
  amount_usd_cents: "100",
  amount_usdt_raw: "1000000",
  exchange_rate_numerator: "2000000000000",
  exchange_rate_denominator: "2000000000000",
  exchange_rate_metadata: {
    method: "kraken_coingecko_midpoint_v1",
    quoteCurrency: "USD",
    baseCurrency: "USDT",
    referencePriceUsdPerUsdt: "1.000000000000"
  },
  transaction_id: txHash,
  event_index: 0,
  sender_address: "T123456789ABCDEFGHJKLMNPQRSTUVWXYZab",
  deposit_receiver_address: "T123456789ABCDEFGHJKLMNPQRSTUVWXYZab",
  token_contract: "TXYZ",
  amount_raw: "1000000",
  amount_usdt: "1",
  observation_status: "OBSERVED_CONFIRMED"
};

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function fakePool() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: null, rows: [] };
      if (String(sql).includes("FROM public.t2t_payment_orders o")) return { rowCount: 1, rows: [order] };
      if (String(sql).includes("INSERT INTO public.t2t_m1_settlement_outbox")) {
        return {
          rowCount: 1,
          rows: [{
            instruction_id: "00000000-0000-4000-8000-000000000022",
            transaction_id: params[0],
            idempotency_key: params[1],
            payment_order_reference: order.invoice_reference,
            beneficiary_code: "BARCLAYS",
            currency: "USD",
            amount_usd_decimal: "1.00",
            debtor_verification_ref: params[12],
            submission_status: params[15].length === 0 ? "READY" : "BLOCKED_MISSING_REQUIRED_FIELDS",
            missing_required_fields: params[15],
            http_response_status: null,
            sanitized_response: null,
            attempt_count: 0,
            last_attempt_at: null,
            last_error_code: null,
            created_at: new Date(0),
            updated_at: new Date(0)
          }]
        };
      }
      throw new Error("Unexpected SQL in M1 prepare test");
    },
    release() {}
  };
  return { calls, connect: async () => client };
}

test("prepares M1 payload from locked quote and verified Barclays beneficiary without floats", async () => {
  const pool = fakePool();
  const env = {
    T2T_S2S_AUTHORIZATION_ADMIN_TOKEN: adminToken,
    T2T_S2S_AUTHORIZATION_ADMIN_ID: "test-operator",
    M1_ID_DERIVATION_SECRET: secret,
    M1_DEBTOR_NAME: "Verified Sender Limited",
    M1_DEBTOR_ACCOUNT: "12345678",
    M1_DEBTOR_VERIFICATION_REF: "bank-record-verification-001",
    M1_EXCHANGE_RATE_DIRECTION: "USD_PER_USDT",
    M1_EXCHANGE_RATE_DECIMALS: "4",
    M1_CALLBACK_URL: "https://sender.example/api/m1/skit-callback",
    M1_CALLBACK_HMAC_SECRET: "callback-secret-for-tests-at-least-32-bytes",
    M1_CALLBACK_SIGNATURE_HEADER: "x-skit-signature",
    M1_CALLBACK_EVENT_ID_HEADER: "x-skit-event-id",
    M1_CALLBACK_SIGNATURE_ENCODING: "hex",
    M1_CALLBACK_STATUS_MAP: JSON.stringify({ ACCEPTED: "ACCEPTED", FINAL_SETTLED: "SETTLED" }),
    M1_TREASURY_WALLET: "T123456789ABCDEFGHJKLMNPQRSTUVWXYZab"
  };
  const handler = createHandler({ env, poolProvider: () => pool });
  const res = responseRecorder();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: { action: "prepare", orderId: order.order_id, beneficiary: "BARCLAYS" }
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.instruction.submissionStatus, "READY");
  const insert = pool.calls.find(call => call.sql.includes("INSERT INTO public.t2t_m1_settlement_outbox"));
  assert.ok(insert);
  const payload = JSON.parse(insert.params[13]);
  assert.equal(payload.amount, "1.00");
  assert.equal(payload.exchange_rate, "1.0000");
  assert.equal(payload.settlement_amount, "1.000000");
  assert.equal(payload.debtor_name, "Verified Sender Limited");
  assert.equal(payload.debtor_account, "12345678");
  assert.equal(payload.creditor_name, "SK Information Technologies Limited");
  assert.equal(payload.creditor_account, "15909338");
  assert.equal(payload.creditor_bank_name, "Barclays");
  assert.equal(payload.creditor_sort_code, "23-14-86");
  assert.equal(payload.creditor_lei, "636700DYHM5WFT8YJM7");
  assert.deepEqual(insert.params[15], []);
});

test("keeps M1 instruction blocked when verified debtor bank source is absent", async () => {
  const pool = fakePool();
  const env = {
    T2T_S2S_AUTHORIZATION_ADMIN_TOKEN: adminToken,
    T2T_S2S_AUTHORIZATION_ADMIN_ID: "test-operator",
    M1_ID_DERIVATION_SECRET: secret,
    M1_EXCHANGE_RATE_DIRECTION: "USD_PER_USDT",
    M1_EXCHANGE_RATE_DECIMALS: "4",
    M1_CALLBACK_URL: "https://sender.example/api/m1/skit-callback",
    M1_CALLBACK_HMAC_SECRET: "callback-secret-for-tests-at-least-32-bytes",
    M1_CALLBACK_SIGNATURE_HEADER: "x-skit-signature",
    M1_CALLBACK_EVENT_ID_HEADER: "x-skit-event-id",
    M1_CALLBACK_SIGNATURE_ENCODING: "hex",
    M1_CALLBACK_STATUS_MAP: JSON.stringify({ ACCEPTED: "ACCEPTED" }),
    M1_TREASURY_WALLET: "T123456789ABCDEFGHJKLMNPQRSTUVWXYZab"
  };
  const handler = createHandler({ env, poolProvider: () => pool });
  const res = responseRecorder();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: { action: "prepare", orderId: order.order_id, beneficiary: "BARCLAYS" }
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.instruction.submissionStatus, "BLOCKED_MISSING_REQUIRED_FIELDS");
  assert.ok(res.body.instruction.missingRequiredFields.includes("debtor_name_from_verified_sender_bank_record"));
  assert.ok(res.body.instruction.missingRequiredFields.includes("debtor_account_from_verified_sender_bank_record"));
});
