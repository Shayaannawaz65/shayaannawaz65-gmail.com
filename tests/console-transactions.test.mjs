import test from "node:test";
import assert from "node:assert/strict";
import { createTransactionsHandler } from "../api/console/transactions.mjs";

const token = "transactions-feed-test-token";
const env = { T2T_CONSOLE_FEED_TOKEN: token };

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request({ method = "GET", authorization, query = {} } = {}) {
  return {
    method,
    headers: authorization ? { authorization } : {},
    query
  };
}

function mockDb(rows = []) {
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    }
  };
}

const sample = {
  transaction_id: "a".repeat(64),
  event_index: 0,
  sender_address: "Tsender",
  receiver_address: "Treceiver",
  token_contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  amount_raw: "1234567",
  amount_usdt: "1.234567",
  block_timestamp: "2026-10-25T12:00:00.000Z",
  observation_status: "OBSERVED_CONFIRMED",
  first_seen_at: "2026-10-25T12:01:00.000Z",
  last_seen_at: "2026-10-25T12:02:00.000Z"
};

test("feed only allows GET and sets no-store", async () => {
  const res = response();
  await createTransactionsHandler({ env })(
    request({ method: "POST", authorization: `Bearer ${token}` }), res
  );
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("feed rejects unauthorized requests before database access", async () => {
  const db = mockDb();
  const res = response();
  await createTransactionsHandler({ env, poolProvider: () => db })(
    request(), res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(db.calls.length, 0);
});

test("feed returns observed records without approving deposits", async () => {
  const db = mockDb([sample]);
  const res = response();
  await createTransactionsHandler({ env, poolProvider: () => db })(
    request({
      authorization: `Bearer ${token}`,
      query: { limit: "25", offset: "5" }
    }), res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /WHERE observation_status = 'OBSERVED_CONFIRMED'/);
  assert.match(db.calls[0].sql, /ORDER BY block_timestamp DESC/);
  assert.deepEqual(db.calls[0].params, [25, 5]);
  assert.equal(res.body.records[0].amount_usdt, "1.234567");
  assert.equal(res.body.records[0].deposit_approved, false);
  assert.equal(res.body.records[0].settlement_authorized, false);
  assert.equal(res.body.safety.read_only, true);
  assert.equal(res.body.safety.blockchain_scanned, false);
  assert.equal(res.body.safety.transaction_sync_run, false);
  assert.equal(res.body.safety.deposits_auto_approved, false);
  assert.equal(res.body.safety.settlement_executed, false);
});

test("feed rejects invalid pagination without database access", async () => {
  for (const query of [
    { limit: "0" },
    { limit: "101" },
    { limit: "1; DROP TABLE tron_usdt_deposits" },
    { offset: "-1" }
  ]) {
    const db = mockDb();
    const res = response();
    await createTransactionsHandler({ env, poolProvider: () => db })(
      request({ authorization: `Bearer ${token}`, query }), res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(db.calls.length, 0);
  }
});

test("feed hides database errors", async () => {
  const res = response();
  await createTransactionsHandler({
    env,
    poolProvider: () => ({ query: async () => { throw new Error("private DB detail"); } })
  })(request({ authorization: `Bearer ${token}` }), res);

  assert.equal(res.statusCode, 503);
  assert.equal(JSON.stringify(res.body).includes("private DB detail"), false);
});

test("feed reports unavailable if authorization token is not configured", async () => {
  const db = mockDb();
  const res = response();
  await createTransactionsHandler({
    env: {},
    poolProvider: () => db
  })(request(), res);

  assert.equal(res.statusCode, 503);
  assert.equal(db.calls.length, 0);
});
