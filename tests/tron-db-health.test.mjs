import test from "node:test";
import assert from "node:assert/strict";
import { createDbHealthHandler } from "../api/tron/db-health.mjs";

function makeResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

const token = "db-health-test-token";
const env = { T2T_TRON_SYNC_TOKEN: token };

function mockDb({ missingColumn = false, fail = false } = {}) {
  return {
    calls: 0,
    async query(sql) {
      this.calls++;
      if (fail) throw new Error("private database details");

      if (sql.includes("SELECT 1")) return { rows: [{ ok: 1 }] };

      if (sql.includes("information_schema.columns")) {
        const names = [
          ["tron_usdt_deposits", "transaction_id"],
          ["tron_usdt_deposits", "event_index"],
          ["tron_usdt_deposits", "sender_address"],
          ["tron_usdt_deposits", "receiver_address"],
          ["tron_usdt_deposits", "token_contract"],
          ["tron_usdt_deposits", "amount_raw"],
          ["tron_usdt_deposits", "amount_usdt"],
          ["tron_usdt_deposits", "block_timestamp"],
          ["tron_usdt_deposits", "observation_status"],
          ["tron_usdt_deposits", "first_seen_at"],
          ["tron_usdt_deposits", "last_seen_at"],
          ["tron_usdt_deposits", "raw_event_json"],
          ["tron_usdt_sync_state", "receiver_address"],
          ["tron_usdt_sync_state", "last_completed_timestamp"],
          ["tron_usdt_sync_state", "updated_at"],
          ["tron_usdt_sync_state", "lease_token"],
          ["tron_usdt_sync_state", "lease_until"]
        ];
        if (missingColumn) names.pop();
        return {
          rows: names.map(([table_name, column_name]) => ({
            table_name, column_name
          }))
        };
      }

      return {
        rows: [
          { indexname: "tron_usdt_deposits_pkey" },
          { indexname: "idx_tron_usdt_deposits_receiver_time" }
        ]
      };
    }
  };
}

test("database health only allows GET", async () => {
  const res = makeResponse();
  await createDbHealthHandler({ env })({ method: "POST", headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
});

test("database health rejects unauthorized calls without database access", async () => {
  const db = mockDb();
  const res = makeResponse();
  await createDbHealthHandler({ env, poolProvider: () => db })(
    { method: "GET", headers: {} }, res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(db.calls, 0);
});

test("database health confirms connection and schema with read-only queries", async () => {
  const db = mockDb();
  const res = makeResponse();
  await createDbHealthHandler({ env, poolProvider: () => db })(
    { method: "GET", headers: { authorization: `Bearer ${token}` } }, res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "connected");
  assert.equal(res.body.schema_ready, true);
  assert.equal(res.body.transaction_sync_run, false);
  assert.equal(res.body.blockchain_scanned, false);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("database health reports missing schema without exposing column names", async () => {
  const db = mockDb({ missingColumn: true });
  const res = makeResponse();
  await createDbHealthHandler({ env, poolProvider: () => db })(
    { method: "GET", headers: { authorization: `Bearer ${token}` } }, res
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, "schema_incomplete");
  assert.equal(res.body.schema_ready, false);
  assert.equal(JSON.stringify(res.body).includes("transaction_id"), false);
});

test("database health hides connection errors", async () => {
  const res = makeResponse();
  await createDbHealthHandler({
    env,
    poolProvider: () => mockDb({ fail: true })
  })(
    { method: "GET", headers: { authorization: `Bearer ${token}` } }, res
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, "database_unavailable");
  assert.equal(JSON.stringify(res.body).includes("private database details"), false);
});
