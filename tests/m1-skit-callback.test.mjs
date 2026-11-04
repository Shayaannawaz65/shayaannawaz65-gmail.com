import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createSkitCallbackHandler } from "../lib/routes/console/m1-skit-callback.mjs";

const secret = "callback-test-secret-with-at-least-32-bytes";
const env = {
  M1_CALLBACK_HMAC_SECRET: secret,
  M1_CALLBACK_SIGNATURE_HEADER: "x-skit-signature",
  M1_CALLBACK_EVENT_ID_HEADER: "x-skit-event-id",
  M1_CALLBACK_SIGNATURE_ENCODING: "hex",
  M1_CALLBACK_STATUS_MAP: JSON.stringify({
    ACCEPTED: "ACCEPTED",
    IN_PROGRESS: "PROCESSING",
    FINAL_SETTLED: "SETTLED",
    DECLINED: "REJECTED"
  })
};

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function fakePool({ duplicate = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql).replace(/\\s+/g, " ").trim(), params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: null, rows: [] };
      if (String(sql).includes("SELECT instruction_id, settlement_status")) {
        return { rowCount: 1, rows: [{ instruction_id: "00000000-0000-4000-8000-000000000001", settlement_status: "NOT_REPORTED" }] };
      }
      if (String(sql).includes("INSERT INTO public.t2t_m1_settlement_callback_events")) {
        return duplicate ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ callback_event_id: "00000000-0000-4000-8000-000000000002" }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  return { calls, connect: async () => client };
}

async function invoke({ status = "ACCEPTED", duplicate = false, eventId = "event-0001" } = {}) {
  const body = Buffer.from(JSON.stringify({
    transaction_id: "M1-transaction-0001",
    status,
    settlement_ref: "settlement-0001"
  }));
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const req = {
    method: "POST",
    rawBody: body,
    headers: { "x-skit-signature": signature, "x-skit-event-id": eventId }
  };
  const res = responseRecorder();
  const pool = fakePool({ duplicate });
  await createSkitCallbackHandler({ env, poolProvider: () => pool })(req, res);
  return { res, pool };
}

test("verifies raw-body HMAC and processes callback under a row lock", async () => {
  const { res, pool } = await invoke({ status: "FINAL_SETTLED" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settlement_status, "SETTLED");
  assert.ok(pool.calls.some(call => call.sql.includes("FOR UPDATE")));
  assert.ok(pool.calls.some(call => call.sql.includes("INSERT INTO public.t2t_m1_settlement_callback_events")));
  assert.ok(pool.calls.some(call => call.sql.includes("UPDATE public.t2t_m1_settlement_outbox")));
});

test("returns idempotent success for an already recorded event", async () => {
  const { res, pool } = await invoke({ duplicate: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
  assert.ok(pool.calls.some(call => call.sql === "ROLLBACK"));
});

test("rejects invalid HMAC without opening a database connection", async () => {
  const pool = fakePool();
  const body = Buffer.from(JSON.stringify({ transaction_id: "M1-transaction-0001", status: "ACCEPTED" }));
  const res = responseRecorder();
  await createSkitCallbackHandler({ env, poolProvider: () => pool })({
    method: "POST",
    rawBody: body,
    headers: { "x-skit-signature": "00", "x-skit-event-id": "event-0002" }
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(pool.calls.length, 0);
});

test("keeps callback endpoint disabled until the full SKIT contract is configured", async () => {
  const res = responseRecorder();
  await createSkitCallbackHandler({ env: {} })({ method: "POST", headers: {} }, res);
  assert.equal(res.statusCode, 503);
});
