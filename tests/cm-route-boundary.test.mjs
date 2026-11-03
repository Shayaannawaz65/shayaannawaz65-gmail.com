import test from "node:test";
import assert from "node:assert/strict";
import handler, { API_ROUTE_PATHS } from "../api/[...route].mjs";

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("public route registry preserves the existing POS payment-order endpoint", async () => {
  const res = response();
  await handler({ method: "POST", query: { route: "console/payment-orders" } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Invalid request" });
});

test("public route registry has no CM inbound endpoint before approved contract", async () => {
  const res = response();
  await handler({ method: "POST", query: { route: "console/cm-payment-receipts" } }, res);
  assert.equal(res.statusCode, 404);
});

test("public route registry exposes the existing M1 admin handler", async () => {
  const res = response();
  await handler({ method: "PUT", query: { route: "console/m1-settlement-admin" } }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET, POST");
});

test("catch-all registry includes the authenticated read-only Neon receipt ledger without exposing a CM sender endpoint", () => {
  for (const route of [
    "console/s2s-client-ip-allowlist",
    "console/terminal-admin",
    "console/m1-settlement-admin",
    "console/payment-orders",
    "console/payment-receipts",
    "tron/sync",
    "tron/health"
  ]) assert.ok(API_ROUTE_PATHS.includes(route), `${route} must be registered`);
  assert.equal(API_ROUTE_PATHS.includes("console/cm-payment-receipts"), false);
  assert.equal(API_ROUTE_PATHS.some(route => /skit/i.test(route)), false);
});
