import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../lib/routes/console/s2s-terminal-audit.mjs";

const token = "test-admin-token-".padEnd(48, "x");
const env = {
  T2T_S2S_AUTHORIZATION_ADMIN_TOKEN: token,
  T2T_S2S_AUTHORIZATION_ADMIN_ID: "test-operations-admin"
};

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

function request(method = "GET", authorization = `Bearer ${token}`, query = {}) {
  return { method, headers: { authorization }, query };
}

function makeHandler({ config = env, rows = [], fail = false, calls } = {}) {
  return createHandler({
    env: config,
    poolProvider: () => ({
      async query(sql, params) {
        calls?.push({ sql, params });
        if (fail) throw new Error("sensitive database error");
        return { rows };
      }
    })
  });
}

test("audit endpoint only allows GET and disables caching", async () => {
  const res = response();
  await createHandler({
    env: {},
    poolProvider: () => { throw new Error("must not connect"); }
  })(request("POST"), res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("missing admin configuration fails closed before database access", async () => {
  const res = response();
  await createHandler({
    env: {},
    poolProvider: () => { throw new Error("must not connect"); }
  })(request(), res);

  assert.equal(res.statusCode, 503);
});

test("invalid admin token is rejected before database access", async () => {
  const res = response();
  await createHandler({
    env,
    poolProvider: () => { throw new Error("must not connect"); }
  })(request("GET", "Bearer wrong"), res);

  assert.equal(res.statusCode, 401);
});

test("invalid pagination is rejected before database access", async () => {
  const res = response();
  const calls = [];
  await makeHandler({ calls })(
    request("GET", `Bearer ${token}`, { limit: "1000", offset: "-1" }),
    res
  );

  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("authorized audit request returns bounded audit records", async () => {
  const calls = [];
  const createdAt = "2026-10-31T10:00:00.000Z";
  const res = response();

  await makeHandler({
    calls,
    rows: [{
      audit_id: "17",
      key_id: "merchant-key-test-001",
      terminal_id: "OFFLINE-201.3-001",
      action: "GRANT",
      actor_id: "test-operations-admin",
      created_at: createdAt
    }]
  })(request("GET", `Bearer ${token}`, { limit: "25", offset: "50" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.records.length, 1);
  assert.equal(res.body.records[0].auditId, "17");
  assert.equal(res.body.records[0].action, "GRANT");
  assert.deepEqual(res.body.pagination, {
    limit: 25,
    offset: 50,
    returned: 1
  });
  assert.deepEqual(calls[0].params, [25, 50]);
  assert.match(calls[0].sql, /ORDER BY created_at DESC, audit_id DESC/);
});

test("database errors return a generic response without leaking details", async () => {
  const res = response();
  await makeHandler({ fail: true })(request(), res);

  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /sensitive database error/);
});
