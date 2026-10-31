import { normalizeTronAddress } from "../api/tron/address.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {

  amountUsdt,
  authorized,
  resolveActiveReceiver
} from "../api/tron/sync.mjs";

test("accepts the official USDT TRC20 contract address", () => {
  const address = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  assert.equal(normalizeTronAddress(address), address);
});

test("normalizes USDT contract hex with or without the 41 prefix", () => {
  const address = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const hex = "a614f803b6fd780986a42c78ec9c7f77e6ded13c";
  assert.equal(normalizeTronAddress(hex), address);
  assert.equal(normalizeTronAddress("41" + hex), address);
});

test("rejects malformed Tron addresses and hex input", () => {
  assert.equal(normalizeTronAddress(""), "");
  assert.equal(normalizeTronAddress("not-an-address"), "");
  assert.equal(normalizeTronAddress("0x1234"), "");
});

test("rejects a Base58 address with an invalid checksum", () => {
  const valid = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const replacement = valid.endsWith("1") ? "2" : "1";
  const invalid = valid.slice(0, -1) + replacement;
  assert.equal(normalizeTronAddress(invalid), "");
});

test("formats integer USDT raw units exactly to six decimals", () => {
  assert.equal(amountUsdt("1"), "0.000001");
  assert.equal(amountUsdt("1234567"), "1.234567");
  assert.equal(amountUsdt("1000000"), "1.000000");
  assert.equal(amountUsdt("0"), "0.000000");
});

test("authorizes only a matching Bearer token", () => {
  const expected = "local-test-token";
  assert.equal(
    authorized({ headers: { authorization: "Bearer local-test-token" } }, expected),
    true
  );
  assert.equal(
    authorized({ headers: { authorization: "Bearer wrong-token" } }, expected),
    false
  );
  assert.equal(authorized({ headers: {} }, expected), false);
});

import handler from "../api/tron/sync.mjs";
import { createHandler } from "../api/tron/sync.mjs";

