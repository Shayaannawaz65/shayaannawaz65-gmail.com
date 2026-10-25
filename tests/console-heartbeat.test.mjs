import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler } from "../api/console/heartbeat.mjs";

function makeResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

const terminalId = "OFFLINE-201.3-001";
const now = 1_800_000_000_000;
const nonce = "abcdef0123456789abcdef0123456789";
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});
const publicKeyBase64 = publicKey.export({
  format: "der",
  type: "spki"
}).toString("base64");

function signedBody(overrides = {}) {
  const timestamp = now;
  const actualNonce = nonce;
  const canonical = `${terminalId}\n${timestamp}\n${actualNonce}`;
  return {
    terminalId,
    timestamp,
    nonce: actualNonce,
    signature: crypto.sign(
      "sha256",
      Buffer.from(canonical, "utf8"),
      privateKey
    ).toString("base64"),
    ...overrides
  };
}

function mockPool({ trusted = true } = {}) {
  const nonces = new Set();
  const state = { lastSeenUpdated: false, committed: false };

  return {
    state,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql.includes("SELECT public_key_base64")) {
            return trusted
              ? { rowCount: 1, rows: [{ public_key_base64: publicKeyBase64 }] }
              : { rowCount: 0, rows: [] };
          }

          if (sql.includes("INSERT INTO public.t2t_heartbeat_nonces")) {
            const key = `${params[0]}:${params[1]}`;
            if (nonces.has(key)) {
              const error = new Error("duplicate nonce");
              error.code = "23505";
              throw error;
            }
            nonces.add(key);
            return { rowCount: 1, rows: [] };
          }

          if (sql.includes("UPDATE public.t2t_trusted_terminals")) {
            state.lastSeenUpdated = true;
            return { rowCount: 1, rows: [] };
          }

          if (sql === "COMMIT") state.committed = true;
          return { rowCount: 0, rows: [] };
        },
        release() {}
      };
    }
  };
}

test("heartbeat only allows POST", async () => {
  const res = makeResponse();
  await createHandler({ poolProvider: () => { throw Error("must not connect"); }, now: () => now })(
    { method: "GET" }, res
  );
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
});

test("heartbeat rejects an untrusted terminal", async () => {
  const pool = mockPool({ trusted: false });
  const res = makeResponse();
  await createHandler({ poolProvider: () => pool, now: () => now })(
    { method: "POST", body: signedBody() }, res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(pool.state.lastSeenUpdated, false);
});

test("heartbeat rejects an invalid signature", async () => {
  const pool = mockPool();
  const body = signedBody({ signature: Buffer.alloc(64, 1).toString("base64") });
  const res = makeResponse();
  await createHandler({ poolProvider: () => pool, now: () => now })(
    { method: "POST", body }, res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(pool.state.lastSeenUpdated, false);
});

test("heartbeat accepts a valid signature and updates last seen", async () => {
  const pool = mockPool();
  const res = makeResponse();
  await createHandler({ poolProvider: () => pool, now: () => now })(
    { method: "POST", body: signedBody() }, res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.accepted, true);
  assert.equal(res.body.terminalId, terminalId);
  assert.equal(pool.state.lastSeenUpdated, true);
  assert.equal(pool.state.committed, true);
});

test("heartbeat rejects a replayed nonce", async () => {
  const pool = mockPool();
  const handler = createHandler({ poolProvider: () => pool, now: () => now });
  const body = signedBody();

  const first = makeResponse();
  await handler({ method: "POST", body }, first);
  assert.equal(first.statusCode, 200);

  const second = makeResponse();
  await handler({ method: "POST", body }, second);
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.error, "Heartbeat replay rejected");
});
