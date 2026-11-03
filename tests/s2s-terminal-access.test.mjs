import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../lib/routes/console/s2s-terminal-access.mjs";

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

const token = "test-admin-token-".padEnd(48, "x");
const actorId = "test-operations-admin";
const requestBody = {
  action: "grant",
  keyId: "merchant-key-test-001",
  terminalId: "OFFLINE-201.3-001"
};

function mockPool({
  parents = true,
  keyStatus = "ACTIVE",
  terminalStatus = "ACTIVE",
  mapping = null,
  failAt = null
} = {}) {
  const state = {
    queries: [],
    mapping,
    audit: [],
    committed: false,
    rolledBack: false
  };

  return {
    state,
    async connect() {
      return {
        async query(sql, params = []) {
          state.queries.push({ sql, params });
          if (failAt && sql.includes(failAt)) throw new Error("simulated");

          if (sql === "BEGIN") return { rowCount: null, rows: [] };
          if (sql === "COMMIT") {
            state.committed = true;
            return { rowCount: null, rows: [] };
          }
          if (sql === "ROLLBACK") {
            state.rolledBack = true;
            return { rowCount: null, rows: [] };
          }
          if (sql.includes("FROM public.t2t_s2s_client_keys")) {
            return {
              rowCount: parents ? 1 : 0,
              rows: parents ? [{
                key_id: params[0],
                key_status: keyStatus,
                terminal_id: params[1],
                terminal_status: terminalStatus
              }] : []
            };
          }
          if (sql.includes("SELECT status") &&
              sql.includes("t2t_s2s_key_terminals")) {
            return {
              rowCount: state.mapping ? 1 : 0,
              rows: state.mapping ? [{ status: state.mapping }] : []
            };
          }
          if (sql.includes("INSERT INTO public.t2t_s2s_key_terminals")) {
            state.mapping = "ACTIVE";
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("UPDATE public.t2t_s2s_key_terminals")) {
            state.mapping = params[0] === requestBody.keyId
              ? (sql.includes("REVOKED") ? "REVOKED" : "ACTIVE")
              : state.mapping;
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("INSERT INTO public.t2t_s2s_terminal_access_audit")) {
            state.audit.push(params[2]);
            return { rowCount: 1, rows: [] };
          }
          throw new Error("Unexpected query");
        },
        release() {}
      };
    }
  };
}

function makeRequest(body = requestBody, authorization = `Bearer ${token}`) {
  return {
    method: "POST",
    headers: { authorization },
    body
  };
}

function handler(pool, env = {
  T2T_S2S_AUTHORIZATION_ADMIN_TOKEN: token,
  T2T_S2S_AUTHORIZATION_ADMIN_ID: actorId
}) {
  return createHandler({
    env,
    poolProvider: () => pool
  });
}

test("only POST is allowed", async () => {
  const res = response();
  await createHandler({
    env: {},
    poolProvider: () => { throw new Error("must not connect"); }
  })({ method: "GET" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
});

test("missing admin token configuration fails closed", async () => {
  const res = response();
  await createHandler({
    env: {},
    poolProvider: () => { throw new Error("must not connect"); }
  })(makeRequest(), res);
  assert.equal(res.statusCode, 503);
});

test("invalid admin token is rejected before database access", async () => {
  const res = response();
  await createHandler({
    env: {
      T2T_S2S_AUTHORIZATION_ADMIN_TOKEN: token,
      T2T_S2S_AUTHORIZATION_ADMIN_ID: actorId
    },
    poolProvider: () => { throw new Error("must not connect"); }
  })(makeRequest(requestBody, "Bearer wrong-token"), res);
  assert.equal(res.statusCode, 401);
});

test("invalid action or identifiers are rejected before database access", async () => {
  const pool = mockPool();
  const res = response();
  await handler(pool)(makeRequest({ ...requestBody, action: "delete" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(pool.state.queries.length, 0);
});

test("grant creates an authorization and audit record transactionally", async () => {
  const pool = mockPool();
  const res = response();
  await handler(pool)(makeRequest(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.changed, true);
  assert.equal(pool.state.mapping, "ACTIVE");
  assert.deepEqual(pool.state.audit, ["GRANT"]);
  assert.equal(pool.state.committed, true);
});

test("grant of an already active mapping is idempotent", async () => {
  const pool = mockPool({ mapping: "ACTIVE" });
  const res = response();
  await handler(pool)(makeRequest(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.changed, false);
  assert.equal(pool.state.audit.length, 0);
  assert.equal(pool.state.committed, true);
});

test("grant reactivates a revoked mapping and clears revoked_at", async () => {
  const pool = mockPool({ mapping: "REVOKED" });
  const res = response();
  await handler(pool)(makeRequest(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(pool.state.mapping, "ACTIVE");
  assert.deepEqual(pool.state.audit, ["GRANT"]);
});

test("revoke updates status and writes an audit record", async () => {
  const pool = mockPool({ mapping: "ACTIVE" });
  const res = response();
  await handler(pool)(makeRequest({ ...requestBody, action: "revoke" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(pool.state.mapping, "REVOKED");
  assert.deepEqual(pool.state.audit, ["REVOKE"]);
  assert.equal(pool.state.committed, true);
});

test("revoke of an already revoked mapping is idempotent", async () => {
  const pool = mockPool({ mapping: "REVOKED" });
  const res = response();
  await handler(pool)(makeRequest({ ...requestBody, action: "revoke" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.changed, false);
  assert.equal(pool.state.audit.length, 0);
});

test("revoke succeeds when the S2S key is inactive", async () => {
  const pool = mockPool({
    keyStatus: "INACTIVE",
    mapping: "ACTIVE"
  });
  const res = response();

  await handler(pool)(
    makeRequest({ ...requestBody, action: "revoke" }), res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(pool.state.mapping, "REVOKED");
  assert.deepEqual(pool.state.audit, ["REVOKE"]);
  assert.equal(pool.state.committed, true);
});

test("revoke succeeds when the trusted terminal is inactive", async () => {
  const pool = mockPool({
    terminalStatus: "INACTIVE",
    mapping: "ACTIVE"
  });
  const res = response();

  await handler(pool)(
    makeRequest({ ...requestBody, action: "revoke" }), res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(pool.state.mapping, "REVOKED");
  assert.deepEqual(pool.state.audit, ["REVOKE"]);
  assert.equal(pool.state.committed, true);
});

test("grant rejects an inactive parent record", async () => {
  const pool = mockPool({ keyStatus: "INACTIVE" });
  const res = response();

  await handler(pool)(makeRequest(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(pool.state.mapping, null);
  assert.equal(pool.state.audit.length, 0);
  assert.equal(pool.state.rolledBack, true);
});

test("inactive or unknown parent records cannot be authorized", async () => {
  const pool = mockPool({ parents: false });
  const res = response();
  await handler(pool)(makeRequest(), res);
  assert.equal(res.statusCode, 404);
  assert.equal(pool.state.audit.length, 0);
  assert.equal(pool.state.rolledBack, true);
});

test("revoke cannot create a missing authorization mapping", async () => {
  const pool = mockPool();
  const res = response();
  await handler(pool)(
    makeRequest({ ...requestBody, action: "revoke" }), res
  );
  assert.equal(res.statusCode, 404);
  assert.equal(pool.state.audit.length, 0);
});

test("database errors roll back and return a generic error", async () => {
  const pool = mockPool({ failAt: "t2t_s2s_terminal_access_audit" });
  const res = response();
  await handler(pool)(makeRequest(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(pool.state.rolledBack, true);
  assert.equal(JSON.stringify(res.body).includes("simulated"), false);
});
