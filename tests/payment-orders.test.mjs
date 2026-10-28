import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler } from "../api/console/payment-orders.mjs";

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

const now = 1_800_000_000_000;
const terminalId = "OFFLINE-201.3-001";
const nonce = "abcdef0123456789abcdef0123456789";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});

const publicKeyBase64 = publicKey.export({
  format: "der",
  type: "spki"
}).toString("base64");

function makeBody(overrides = {}) {
  const fields = {
    terminalId,
    timestamp: now,
    nonce,
    invoiceReference: "INV-TEST-001",
    amountUsdCents: 1250,
    amountUsdtRaw: "12500000",
    expiresInSeconds: 900
  };

  const canonical = [
    "T2T_PAYMENT_ORDER_V1",
    fields.terminalId,
    fields.timestamp,
    fields.nonce,
    fields.invoiceReference,
    fields.amountUsdCents,
    fields.amountUsdtRaw,
    fields.expiresInSeconds
  ].join("\n");

  return {
    ...fields,
    signature: crypto.sign(
      "sha256",
      Buffer.from(canonical, "utf8"),
      privateKey
    ).toString("base64"),
    ...overrides
  };
}

function mockPool({ trusted = true } = {}) {
  const state = { queries: [], committed: false, inserted: false };

  return {
    state,
    async connect() {
      return {
        async query(sql, params = []) {
          state.queries.push({ sql, params });

          if (sql.includes("SELECT t.public_key_base64")) {
            return trusted
              ? {
                  rowCount: 1,
                  rows: [{
                    public_key_base64: publicKeyBase64,
                    internal_mid: "mid-test",
                    receiver_id: "receiver-test",
                    receiver_address: "TExAW9464LvbWmAsbcmNhvHQwawUn8rmN2"
                  }]
                }
              : { rowCount: 0, rows: [] };
          }

          if (sql.includes("INSERT INTO public.t2t_heartbeat_nonces")) {
            return { rowCount: 1, rows: [] };
          }

          if (sql.includes("INSERT INTO public.t2t_payment_orders")) {
            state.inserted = true;
            return {
              rowCount: 1,
              rows: [{
                order_id: "00000000-0000-4000-8000-000000000001",
                invoice_reference: params[1],
                amount_usd_cents: params[2],
                amount_usdt_raw: params[3],
                receiver_address: params[4],
                expires_at: new Date(now + 900000),
                status: "PENDING"
              }]
            };
          }

          if (sql === "COMMIT") state.committed = true;
          return { rowCount: 0, rows: [] };
        },
        release() {}
      };
    }
  };
}

const env = { T2T_PAYMENT_BASE_URL: "https://payments.example.test" };

test("payment order endpoint only allows POST", async () => {
  const res = makeResponse();
  await createHandler({
    poolProvider: () => { throw new Error("Database must not be accessed"); },
    env,
    now: () => now
  })({ method: "GET" }, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
});

test("rejects malformed order before database access", async () => {
  let connected = false;
  const res = makeResponse();

  await createHandler({
    poolProvider: () => {
      connected = true;
      throw new Error("Unexpected database access");
    },
    env,
    now: () => now
  })({ method: "POST", body: makeBody({ amountUsdCents: 0 }) }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});

test("rejects an untrusted terminal", async () => {
  const pool = mockPool({ trusted: false });
  const res = makeResponse();

  await createHandler({
    poolProvider: () => pool,
    env,
    now: () => now
  })({ method: "POST", body: makeBody() }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(pool.state.inserted, false);
});

test("rejects invalid signature without creating an order", async () => {
  const pool = mockPool();
  const res = makeResponse();

  await createHandler({
    poolProvider: () => pool,
    env,
    now: () => now
  })({
    method: "POST",
    body: makeBody({ signature: Buffer.alloc(64, 1).toString("base64") })
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(pool.state.inserted, false);
});

test("valid signed order inserts a pending order using mock database", async () => {
  const pool = mockPool();
  const res = makeResponse();

  await createHandler({
    poolProvider: () => pool,
    env,
    now: () => now,
    randomBytes: size => Buffer.alloc(size, 7)
  })({ method: "POST", body: makeBody() }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.status, "PENDING");
  assert.equal(res.body.currency, "USD");
  assert.equal(res.body.amountUsdCents, 1250);
  assert.equal(res.body.amountUsdtRaw, "12500000");
  assert.match(res.body.paymentUrl, /^https:\/\/payments\.example\.test\/pay\.html\?token=[A-Za-z0-9_-]{43}$/);
  assert.equal(pool.state.inserted, true);
  assert.equal(pool.state.committed, true);

  const insert = pool.state.queries.find(q =>
    q.sql.includes("INSERT INTO public.t2t_payment_orders")
  );
  assert.ok(insert);
  assert.equal(insert.params[5].length, 64);
  assert.equal(insert.params[5].includes("070707"), false);
});
