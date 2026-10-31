import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler } from "../api/console/payment-quote-issuer.mjs";

const NOW = 1_800_000_000_000;
const terminalId = "OFFLINE-201.3-001";
const keyId = "merchant-key-test-001";
const invoiceReference = "INV-QUOTE-001";
const amountUsdCents = 1250;
const nonce = "abcdef0123456789abcdef0123456789";

const terminalKeys = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});
const quoteKeys = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});

const terminalPublicKeyBase64 = terminalKeys.publicKey.export({
  format: "der",
  type: "spki"
}).toString("base64");

const quotePublicKeyBase64 = quoteKeys.publicKey.export({
  format: "der",
  type: "spki"
}).toString("base64");

const env = {
  T2T_EXCHANGE_QUOTE_PRIVATE_KEY: quoteKeys.privateKey.export({
    format: "der",
    type: "pkcs8"
  }).toString("base64"),
  T2T_EXCHANGE_QUOTE_PUBLIC_KEY: quotePublicKeyBase64
};

const marketRate = {
  rateNumerator: "2000000000000",
  rateDenominator: "1999800000000",
  metadata: {
    method: "kraken_coingecko_midpoint_v1",
    quoteCurrency: "USD",
    baseCurrency: "USDT",
    krakenPriceUsdPerUsdt: "0.9998",
    krakenTradeAt: NOW - 1000,
    coingeckoPriceUsdPerUsdt: "1",
    coingeckoUpdatedAt: NOW - 2000,
    referencePriceUsdPerUsdt: "0.9999",
    observedAt: NOW,
    maxAgeMs: 30000,
    maxDivergenceBps: 50
  }
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

function makeRequest(overrides = {}) {
  const body = {
    terminalId,
    timestamp: NOW,
    nonce,
    invoiceReference,
    amountUsdCents,
    ...overrides
  };

  const canonical = [
    "T2T_S2S_PAYMENT_QUOTE_V1",
    keyId,
    body.terminalId,
    body.timestamp,
    body.nonce,
    body.invoiceReference,
    body.amountUsdCents
  ].join("\n");
  const signature = crypto.sign("sha256", Buffer.from(canonical, "utf8"), terminalKeys.privateKey).toString("base64");

  return { method: "POST", headers: { "x-t2t-key-id": keyId, "x-t2t-signature": signature }, body };
}

function mockPool({ duplicateNonce = false } = {}) {
  const queries = [];
  let connectCount = 0;
  let releaseCount = 0;
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });

      if (sql.includes("SELECT public_key_base64")) {
        return {
          rowCount: 1,
          rows: [{ public_key_base64: terminalPublicKeyBase64 }]
        };
      }

      if (sql.includes("INSERT INTO public.t2t_s2s_request_nonces")) {
        if (duplicateNonce) {
          const error = new Error("duplicate nonce");
          error.code = "23505";
          throw error;
        }
        return { rowCount: 1, rows: [] };
      }

      return { rowCount: 0, rows: [] };
    },
    release() { releaseCount += 1; }
  };

  return {
    queries,
    get connectCount() { return connectCount; },
    get releaseCount() { return releaseCount; },
    poolProvider: () => ({ connect: async () => { connectCount += 1; return client; } })
  };
}

test("quote issuer only allows POST", async () => {
  const res = response();
  await createHandler({
    poolProvider: () => {
      throw new Error("Database must not be accessed");
    }
  })({ method: "GET" }, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
});

test("quote issuer fails closed when signing/rate configuration is missing", async () => {
  let connected = false;
  const res = response();

  await createHandler({
    poolProvider: () => {
      connected = true;
      throw new Error("Database must not be accessed");
    },
    env: {},
    now: () => NOW
  })(makeRequest(), res);

  assert.equal(res.statusCode, 503);
  assert.equal(connected, false);
});

test("issues a signed quote for an authenticated S2S merchant", async () => {
  const db = mockPool();
  const { poolProvider, queries } = db;
  const res = response();
  let releasedBeforeMarket = false;

  await createHandler({
    poolProvider,
    env,
    now: () => NOW,
    randomBytes: () => Buffer.alloc(24, 7),
    rateProvider: async () => {
      releasedBeforeMarket = db.releaseCount === 1;
      return marketRate;
    }
  })(makeRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(releasedBeforeMarket, true, "DB connection must be released before market HTTP calls");
  assert.equal(db.connectCount, 2, "connection must be reacquired after market HTTP calls");
  assert.equal(db.releaseCount, 2, "both DB connections must be released");
  assert.equal(res.body.quote.rateNumerator, marketRate.rateNumerator);
  assert.equal(res.body.quote.rateDenominator, marketRate.rateDenominator);
  assert.deepEqual(res.body.quote.rateMetadata, marketRate.metadata);
  assert.equal(res.body.quote.expiresAt, NOW + 30_000);
  assert.equal(typeof res.body.quote.signature, "string");
  assert.ok(queries.some(q => q.sql === "COMMIT"));
  assert.ok(queries.some(q => q.sql.includes("FOR UPDATE")));
  assert.ok(queries.some(q => q.sql.includes("INSERT INTO public.t2t_s2s_request_nonces")));
});

test("fails closed when market data cannot be validated", async () => {
  const { poolProvider, queries } = mockPool();
  const res = response();

  await createHandler({
    poolProvider,
    env,
    now: () => NOW,
    rateProvider: async () => { throw new Error("stale provider data"); }
  })(makeRequest(), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "Quote service temporarily unavailable");
  assert.ok(!queries.some(q => q.sql === "BEGIN"));
  assert.ok(!queries.some(q => q.sql === "ROLLBACK"));
  assert.ok(!queries.some(q => q.sql.includes("INSERT INTO public.t2t_s2s_request_nonces")));
});

test("rejects an invalid S2S signature before issuing a quote", async () => {
  const { poolProvider, queries } = mockPool();
  const req = makeRequest();
  req.headers["x-t2t-signature"] = crypto.randomBytes(64).toString("base64");
  const res = response();

  await createHandler({ poolProvider, env, now: () => NOW, rateProvider: async () => marketRate })(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "Invalid S2S signature");
  assert.ok(!queries.some(q => q.sql === "BEGIN"));
  assert.ok(!queries.some(q => q.sql === "COMMIT"));
});

test("rejects a replayed nonce with HTTP 409", async () => {
  const { poolProvider } = mockPool({ duplicateNonce: true });
  const res = response();

  await createHandler({ poolProvider, env, now: () => NOW, rateProvider: async () => marketRate })(
    makeRequest(),
    res
  );

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "Quote request replay rejected");
});
