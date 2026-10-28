import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler } from "../api/console/payment-status.mjs";

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

const token = "A".repeat(43);
const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

function makeOrder(overrides = {}) {
  return {
    order_id: "order-test-001",
    invoice_reference: "INV-TEST-001",
    currency: "USD",
    amount_usd_cents: 1250,
    amount_usdt_raw: "12500000",
    token_contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    receiver_address: "TExAW9464LvbWmAsbcmNhvHQwawUn8rmN2",
    status: "PENDING",
    expires_at: new Date(Date.now() + 600000),
    confirmed_at: null,
    ...overrides
  };
}

function invoke({ method = "GET", query = { token }, rows, rowCount, fail = false } = {}) {
  const calls = [];
  const poolProvider = () => ({
    async query(sql, params) {
      calls.push({ sql, params });
      if (fail) throw new Error("secret database details");
      return {
        rowCount: rowCount ?? rows.length,
        rows
      };
    }
  });

  const res = makeResponse();
  return {
    calls,
    res,
    done: createHandler({ poolProvider })({ method, query }, res)
  };
}

test("payment status only allows GET and sets no-store", async () => {
  let accessed = false;
  const res = makeResponse();
  await createHandler({
    poolProvider: () => {
      accessed = true;
      throw new Error("must not access database");
    }
  })({ method: "POST", query: { token } }, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(accessed, false);
});

test("invalid payment token is rejected before database access", async () => {
  let accessed = false;
  const res = makeResponse();
  await createHandler({
    poolProvider: () => {
      accessed = true;
      throw new Error("must not access database");
    }
  })({ method: "GET", query: { token: "invalid" } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(accessed, false);
});

test("pending order returns payment details and queries using token hash", async () => {
  const order = makeOrder();
  const result = invoke({ rows: [order] });
  await result.done;

  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.status, "PENDING");
  assert.equal(result.res.body.orderId, order.order_id);
  assert.equal(result.res.body.amountUsdtRaw, "12500000");
  assert.equal(result.res.body.receiverAddress, order.receiver_address);
  assert.equal(result.res.body.confirmedAt, null);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].params, [tokenHash]);
  assert.match(result.calls[0].sql, /payment_token_hash = \$1/);
  assert.equal(result.res.headers["Cache-Control"], "no-store");
});

test("expired pending order is reported as EXPIRED without database writes", async () => {
  const order = makeOrder({
    expires_at: new Date(Date.now() - 1000)
  });
  const result = invoke({ rows: [order] });
  await result.done;

  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.status, "EXPIRED");
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0].sql, /^\s*SELECT/i);
});

test("confirmed order remains CONFIRMED and returns confirmation time", async () => {
  const confirmedAt = new Date(Date.now() - 30000);
  const result = invoke({
    rows: [makeOrder({ status: "CONFIRMED", confirmed_at: confirmedAt })]
  });
  await result.done;

  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.status, "CONFIRMED");
  assert.equal(result.res.body.confirmedAt, confirmedAt.toISOString());
});

test("unknown payment link returns 404", async () => {
  const result = invoke({ rows: [], rowCount: 0 });
  await result.done;

  assert.equal(result.res.statusCode, 404);
  assert.deepEqual(result.res.body, { error: "Payment link not found" });
});

test("database errors return a generic response without leaking details", async () => {
  const result = invoke({ rows: [], fail: true });
  await result.done;

  assert.equal(result.res.statusCode, 503);
  assert.deepEqual(result.res.body, {
    error: "Payment status temporarily unavailable"
  });
  assert.equal(JSON.stringify(result.res.body).includes("secret"), false);
});
