import test from "node:test";
import assert from "node:assert/strict";
import { createHealthHandler } from "../api/tron/health.mjs";

function makeResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test("health endpoint allows only GET", async () => {
  const res = makeResponse();
  await createHealthHandler()({ method: "POST", headers: {} }, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
});

test("health endpoint rejects missing or incorrect token", async () => {
  const oldToken = process.env.T2T_TRON_SYNC_TOKEN;
  process.env.T2T_TRON_SYNC_TOKEN = "health-test-token";

  try {
    const handler = createHealthHandler();
    const missing = makeResponse();
    await handler({ method: "GET", headers: {} }, missing);
    assert.equal(missing.statusCode, 401);

    const wrong = makeResponse();
    await handler(
      { method: "GET", headers: { authorization: "Bearer wrong-token" } },
      wrong
    );
    assert.equal(wrong.statusCode, 401);
  } finally {
    if (oldToken === undefined) delete process.env.T2T_TRON_SYNC_TOKEN;
    else process.env.T2T_TRON_SYNC_TOKEN = oldToken;
  }
});

test("health endpoint reports configuration without starting scanner", async () => {
  const keys = [
    "T2T_TRON_SYNC_TOKEN",
    "T2T_TRON_RECEIVER_ADDRESS",
    "TRONGRID_API_KEY",
    "DATABASE_URL",
    "POSTGRES_URL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL_NON_POOLING"
  ];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));

  process.env.T2T_TRON_SYNC_TOKEN = "health-test-token";
  process.env.T2T_TRON_RECEIVER_ADDRESS = "test-receiver";
  process.env.TRONGRID_API_KEY = "test-api-key";
  process.env.DATABASE_URL = "test-database-url";

  try {
    const res = makeResponse();
    await createHealthHandler()(
      {
        method: "GET",
        headers: { authorization: "Bearer health-test-token" }
      },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      status: "ready",
      scanner_started: false,
      database_accessed: false,
      blockchain_scanned: false
    });
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(JSON.stringify(res.body).includes("test-api-key"), false);
    assert.equal(JSON.stringify(res.body).includes("test-database-url"), false);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
