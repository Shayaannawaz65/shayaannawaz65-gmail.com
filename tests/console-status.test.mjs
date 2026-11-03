import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../lib/routes/console/status.mjs";

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function makeHandler({ receiver = "", syncRows = [], terminalRows = [{
  terminal_id: "OFFLINE-201.3-001",
  last_seen_at: new Date("2026-10-26T16:39:00Z"),
  status: "ACTIVE"
}] } = {}) {
  const pool = {
    async query(sql) {
      if (sql.includes("t2t_trusted_terminals")) {
        return { rowCount: terminalRows.length, rows: terminalRows };
      }
      if (sql.includes("tron_usdt_sync_state")) {
        return { rowCount: syncRows.length, rows: syncRows };
      }
      throw new Error("Unexpected query in test");
    }
  };
  return createHandler({
    poolProvider: () => pool,
    env: { T2T_TRON_RECEIVER_ADDRESS: receiver },
    now: () => Date.parse("2026-10-26T16:40:00Z")
  });
}

const VALID_RECEIVER = "TExAW9464LvbWmAsbcmNhvHQwawUn8rmN2";

test("status endpoint rejects non-GET", async () => {
  const res = response();
  await makeHandler()({ method: "POST" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
});

test("missing central receiver reports not_configured", async () => {
  const res = response();
  await makeHandler()({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.merchantBranch.status, "not_configured");
});

test("valid central T2T receiver reports configured without merchant identifiers", async () => {
  const res = response();
  await makeHandler({ receiver: VALID_RECEIVER })({ method: "GET" }, res);
  assert.equal(res.body.merchantBranch.status, "configured");
  assert.match(res.body.merchantBranch.detail, /no merchant ID mapping/i);
  assert.equal(JSON.stringify(res.body).includes("internal_mid"), false);
  assert.equal(JSON.stringify(res.body).includes("merchantId"), false);
});

test("malformed central receiver fails closed", async () => {
  const res = response();
  await makeHandler({ receiver: "not-a-tron-address" })({ method: "GET" }, res);
  assert.equal(res.body.merchantBranch.status, "not_configured");
});

test("terminal heartbeat state remains visible", async () => {
  const res = response();
  await makeHandler({ receiver: VALID_RECEIVER })({ method: "GET" }, res);
  assert.equal(res.body.terminal.status, "connected");
});

test("read-only dashboard includes the persisted TRON sync cursor", async () => {
  const lastCompleted = new Date("2026-10-26T15:00:00Z");
  const updated = new Date("2026-10-26T15:01:00Z");
  const res = response();
  await makeHandler({
    receiver: VALID_RECEIVER,
    syncRows: [{ last_completed_timestamp: lastCompleted, updated_at: updated }]
  })({ method: "GET" }, res);
  assert.equal(res.body.blockchainSync.status, "monitor_only");
  assert.equal(res.body.blockchainSync.cursor_status, "available");
  assert.equal(res.body.blockchainSync.last_completed_at, lastCompleted.toISOString());
  assert.equal(res.body.blockchainSync.last_updated_at, updated.toISOString());
  assert.equal(res.body.safety.transaction_sync_run, false);
});

test("dashboard remains monitor-only and never auto-approves deposits", async () => {
  const res = response();
  await makeHandler()({ method: "GET" }, res);
  assert.equal(res.body.blockchainSync.status, "monitor_only");
  assert.equal(res.body.safety.blockchain_scanned, false);
  assert.equal(res.body.safety.transaction_sync_run, false);
  assert.equal(res.body.safety.deposits_auto_approved, false);
});