test("rejects non-POST requests before accessing configuration or database", async () => {
  const headers = {};
  let statusCode;
  let responseBody;

  const res = {
    setHeader(name, value) {
      headers[name] = value;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  await handler({ method: "GET", headers: {} }, res);

  assert.equal(statusCode, 405);
  assert.equal(headers.Allow, "POST");
  assert.deepEqual(responseBody, { error: "Method not allowed" });
});

test("returns 503 when server configuration is incomplete", async () => {
  const saved = {
    token: process.env.T2T_TRON_SYNC_TOKEN,
    receiver: process.env.T2T_TRON_RECEIVER_ADDRESS,
    apiKey: process.env.TRONGRID_API_KEY
  };

  delete process.env.T2T_TRON_SYNC_TOKEN;
  delete process.env.T2T_TRON_RECEIVER_ADDRESS;
  delete process.env.TRONGRID_API_KEY;

  const headers = {};
  let statusCode;
  let responseBody;

  const res = {
    setHeader(name, value) {
      headers[name] = value;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    await handler({ method: "POST", headers: {} }, res);
    assert.equal(statusCode, 503);
    assert.deepEqual(responseBody, { error: "Server configuration incomplete" });
  } finally {
    for (const [key, value] of Object.entries({
      T2T_TRON_SYNC_TOKEN: saved.token,
      T2T_TRON_RECEIVER_ADDRESS: saved.receiver,
      TRONGRID_API_KEY: saved.apiKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("rejects an invalid Bearer token before connecting to the database", async () => {
  const saved = {
    token: process.env.T2T_TRON_SYNC_TOKEN,
    receiver: process.env.T2T_TRON_RECEIVER_ADDRESS,
    apiKey: process.env.TRONGRID_API_KEY,
    jwtPrivateKey: process.env.TRONGRID_JWT_PRIVATE_KEY,
    jwtKeyId: process.env.TRONGRID_JWT_KEY_ID
  };

  process.env.T2T_TRON_SYNC_TOKEN = "test-only-secret";
  process.env.T2T_TRON_RECEIVER_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.TRONGRID_API_KEY = "test-only-api-key";
  process.env.TRONGRID_JWT_PRIVATE_KEY = "test-only-private-key";
  process.env.TRONGRID_JWT_KEY_ID = "test-only-key-id";

  let statusCode;
  let responseBody;

  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    await handler({
      method: "POST",
      headers: { authorization: "Bearer wrong-token" }
    }, res);

    assert.equal(statusCode, 401);
    assert.deepEqual(responseBody, { error: "Unauthorized" });
  } finally {
    for (const [key, value] of Object.entries({
      T2T_TRON_SYNC_TOKEN: saved.token,
      T2T_TRON_RECEIVER_ADDRESS: saved.receiver,
      TRONGRID_API_KEY: saved.apiKey,
      TRONGRID_JWT_PRIVATE_KEY: saved.jwtPrivateKey,
      TRONGRID_JWT_KEY_ID: saved.jwtKeyId
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test("returns 409 and skips provider fetch when another request owns the lease", async () => {
  const saved = {
    token: process.env.T2T_TRON_SYNC_TOKEN,
    receiver: process.env.T2T_TRON_RECEIVER_ADDRESS,
    apiKey: process.env.TRONGRID_API_KEY
  };

  process.env.T2T_TRON_SYNC_TOKEN = "test-only-secret";
  process.env.T2T_TRON_RECEIVER_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.TRONGRID_API_KEY = "test-only-api-key";

  let statusCode;
  let responseBody;
  let fetchCalls = 0;
  const queries = [];

  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("lease_token = $2::uuid")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  const testHandler = createHandler({
    receiverResolver: async () => process.env.T2T_TRON_RECEIVER_ADDRESS,
    jwtFactory: () => "test-only-jwt",
    poolProvider: () => ({ connect: async () => client }),
    fetchImpl: async () => {
      fetchCalls++;
      throw new Error("Provider fetch must not run for a lease conflict");
    }
  });

  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    await testHandler({
      method: "POST",
      headers: { authorization: "Bearer test-only-secret" }
    }, res);

    assert.equal(statusCode, 409);
    assert.equal(responseBody.retry_required, true);
    assert.equal(responseBody.auto_approval, false);
    assert.equal(fetchCalls, 0);
    assert.ok(queries.some(sql => sql.includes("lease_until")));
  } finally {
    for (const [key, value] of Object.entries({
      T2T_TRON_SYNC_TOKEN: saved.token,
      T2T_TRON_RECEIVER_ADDRESS: saved.receiver,
      TRONGRID_API_KEY: saved.apiKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test("returns 409 without provider or deposit writes when lease renewal is lost", async () => {
  const saved = {
    token: process.env.T2T_TRON_SYNC_TOKEN,
    receiver: process.env.T2T_TRON_RECEIVER_ADDRESS,
    apiKey: process.env.TRONGRID_API_KEY
  };

  process.env.T2T_TRON_SYNC_TOKEN = "test-only-secret";
  process.env.T2T_TRON_RECEIVER_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.TRONGRID_API_KEY = "test-only-api-key";

  let statusCode;
  let responseBody;
  let fetchCalls = 0;
  const queries = [];
  let leaseUpdateCount = 0;

  const client = {
    async query(sql) {
      queries.push(sql);

      if (sql.includes("SET lease_token = $2::uuid")) {
        return { rowCount: 1, rows: [{ receiver_address: "test" }] };
      }

      if (sql.includes("SET lease_until = NOW()")) {
        leaseUpdateCount++;
        return {
          rowCount: 0,
          rows: [],
        };
      }

      if (sql.includes("SELECT last_completed_timestamp")) {
        return {
          rowCount: 1,
          rows: [{ last_completed_timestamp: new Date(Date.now() - 60000).toISOString() }]
        };
      }

      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  const testHandler = createHandler({
    receiverResolver: async () => process.env.T2T_TRON_RECEIVER_ADDRESS,
    jwtFactory: () => "test-only-jwt",
    poolProvider: () => ({ connect: async () => client }),
    fetchImpl: async () => {
      fetchCalls++;
      throw new Error("Provider fetch must not run after lease loss");
    }
  });

  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    await testHandler({
      method: "POST",
      headers: { authorization: "Bearer test-only-secret" }
    }, res);

    assert.equal(statusCode, 409);
    assert.equal(responseBody.auto_approval, false);
    assert.equal(fetchCalls, 0);
    assert.equal(leaseUpdateCount, 1);
    assert.equal(
      queries.some(sql => /INSERT INTO public\.tron_usdt_deposits/i.test(sql)),
      false
    );
    assert.equal(
      queries.some(sql => /SET last_completed_timestamp/i.test(sql)),
      false
    );
  } finally {
    for (const [key, value] of Object.entries({
      T2T_TRON_SYNC_TOKEN: saved.token,
      T2T_TRON_RECEIVER_ADDRESS: saved.receiver,
      TRONGRID_API_KEY: saved.apiKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test("keeps cursor unchanged and releases lease when provider fails", async () => {
  const saved = {
    token: process.env.T2T_TRON_SYNC_TOKEN,
    receiver: process.env.T2T_TRON_RECEIVER_ADDRESS,
    apiKey: process.env.TRONGRID_API_KEY
  };

  process.env.T2T_TRON_SYNC_TOKEN = "test-only-secret";
  process.env.T2T_TRON_RECEIVER_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.TRONGRID_API_KEY = "test-only-api-key";

  let statusCode;
  let responseBody;
  let fetchCalls = 0;
  let releaseCalls = 0;
  const queries = [];
  const cursor = new Date(Date.now() - 60_000).toISOString();

  const client = {
    async query(sql) {
      queries.push(sql);

      if (sql.includes("SET lease_token = $2::uuid")) {
        return { rowCount: 1, rows: [{ receiver_address: "test" }] };
      }

      if (sql.includes("SET lease_token = NULL")) {
        releaseCalls++;
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("SET lease_until = NOW()")) {
        return { rowCount: 1, rows: [{ receiver_address: "test" }] };
      }

      if (sql.includes("SELECT last_completed_timestamp")) {
        return { rowCount: 1, rows: [{ last_completed_timestamp: cursor }] };
      }

      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  const testHandler = createHandler({
    receiverResolver: async () => process.env.T2T_TRON_RECEIVER_ADDRESS,
    jwtFactory: () => "test-only-jwt",
    poolProvider: () => ({ connect: async () => client }),
    fetchImpl: async () => {
      fetchCalls++;
      return {
        ok: false,
        status: 503,
        json: async () => ({})
      };
    }
  });

  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    await testHandler({
      method: "POST",
      headers: { authorization: "Bearer test-only-secret" }
    }, res);

    assert.equal(statusCode, 502);
    assert.deepEqual(responseBody, {
      error: "Sync failed; check server logs"
    });
    assert.ok(fetchCalls > 0);
    assert.equal(releaseCalls, 1);
    assert.equal(
      queries.some(sql => /SET last_completed_timestamp/i.test(sql)),
      false
    );
    assert.equal(
      queries.some(sql => sql.trim() === "BEGIN"),
      false
    );
    assert.equal(
      queries.some(sql => sql.trim() === "COMMIT"),
      false
    );
  } finally {
    for (const [key, value] of Object.entries({
      T2T_TRON_SYNC_TOKEN: saved.token,
      T2T_TRON_RECEIVER_ADDRESS: saved.receiver,
      TRONGRID_API_KEY: saved.apiKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test("commits completed empty scan windows and releases lease", async () => {
  const saved = {
    token: process.env.T2T_TRON_SYNC_TOKEN,
    receiver: process.env.T2T_TRON_RECEIVER_ADDRESS,
    apiKey: process.env.TRONGRID_API_KEY
  };

  process.env.T2T_TRON_SYNC_TOKEN = "test-only-secret";
  process.env.T2T_TRON_RECEIVER_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.TRONGRID_API_KEY = "test-only-api-key";

  let statusCode;
  let responseBody;
  let fetchCalls = 0;
  let releaseQueries = 0;
  let commits = 0;
  let rollbacks = 0;
  let cursor = null;
  const queries = [];

  const client = {
    async query(sql, params = []) {
      queries.push(sql);
      const q = sql.trim();

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("ON CONFLICT (receiver_address) DO NOTHING")) {
        cursor ??= params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_token = $2::uuid")) {
        return { rowCount: 1, rows: [{ receiver_address: "test" }] };
      }

      if (q.includes("SET lease_token = NULL")) {
        releaseQueries++;
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_until = NOW()")) {
        return { rowCount: 1, rows: [{ receiver_address: "test" }] };
      }

      if (q.startsWith("SELECT last_completed_timestamp")) {
        return { rowCount: 1, rows: [{ last_completed_timestamp: cursor }] };
      }

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("last_completed_timestamp, updated_at")) {
        cursor = params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q === "BEGIN") return { rowCount: null, rows: [] };
      if (q === "COMMIT") {
        commits++;
        return { rowCount: null, rows: [] };
      }
      if (q === "ROLLBACK") {
        rollbacks++;
        return { rowCount: null, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  const testHandler = createHandler({
    receiverResolver: async () => process.env.T2T_TRON_RECEIVER_ADDRESS,
    jwtFactory: () => "test-only-jwt",
    poolProvider: () => ({ connect: async () => client }),
    fetchImpl: async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [], meta: {} })
      };
    }
  });

  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    await testHandler({
      method: "POST",
      headers: { authorization: "Bearer test-only-secret" }
    }, res);

    assert.equal(statusCode, 200);
    assert.ok(fetchCalls > 0);
    assert.ok(commits > 0);
    assert.equal(rollbacks, 0);
    assert.equal(releaseQueries, 1);
    assert.ok(cursor);
    assert.equal(
      queries.some(sql => /INSERT INTO public\.tron_usdt_deposits/i.test(sql)),
      false
    );
    assert.equal(responseBody.auto_approval, false);
  } finally {
    for (const [key, value] of Object.entries({
      T2T_TRON_SYNC_TOKEN: saved.token,
      T2T_TRON_RECEIVER_ADDRESS: saved.receiver,
      TRONGRID_API_KEY: saved.apiKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test("confirms a uniquely matched payment order when the database updates one row", async () => {
  const saved = {
    token: process.env.T2T_TRON_SYNC_TOKEN,
    receiver: process.env.T2T_TRON_RECEIVER_ADDRESS,
    apiKey: process.env.TRONGRID_API_KEY
  };

  process.env.T2T_TRON_SYNC_TOKEN = "test-only-secret";
  process.env.T2T_TRON_RECEIVER_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.TRONGRID_API_KEY = "test-only-api-key";

  let statusCode;
  let responseBody;
  let fetchCalls = 0;
  let commits = 0;
  let rollbacks = 0;
  let releaseQueries = 0;
  let cursor = null;
  const depositInserts = [];
  const queries = [];
  let transferTimestamp = null;

  const txid = "a".repeat(64);
  const receiver = process.env.T2T_TRON_RECEIVER_ADDRESS;
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const sender = "41" + "22".repeat(20);
  const senderAddress = normalizeTronAddress(sender);
  const rawAmount = "1250000";

  const client = {
    async query(sql, params = []) {
      queries.push(sql);
      const q = sql.trim();

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("ON CONFLICT (receiver_address) DO NOTHING")) {
        cursor ??= params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_token = $2::uuid")) {
        return { rowCount: 1, rows: [{ receiver_address: receiver }] };
      }

      if (q.includes("SET lease_token = NULL")) {
        releaseQueries++;
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_until = NOW()")) {
        return { rowCount: 1, rows: [{ receiver_address: receiver }] };
      }

      if (q.startsWith("SELECT last_completed_timestamp")) {
        return { rowCount: 1, rows: [{ last_completed_timestamp: cursor }] };
      }

      if (q.startsWith("INSERT INTO public.tron_usdt_deposits")) {
        depositInserts.push({ sql: q, params });
        return { rowCount: 1, rows: [{ transaction_id: txid }] };
      }

      if (q.includes("FROM public.t2t_payment_orders") &&
          q.includes("FOR UPDATE")) {
        const blockTime = new Date(params[3]).getTime();
        return {
          rowCount: 1,
          rows: [{
            orderId: "test-order-001",
            status: "PENDING",
            tokenContract: contract,
            receiverAddress: receiver,
            amountUsdtRaw: rawAmount,
            createdAt: new Date(blockTime - 1000).toISOString(),
            expiresAt: new Date(blockTime + 3600000).toISOString()
          }]
        };
      }

      if (q.includes("UPDATE public.t2t_payment_orders") &&
          q.includes("status = 'CONFIRMED'")) {
        queries.push("MATCHED_ORDER_UPDATE");
        assert.equal(params[0], "test-order-001");
        assert.equal(params[1], txid);
        assert.equal(params[2], 0);
        return { rowCount: 1, rows: [] };
      }

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("last_completed_timestamp, updated_at")) {
        cursor = params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q === "BEGIN") return { rowCount: null, rows: [] };
      if (q === "COMMIT") {
        commits++;
        return { rowCount: null, rows: [] };
      }
      if (q === "ROLLBACK") {
        rollbacks++;
        return { rowCount: null, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  const testHandler = createHandler({
    receiverResolver: async () => process.env.T2T_TRON_RECEIVER_ADDRESS,
    jwtFactory: () => "test-only-jwt",
    poolProvider: () => ({ connect: async () => client }),
    fetchImpl: async input => {
      fetchCalls++;
      const url = new URL(String(input));

      if (url.pathname.includes("/transactions/") &&
          url.pathname.endsWith("/events")) {
        const timestamp = transferTimestamp;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              transaction_id: txid,
              event_index: 0,
              block_timestamp: timestamp,
              contract_address: contract,
              event_name: "Transfer",
              result: {
                from: senderAddress,
                to: receiver,
                value: rawAmount
              },
              success: true
            }],
            meta: {}
          })
        };
      }

      if (url.pathname.includes("/accounts/") &&
          url.pathname.endsWith("/transactions/trc20")) {
        const timestamp = Number(url.searchParams.get("min_timestamp")) + 1000;
        transferTimestamp = timestamp;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              transaction_id: txid,
              from: senderAddress,
              to: receiver,
              token_info: { address: contract },
              value: rawAmount,
              block_timestamp: timestamp
            }],
            meta: {}
          })
        };
      }

      throw new Error("Unexpected test provider URL: " + url.pathname);
    }
  });

  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    assert.ok(senderAddress, "test sender must be a valid normalized TRON address");

    await testHandler({
      method: "POST",
      headers: { authorization: "Bearer test-only-secret" }
    }, res);

    assert.equal(statusCode, 200);
    assert.ok(fetchCalls > 0);
    assert.equal(depositInserts.length, 1);
    assert.ok(
      queries.some(sql => /FROM public\.t2t_payment_orders/i.test(sql)),
      "sync must query eligible payment orders inside the transaction"
    );
    assert.ok(
      queries.includes("MATCHED_ORDER_UPDATE"),
      "sync must attempt the unique payment-order confirmation"
    );
    assert.ok(commits > 0);
    assert.equal(rollbacks, 0);
    assert.equal(releaseQueries, 1);
    assert.equal(responseBody.new_events, 1);
    assert.equal(responseBody.auto_approval, false);
    assert.ok(cursor);
    assert.ok(
      depositInserts[0].params.some(value => value === rawAmount),
      "raw USDT amount must be stored exactly"
    );
    assert.equal(
      queries.some(sql => /^UPDATE\\s+public\\.tron_usdt_sync_state\\b/i.test(sql.trim())),
      false,
      "cursor must not use a standalone UPDATE statement"
    );
  } finally {
    for (const [key, value] of Object.entries({
      T2T_TRON_SYNC_TOKEN: saved.token,
      T2T_TRON_RECEIVER_ADDRESS: saved.receiver,
      TRONGRID_API_KEY: saved.apiKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("rolls back deposit and cursor transaction when payment-order lookup fails", async () => {
  const saved = {
    token: process.env.T2T_TRON_SYNC_TOKEN,
    receiver: process.env.T2T_TRON_RECEIVER_ADDRESS,
    apiKey: process.env.TRONGRID_API_KEY
  };

  process.env.T2T_TRON_SYNC_TOKEN = "test-only-secret";
  process.env.T2T_TRON_RECEIVER_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.TRONGRID_API_KEY = "test-only-api-key";

  let statusCode;
  let responseBody;
  let fetchCalls = 0;
  let commits = 0;
  let rollbacks = 0;
  let releaseQueries = 0;
  let cursor = null;
  let cursorAdvances = 0;
  const depositInserts = [];
  const queries = [];
  let transferTimestamp = null;

  const txid = "a".repeat(64);
  const receiver = process.env.T2T_TRON_RECEIVER_ADDRESS;
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const sender = "41" + "22".repeat(20);
  const senderAddress = normalizeTronAddress(sender);
  const rawAmount = "1250000";

  const client = {
    async query(sql, params = []) {
      queries.push(sql);
      const q = sql.trim();

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("ON CONFLICT (receiver_address) DO NOTHING")) {
        cursor ??= params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_token = $2::uuid")) {
        return { rowCount: 1, rows: [{ receiver_address: receiver }] };
      }

      if (q.includes("SET lease_token = NULL")) {
        releaseQueries++;
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_until = NOW()")) {
        return { rowCount: 1, rows: [{ receiver_address: receiver }] };
      }

      if (q.startsWith("SELECT last_completed_timestamp")) {
        return { rowCount: 1, rows: [{ last_completed_timestamp: cursor }] };
      }

      if (q.startsWith("INSERT INTO public.tron_usdt_deposits")) {
        depositInserts.push({ sql: q, params });
        return { rowCount: 1, rows: [{ transaction_id: txid }] };
      }

      if (q.includes("FROM public.t2t_payment_orders") &&
          q.includes("FOR UPDATE")) {
        throw new Error("simulated payment-order database failure");
      }

      if (q.includes("UPDATE public.t2t_payment_orders") &&
          q.includes("status = 'CONFIRMED'")) {
        queries.push("MATCHED_ORDER_UPDATE");
        assert.equal(params[0], "test-order-001");
        assert.equal(params[1], txid);
        assert.equal(params[2], 0);
        return { rowCount: 1, rows: [] };
      }

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("last_completed_timestamp, updated_at")) {
        cursorAdvances++;
        cursor = params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q === "BEGIN") return { rowCount: null, rows: [] };
      if (q === "COMMIT") {
        commits++;
        return { rowCount: null, rows: [] };
      }
      if (q === "ROLLBACK") {
        rollbacks++;
        return { rowCount: null, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  const testHandler = createHandler({
    receiverResolver: async () => process.env.T2T_TRON_RECEIVER_ADDRESS,
    jwtFactory: () => "test-only-jwt",
    poolProvider: () => ({ connect: async () => client }),
    fetchImpl: async input => {
      fetchCalls++;
      const url = new URL(String(input));

      if (url.pathname.includes("/transactions/") &&
          url.pathname.endsWith("/events")) {
        const timestamp = transferTimestamp;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              transaction_id: txid,
              event_index: 0,
              block_timestamp: timestamp,
              contract_address: contract,
              event_name: "Transfer",
              result: {
                from: senderAddress,
                to: receiver,
                value: rawAmount
              },
              success: true
            }],
            meta: {}
          })
        };
      }

      if (url.pathname.includes("/accounts/") &&
          url.pathname.endsWith("/transactions/trc20")) {
        const timestamp = Number(url.searchParams.get("min_timestamp")) + 1000;
        transferTimestamp = timestamp;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              transaction_id: txid,
              from: senderAddress,
              to: receiver,
              token_info: { address: contract },
              value: rawAmount,
              block_timestamp: timestamp
            }],
            meta: {}
          })
        };
      }

      throw new Error("Unexpected test provider URL: " + url.pathname);
    }
  });

  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    assert.ok(senderAddress, "test sender must be a valid normalized TRON address");

    await testHandler({
      method: "POST",
      headers: { authorization: "Bearer test-only-secret" }
    }, res);

    assert.equal(statusCode, 502);
    assert.equal(responseBody.error, "Sync failed; check server logs");
    assert.equal(depositInserts.length, 1, "deposit insert must be attempted before the simulated failure");
    assert.equal(commits, 0, "failed matching transaction must not commit");
    assert.equal(rollbacks, 1, "failed matching transaction must roll back");
    assert.equal(cursorAdvances, 0, "failed matching transaction must not advance the cursor");
    assert.equal(releaseQueries, 1, "sync lease must be released");
  } finally {
    for (const [key, value] of Object.entries({
      T2T_TRON_SYNC_TOKEN: saved.token,
      T2T_TRON_RECEIVER_ADDRESS: saved.receiver,
      TRONGRID_API_KEY: saved.apiKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("leaves a payment order unconfirmed when its conditional update affects zero rows", async () => {
  const saved = {
    token: process.env.T2T_TRON_SYNC_TOKEN,
    receiver: process.env.T2T_TRON_RECEIVER_ADDRESS,
    apiKey: process.env.TRONGRID_API_KEY
  };

  process.env.T2T_TRON_SYNC_TOKEN = "test-only-secret";
  process.env.T2T_TRON_RECEIVER_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.TRONGRID_API_KEY = "test-only-api-key";

  let statusCode;
  let responseBody;
  let fetchCalls = 0;
  let commits = 0;
  let rollbacks = 0;
  let releaseQueries = 0;
  let cursor = null;
  const depositInserts = [];
  const queries = [];
  let transferTimestamp = null;

  const txid = "a".repeat(64);
  const receiver = process.env.T2T_TRON_RECEIVER_ADDRESS;
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const sender = "41" + "22".repeat(20);
  const senderAddress = normalizeTronAddress(sender);
  const rawAmount = "1250000";

  const client = {
    async query(sql, params = []) {
      queries.push(sql);
      const q = sql.trim();

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("ON CONFLICT (receiver_address) DO NOTHING")) {
        cursor ??= params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_token = $2::uuid")) {
        return { rowCount: 1, rows: [{ receiver_address: receiver }] };
      }

      if (q.includes("SET lease_token = NULL")) {
        releaseQueries++;
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_until = NOW()")) {
        return { rowCount: 1, rows: [{ receiver_address: receiver }] };
      }

      if (q.startsWith("SELECT last_completed_timestamp")) {
        return { rowCount: 1, rows: [{ last_completed_timestamp: cursor }] };
      }

      if (q.startsWith("INSERT INTO public.tron_usdt_deposits")) {
        depositInserts.push({ sql: q, params });
        return { rowCount: 1, rows: [{ transaction_id: txid }] };
      }

      if (q.includes("FROM public.t2t_payment_orders") &&
          q.includes("FOR UPDATE")) {
        const blockTime = new Date(params[3]).getTime();
        return {
          rowCount: 1,
          rows: [{
            orderId: "test-order-001",
            status: "PENDING",
            tokenContract: contract,
            receiverAddress: receiver,
            amountUsdtRaw: rawAmount,
            createdAt: new Date(blockTime - 1000).toISOString(),
            expiresAt: new Date(blockTime + 3600000).toISOString()
          }]
        };
      }

      if (q.includes("UPDATE public.t2t_payment_orders") &&
          q.includes("status = 'CONFIRMED'")) {
        queries.push("MATCHED_ORDER_UPDATE");
        assert.equal(params[0], "test-order-001");
        assert.equal(params[1], txid);
        assert.equal(params[2], 0);
        return { rowCount: 0, rows: [] };
      }

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("last_completed_timestamp, updated_at")) {
        cursor = params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q === "BEGIN") return { rowCount: null, rows: [] };
      if (q === "COMMIT") {
        commits++;
        return { rowCount: null, rows: [] };
      }
      if (q === "ROLLBACK") {
        rollbacks++;
        return { rowCount: null, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  const testHandler = createHandler({
    receiverResolver: async () => process.env.T2T_TRON_RECEIVER_ADDRESS,
    jwtFactory: () => "test-only-jwt",
    poolProvider: () => ({ connect: async () => client }),
    fetchImpl: async input => {
      fetchCalls++;
      const url = new URL(String(input));

      if (url.pathname.includes("/transactions/") &&
          url.pathname.endsWith("/events")) {
        const timestamp = transferTimestamp;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              transaction_id: txid,
              event_index: 0,
              block_timestamp: timestamp,
              contract_address: contract,
              event_name: "Transfer",
              result: {
                from: senderAddress,
                to: receiver,
                value: rawAmount
              },
              success: true
            }],
            meta: {}
          })
        };
      }

      if (url.pathname.includes("/accounts/") &&
          url.pathname.endsWith("/transactions/trc20")) {
        const timestamp = Number(url.searchParams.get("min_timestamp")) + 1000;
        transferTimestamp = timestamp;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              transaction_id: txid,
              from: senderAddress,
              to: receiver,
              token_info: { address: contract },
              value: rawAmount,
              block_timestamp: timestamp
            }],
            meta: {}
          })
        };
      }

      throw new Error("Unexpected test provider URL: " + url.pathname);
    }
  });

  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    assert.ok(senderAddress, "test sender must be a valid normalized TRON address");

    await testHandler({
      method: "POST",
      headers: { authorization: "Bearer test-only-secret" }
    }, res);

    assert.equal(statusCode, 200);
    assert.ok(fetchCalls > 0);
    assert.equal(depositInserts.length, 1);
    assert.ok(
      queries.some(sql => /FROM public\.t2t_payment_orders/i.test(sql)),
      "sync must query eligible payment orders inside the transaction"
    );
    assert.ok(
      queries.includes("MATCHED_ORDER_UPDATE"),
      "sync must attempt the unique payment-order confirmation"
    );
    assert.ok(commits > 0);
    assert.equal(rollbacks, 0);
    assert.equal(releaseQueries, 1);
    assert.equal(responseBody.new_events, 1);
    assert.equal(responseBody.auto_approval, false);
    assert.ok(cursor);
    assert.ok(
      depositInserts[0].params.some(value => value === rawAmount),
      "raw USDT amount must be stored exactly"
    );
    assert.equal(
      queries.some(sql => /^UPDATE\\s+public\\.tron_usdt_sync_state\\b/i.test(sql.trim())),
      false,
      "cursor must not use a standalone UPDATE statement"
    );
  } finally {
    for (const [key, value] of Object.entries({
      T2T_TRON_SYNC_TOKEN: saved.token,
      T2T_TRON_RECEIVER_ADDRESS: saved.receiver,
      TRONGRID_API_KEY: saved.apiKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("incomplete pagination returns 503 without advancing cursor or writing deposits", async () => {
  const saved = {
    token: process.env.T2T_TRON_SYNC_TOKEN,
    receiver: process.env.T2T_TRON_RECEIVER_ADDRESS,
    apiKey: process.env.TRONGRID_API_KEY
  };

  process.env.T2T_TRON_SYNC_TOKEN = "test-only-secret";
  process.env.T2T_TRON_RECEIVER_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.TRONGRID_API_KEY = "test-only-api-key";

  let statusCode;
  let responseBody;
  let cursor = null;
  let fetchCalls = 0;
  let releaseCalls = 0;
  let depositWrites = 0;
  let cursorAdvances = 0;
  let commits = 0;
  const queries = [];

  const client = {
    async query(sql, params = []) {
      queries.push(sql);
      const q = sql.trim();

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("ON CONFLICT (receiver_address) DO NOTHING")) {
        cursor ??= params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_token = $2::uuid")) {
        return { rowCount: 1, rows: [{ receiver_address: process.env.T2T_TRON_RECEIVER_ADDRESS }] };
      }

      if (q.includes("SET lease_token = NULL")) {
        releaseCalls++;
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_until = NOW()")) {
        return { rowCount: 1, rows: [{ receiver_address: process.env.T2T_TRON_RECEIVER_ADDRESS }] };
      }

      if (q.startsWith("SELECT last_completed_timestamp")) {
        return { rowCount: 1, rows: [{ last_completed_timestamp: cursor }] };
      }

      if (q.startsWith("INSERT INTO public.tron_usdt_deposits")) {
        depositWrites++;
        return { rowCount: 1, rows: [] };
      }

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("last_completed_timestamp, updated_at")) {
        cursorAdvances++;
        cursor = params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q === "COMMIT") commits++;
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  const testHandler = createHandler({
    receiverResolver: async () => process.env.T2T_TRON_RECEIVER_ADDRESS,
    jwtFactory: () => "test-only-jwt",
    poolProvider: () => ({ connect: async () => client }),
    fetchImpl: async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [],
          meta: { fingerprint: "next-page-token" }
        })
      };
    }
  });

  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    await testHandler({
      method: "POST",
      headers: { authorization: "Bearer test-only-secret" }
    }, res);

    assert.equal(statusCode, 503);
    assert.equal(responseBody.status, "SCAN_INCOMPLETE");
    assert.equal(responseBody.retry_required, true);
    assert.equal(responseBody.auto_approval, false);
    assert.equal(responseBody.cursor_timestamp, cursor);
    assert.equal(fetchCalls, 40);
    assert.equal(cursorAdvances, 0);
    assert.equal(depositWrites, 0);
    assert.equal(commits, 0);
    assert.equal(releaseCalls, 1);
  } finally {
    for (const [key, value] of Object.entries({
      T2T_TRON_SYNC_TOKEN: saved.token,
      T2T_TRON_RECEIVER_ADDRESS: saved.receiver,
      TRONGRID_API_KEY: saved.apiKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("duplicate confirmed transfer is not reinserted and updates last_seen_at", async () => {
  const saved = {
    token: process.env.T2T_TRON_SYNC_TOKEN,
    receiver: process.env.T2T_TRON_RECEIVER_ADDRESS,
    apiKey: process.env.TRONGRID_API_KEY
  };

  process.env.T2T_TRON_SYNC_TOKEN = "test-only-secret";
  process.env.T2T_TRON_RECEIVER_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.TRONGRID_API_KEY = "test-only-api-key";

  let statusCode;
  let responseBody;
  let cursor = null;
  let duplicateInsertAttempts = 0;
  let lastSeenUpdates = 0;
  let cursorAdvances = 0;
  let commits = 0;
  let releaseCalls = 0;
  let transferTimestamp = null;

  const txid = "b".repeat(64);
  const receiver = process.env.T2T_TRON_RECEIVER_ADDRESS;
  const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const senderAddress = normalizeTronAddress("41" + "22".repeat(20));
  const rawAmount = "1250000";

  const client = {
    async query(sql, params = []) {
      const q = sql.trim();

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("ON CONFLICT (receiver_address) DO NOTHING")) {
        cursor ??= params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_token = $2::uuid")) {
        return { rowCount: 1, rows: [{ receiver_address: receiver }] };
      }

      if (q.includes("SET lease_token = NULL")) {
        releaseCalls++;
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET lease_until = NOW()")) {
        return { rowCount: 1, rows: [{ receiver_address: receiver }] };
      }

      if (q.startsWith("SELECT last_completed_timestamp")) {
        return { rowCount: 1, rows: [{ last_completed_timestamp: cursor }] };
      }

      if (q.startsWith("INSERT INTO public.tron_usdt_deposits")) {
        duplicateInsertAttempts++;
        assert.match(q, /ON CONFLICT \(transaction_id, event_index\) DO NOTHING/);
        return { rowCount: 0, rows: [] };
      }

      if (q.startsWith("UPDATE public.tron_usdt_deposits") &&
          q.includes("SET last_seen_at = NOW()")) {
        lastSeenUpdates++;
        assert.deepEqual(params, [txid, 0]);
        return { rowCount: 1, rows: [] };
      }

      if (q.startsWith("INSERT INTO public.tron_usdt_sync_state") &&
          q.includes("last_completed_timestamp, updated_at")) {
        cursorAdvances++;
        cursor = params[1];
        return { rowCount: 1, rows: [] };
      }

      if (q === "COMMIT") commits++;
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  const testHandler = createHandler({
    receiverResolver: async () => process.env.T2T_TRON_RECEIVER_ADDRESS,
    jwtFactory: () => "test-only-jwt",
    poolProvider: () => ({ connect: async () => client }),
    fetchImpl: async input => {
      const url = new URL(String(input));

      if (url.pathname.includes("/transactions/") &&
          url.pathname.endsWith("/events")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              transaction_id: txid,
              event_index: 0,
              block_timestamp: transferTimestamp,
              contract_address: contract,
              event_name: "Transfer",
              result: {
                from: senderAddress,
                to: receiver,
                value: rawAmount
              },
              success: true
            }],
            meta: {}
          })
        };
      }

      if (url.pathname.includes("/accounts/") &&
          url.pathname.endsWith("/transactions/trc20")) {
        transferTimestamp = Number(url.searchParams.get("min_timestamp")) + 1000;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              transaction_id: txid,
              from: senderAddress,
              to: receiver,
              token_info: { address: contract },
              value: rawAmount,
              block_timestamp: transferTimestamp
            }],
            meta: {}
          })
        };
      }

      throw new Error("Unexpected test provider URL: " + url.pathname);
    }
  });

  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    await testHandler({
      method: "POST",
      headers: { authorization: "Bearer test-only-secret" }
    }, res);

    assert.equal(statusCode, 200);
    assert.equal(duplicateInsertAttempts, 1);
    assert.equal(lastSeenUpdates, 1);
    assert.equal(responseBody.new_events, 0);
    assert.equal(responseBody.auto_approval, false);
    assert.ok(cursorAdvances > 0);
    assert.ok(commits > 0);
    assert.equal(releaseCalls, 1);
  } finally {
    for (const [key, value] of Object.entries({
      T2T_TRON_SYNC_TOKEN: saved.token,
      T2T_TRON_RECEIVER_ADDRESS: saved.receiver,
      TRONGRID_API_KEY: saved.apiKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


const VALID_RECEIVER = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

test("receiver resolver uses configured central T2T wallet without merchant mapping", async () => {
  assert.equal(await resolveActiveReceiver(null, {
    T2T_TRON_RECEIVER_ADDRESS: VALID_RECEIVER
  }), VALID_RECEIVER);
});

test("receiver resolver fails closed when central receiver is missing or malformed", async () => {
  assert.equal(await resolveActiveReceiver(null, {}), null);
  assert.equal(await resolveActiveReceiver(null, {
    T2T_TRON_RECEIVER_ADDRESS: "not-a-tron-address"
  }), null);
});
