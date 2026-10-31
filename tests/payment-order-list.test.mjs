import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../api/console/payment-order-list.mjs";

const token = "test-merchant-dashboard-token-1234567890";
const keyId = "merchant-key-test-001";

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function request({ method = "GET", authorization, query = {} } = {}) {
  return {
    method,
    headers: authorization ? { authorization } : {},
    query
  };
}

test("dashboard list is GET-only and disables caching", async () => {
  const res = response();
  await createHandler({ env: { T2T_MERCHANT_DASHBOARD_TOKEN: token, T2T_DASHBOARD_S2S_KEY_ID: keyId } })(
    request({ method: "POST" }), res
  );
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("missing dashboard token fails closed before database access", async () => {
  let queried = false;
  const res = response();
  await createHandler({
    env: {},
    poolProvider: () => ({ query: async () => { queried = true; } })
  })(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(queried, false);
});

test("unauthorized dashboard request never queries database", async () => {
  let queried = false;
  const res = response();
  await createHandler({
    env: { T2T_MERCHANT_DASHBOARD_TOKEN: token, T2T_DASHBOARD_S2S_KEY_ID: keyId },
    poolProvider: () => ({ query: async () => { queried = true; } })
  })(request({ authorization: "Bearer wrong-token" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(queried, false);
});

test("invalid pagination is rejected", async () => {
  const res = response();
  await createHandler({
    env: { T2T_MERCHANT_DASHBOARD_TOKEN: token, T2T_DASHBOARD_S2S_KEY_ID: keyId }
  })(request({
    authorization: `Bearer ${token}`,
    query: { limit: "101", offset: "-1" }
  }), res);
  assert.equal(res.statusCode, 400);
});

test("authorized listing returns payment fields scoped to its S2S key", async () => {
  let sql = "";
  let params;
  const res = response();

  const handler = createHandler({
    env: { T2T_MERCHANT_DASHBOARD_TOKEN: token, T2T_DASHBOARD_S2S_KEY_ID: keyId },
    poolProvider: () => ({
      query: async (statement, values) => {
        sql = statement;
        params = values;
        return {
          rows: [{
            order_id: "order-1",
            terminal_id: "terminal-1",
            invoice_reference: "INV-001",
            currency: "USD",
            amount_usd_cents: "1250",
            amount_usdt_raw: "12500000",
            receiver_address: "TExampleReceiver",
            status: "CONFIRMED",
            matched_transaction_id: "a".repeat(64),
            matched_event_index: 2,
            expires_at: "2026-10-30T10:00:00Z",
            confirmed_at: "2026-10-29T10:00:00Z",
            created_at: "2026-10-29T09:00:00Z",
            updated_at: "2026-10-29T10:00:00Z",
            payment_token_hash: "must-not-return",
            signing_key: "must-not-return"
          }]
        };
      }
    })
  });

  await handler(request({
    authorization: `Bearer ${token}`,
    query: { limit: "10", offset: "20" }
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(params, [keyId, 10, 20]);
  assert.match(sql, /LIMIT \\$2 OFFSET \\$3/);
  assert.match(sql, /WHERE o\\.s2s_key_id = \\$1/);
  assert.doesNotMatch(sql, /t2t_usdt_forwarding_jobs|payment_token_hash|signing_key/);
  assert.equal(res.body.records.length, 1);
  assert.equal(res.body.records[0].amountUsdCents, "1250");
  assert.equal(res.body.records[0].status, "CONFIRMED");
  assert.equal("payment_token_hash" in res.body.records[0], false);
  assert.equal("signing_key" in res.body.records[0], false);
  assert.equal("forwardingStatus" in res.body.records[0], false);
  assert.equal(res.body.safety.databaseWrites, false);
});

test("database failure returns generic error without referencing an uninitialized client", async () => {
  const res = response();
  await createHandler({
    env: { T2T_MERCHANT_DASHBOARD_TOKEN: token, T2T_DASHBOARD_S2S_KEY_ID: keyId },
    poolProvider: () => ({ query: async () => { throw new Error("private DB detail"); } })
  })(request({ authorization: `Bearer ${token}` }), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "Payment order list unavailable" });
  assert.doesNotMatch(JSON.stringify(res.body), /private DB detail/);
});
