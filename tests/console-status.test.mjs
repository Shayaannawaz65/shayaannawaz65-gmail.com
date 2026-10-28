import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../api/console/status.mjs";

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

function makeHandler({ mappingRows = [], mappingError = null } = {}) {
  const pool = {
    async query(sql) {
      if (sql.includes("t2t_terminal_merchant_mapping")) {
        if (mappingError) throw mappingError;
        return { rowCount: mappingRows.length, rows: mappingRows };
      }
      if (sql.includes("t2t_trusted_terminals")) {
        return {
          rowCount: 1,
          rows: [{
            terminal_id: "OFFLINE-201.3-001",
            last_seen_at: new Date("2026-10-26T16:00:00Z"),
            status: "ACTIVE"
          }]
        };
      }
      throw new Error("Unexpected query in test");
    }
  };

  return createHandler({
    poolProvider: () => pool,
    env: {},
    now: () => Date.parse("2026-10-26T16:40:00Z")
  });
}

const mapping = (mapping_status, terminal_status = "ACTIVE") => ({
  internal_mid: "INTERNAL-MID-001",
  receiver_id: "RECEIVER-001",
  receiver_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  mapping_status,
  terminal_status
});

test("status endpoint rejects non-GET", async () => {
  const res = response();
  await makeHandler()({ method: "POST" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
});

test("missing mapping reports not_configured", async () => {
  const res = response();
  await makeHandler()({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.merchantBranch.status, "not_configured");
});

test("active mapping and active terminal report configured", async () => {
  const res = response();
  await makeHandler({ mappingRows: [mapping("ACTIVE")] })({ method: "GET" }, res);
  assert.equal(res.body.merchantBranch.status, "configured");
  assert.equal("internal_mid" in res.body.merchantBranch, false);
  assert.equal("receiver_id" in res.body.merchantBranch, false);
  assert.equal("receiver_address" in res.body.merchantBranch, false);
});

test("inactive mapping is not configured as active", async () => {
  const res = response();
  await makeHandler({ mappingRows: [mapping("INACTIVE")] })({ method: "GET" }, res);
  assert.equal(res.body.merchantBranch.status, "inactive");
});

test("revoked mapping reports revoked", async () => {
  const res = response();
  await makeHandler({ mappingRows: [mapping("REVOKED")] })({ method: "GET" }, res);
  assert.equal(res.body.merchantBranch.status, "revoked");
});

test("active mapping with revoked terminal remains inactive", async () => {
  const res = response();
  await makeHandler({
    mappingRows: [mapping("ACTIVE", "REVOKED")]
  })({ method: "GET" }, res);
  assert.equal(res.body.merchantBranch.status, "inactive");
});

test("mapping database error is handled without exposing error details", async () => {
  const res = response();
  await makeHandler({
    mappingError: new Error("private database connection detail")
  })({ method: "GET" }, res);
  assert.equal(res.body.merchantBranch.status, "unavailable");
  assert.equal(JSON.stringify(res.body).includes("private database connection detail"), false);
});

test("dashboard remains monitor-only and never auto-approves deposits", async () => {
  const res = response();
  await makeHandler()({ method: "GET" }, res);
  assert.equal(res.body.blockchainSync.status, "monitor_only");
  assert.equal(res.body.safety.blockchain_scanned, false);
  assert.equal(res.body.safety.transaction_sync_run, false);
  assert.equal(res.body.safety.deposits_auto_approved, false);
});

test("active mapping with invalid receiver address is not configured", async () => {
  const res = response();
  await makeHandler({
    mappingRows: [{
      ...mapping("ACTIVE"),
      receiver_address: "TExampleReceiverAddress"
    }]
  })({ method: "GET" }, res);

  assert.equal(res.body.merchantBranch.status, "invalid_address");
  assert.match(res.body.merchantBranch.detail, /invalid/i);
});
