import test from "node:test";
import assert from "node:assert/strict";
import {
  NowPaymentsSDK,
  createWebhookSignature
} from "@nowpaymentsio/nowpayments-sdk-nodejs";
import { createHandler } from "../lib/routes/nowpayments/ipn.mjs";

const SECRET = "test-ipn-secret";
const ORDER_ID = "00000000-0000-4000-8000-000000000001";

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function makePayload(overrides = {}) {
  return {
    payment_id: "np-payment-001",
    payment_status: "finished",
    price_amount: 12.5,
    pay_amount: 12.50125,
    pay_address: "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8",
    price_currency: "usd",
    pay_currency: "usdttrc20",
    order_id: ORDER_ID,
    ...overrides
  };
}

function signedRequest(payload) {
  const sdk = new NowPaymentsSDK({
    apiKey: "test-api-key",
    ipnSecret: SECRET
  });
  return {
    method: "POST",
    headers: {
      "x-nowpayments-sig": createWebhookSignature(payload, SECRET)
    },
    body: payload,
    sdk
  };
}

function mockPool({
  order = {},
  duplicate = false,
  missingOrder = false,
  failConnect = false
} = {}) {
  const state = { queries: [], eventCount: 0, updateCount: 0, committed: 0, rolledBack: 0 };
  const row = {
    order_id: ORDER_ID,
    amount_usd_cents: "1250",
    provider_name: "NOWPAYMENTS",
    provider_payment_id: "np-payment-001",
    provider_payment_address: "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8",
    provider_pay_amount: "12.501250",
    provider_pay_currency: "usdttrc20",
    status: "PENDING",
    ...order
  };

  return {
    state,
    async connect() {
      if (failConnect) throw new Error("private database failure");
      return {
        async query(sql, params = []) {
          state.queries.push({ sql, params });
          if (sql === "BEGIN") return { rowCount: 0, rows: [] };
          if (sql === "COMMIT") {
            state.committed += 1;
            return { rowCount: 0, rows: [] };
          }
          if (sql === "ROLLBACK") {
            state.rolledBack += 1;
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes("FROM public.t2t_payment_orders")) {
            return missingOrder
              ? { rowCount: 0, rows: [] }
              : { rowCount: 1, rows: [row] };
          }
          if (sql.includes("INSERT INTO public.t2t_nowpayments_ipn_events")) {
            if (duplicate || state.eventCount > 0) {
              return { rowCount: 0, rows: [] };
            }
            state.eventCount += 1;
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("UPDATE public.t2t_payment_orders")) {
            state.updateCount += 1;
            return { rowCount: 1, rows: [] };
          }
          throw new Error("Unexpected SQL in test: " + sql);
        },
        release() {}
      };
    }
  };
}

async function invoke({ payload = makePayload(), pool = mockPool(), signature } = {}) {
  const req = signedRequest(payload);
  if (signature !== undefined) req.headers["x-nowpayments-sig"] = signature;
  const res = makeResponse();
  await createHandler({
    poolProvider: () => pool,
    sdkProvider: () => req.sdk
  })(req, res);
  return { res, pool };
}

test("NOWPayments IPN endpoint only allows POST", async () => {
  let connected = false;
  const res = makeResponse();
  await createHandler({
    poolProvider: () => {
      connected = true;
      throw new Error("database must not be accessed");
    }
  })({ method: "GET", headers: {}, body: {} }, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(connected, false);
});

test("rejects invalid IPN signature before database access", async () => {
  let connected = false;
  const payload = makePayload();
  const req = signedRequest(payload);
  req.headers["x-nowpayments-sig"] = "00";
  const res = makeResponse();

  await createHandler({
    poolProvider: () => {
      connected = true;
      throw new Error("database must not be accessed");
    },
    sdkProvider: () => req.sdk
  })(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(connected, false);
});

test("verified finished USDT TRC20 IPN confirms the matching USD invoice", async () => {
  const { res, pool } = await invoke();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true });
  assert.equal(pool.state.eventCount, 1);
  assert.equal(pool.state.updateCount, 1);
  assert.equal(pool.state.committed, 1);
  const update = pool.state.queries.find(q =>
    q.sql.includes("UPDATE public.t2t_payment_orders")
  );
  assert.ok(update);
  assert.equal(update.params[0], ORDER_ID);
  assert.equal(update.params[1], "np-payment-001");
  assert.equal(update.params[2], "finished");
  assert.equal(update.params[4], "CONFIRMED");
});

test("rejects an IPN for a different payment currency", async () => {
  const pool = mockPool();
  const { res } = await invoke({
    payload: makePayload({ pay_currency: "usdtbep20" }),
    pool
  });

  assert.equal(res.statusCode, 400);
  assert.equal(pool.state.queries.length, 0);
});

test("rejects USD amount mismatch and rolls back", async () => {
  const pool = mockPool();
  const { res } = await invoke({
    payload: makePayload({ price_amount: 12.51 }),
    pool
  });

  assert.equal(res.statusCode, 409);
  assert.equal(pool.state.rolledBack, 1);
  assert.equal(pool.state.eventCount, 0);
  assert.equal(pool.state.updateCount, 0);
});

test("rejects a payment ID that does not belong to the order", async () => {
  const pool = mockPool();
  const { res } = await invoke({
    payload: makePayload({ payment_id: "another-payment" }),
    pool
  });

  assert.equal(res.statusCode, 409);
  assert.equal(pool.state.rolledBack, 1);
  assert.equal(pool.state.updateCount, 0);
});

test("rejects a direct payment amount mismatch in raw USDT units", async () => {
  const pool = mockPool();
  const { res } = await invoke({
    payload: makePayload({ pay_amount: 12.501251 }),
    pool
  });

  assert.equal(res.statusCode, 409);
  assert.equal(pool.state.rolledBack, 1);
  assert.equal(pool.state.updateCount, 0);
});

test("duplicate signed IPN is idempotent and does not update the order twice", async () => {
  const pool = mockPool();
  const first = await invoke({ pool });
  const second = await invoke({ pool });

  assert.equal(first.res.statusCode, 200);
  assert.equal(second.res.statusCode, 200);
  assert.deepEqual(second.res.body, { ok: true, duplicate: true });
  assert.equal(pool.state.updateCount, 1);
  assert.equal(pool.state.committed, 2);
});

test("unknown order returns 404 without recording an IPN event", async () => {
  const pool = mockPool({ missingOrder: true });
  const { res } = await invoke({ pool });

  assert.equal(res.statusCode, 404);
  assert.equal(pool.state.eventCount, 0);
  assert.equal(pool.state.rolledBack, 1);
});

test("database outage returns generic 503 without leaking details", async () => {
  const pool = mockPool({ failConnect: true });
  const { res } = await invoke({ pool });

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    error: "IPN processing temporarily unavailable"
  });
  assert.equal(JSON.stringify(res.body).includes("private"), false);
});
