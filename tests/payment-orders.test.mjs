import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler } from "../api/console/payment-orders.mjs";
import {
  buildPaymentQuoteCanonical,
  calculateUsdtRaw
} from "../lib/payment-quote.mjs";

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
const keyId = "merchant-key-test-001";
const nonce = "abcdef0123456789abcdef0123456789";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});

const publicKeyBase64 = publicKey.export({
  format: "der",
  type: "spki"
}).toString("base64");

const quoteKeys = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});
const quotePublicKeyBase64 = quoteKeys.publicKey.export({
  format: "der",
  type: "spki"
}).toString("base64");

const quoteRateNumerator = "2000000000000";
const quoteRateDenominator = "1999800000000";
const quoteMetadata = {
  method: "kraken_coingecko_midpoint_v1",
  quoteCurrency: "USD",
  baseCurrency: "USDT",
  krakenPriceUsdPerUsdt: "0.9998",
  krakenTradeAt: now - 1000,
  coingeckoPriceUsdPerUsdt: "1",
  coingeckoUpdatedAt: now - 2000,
  referencePriceUsdPerUsdt: "0.9999",
  observedAt: now,
  maxAgeMs: 30000,
  maxDivergenceBps: 50
};

function makeBody(overrides = {}) {
  const fields = {
    terminalId,
    timestamp: now,
    nonce,
    invoiceReference: "INV-TEST-001",
    amountUsdCents: 1250,
    amountUsdtRaw: calculateUsdtRaw(
      1250, quoteRateNumerator, quoteRateDenominator
    ),
    expiresInSeconds: 900
  };

  const quoteId = "quote-test-id-00000001";
  const quoteExpiresAt = now + 30_000;
  const quoteCanonical = buildPaymentQuoteCanonical({
    quoteId,
    terminalId: fields.terminalId,
    invoiceReference: fields.invoiceReference,
    amountUsdCents: fields.amountUsdCents,
    rateNumerator: quoteRateNumerator,
    rateDenominator: quoteRateDenominator,
    expiresAt: quoteExpiresAt,
    rateMetadata: quoteMetadata
  });

  return {
    ...fields,
    quote: {
      quoteId,
      rateNumerator: quoteRateNumerator,
      rateDenominator: quoteRateDenominator,
      rateMetadata: quoteMetadata,
      expiresAt: quoteExpiresAt,
      signature: crypto.sign(
        "sha256",
        Buffer.from(quoteCanonical, "utf8"),
        quoteKeys.privateKey
      ).toString("base64")
    },
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

          if (sql.includes("SELECT t.terminal_id")) {
            return trusted
              ? {
                  rowCount: 1,
                  rows: [{
                    merchant_public_key_base64: publicKeyBase64
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

const env = {
  T2T_PAYMENT_BASE_URL: "https://payments.example.test",
  T2T_TRON_RECEIVER_ADDRESS: "TExAW9464LvbWmAsbcmNhvHQwawUn8rmN2",
  T2T_EXCHANGE_QUOTE_PUBLIC_KEY: quotePublicKeyBase64
};

function signedHeaders(body, signatureOverride) {
  const q = body.quote;
  const metadataHash = crypto.createHash("sha256").update(JSON.stringify(q?.rateMetadata ?? null)).digest("hex");
  const canonical = ["T2T_S2S_PAYMENT_ORDER_V1", keyId, body.terminalId, body.timestamp, body.nonce, body.invoiceReference, body.amountUsdCents, body.amountUsdtRaw, body.expiresInSeconds, String(q?.quoteId || ""), String(q?.rateNumerator || ""), String(q?.rateDenominator || ""), String(q?.expiresAt || ""), String(q?.signature || ""), metadataHash].join("\n");
  return {"x-t2t-key-id":keyId,"x-t2t-signature":signatureOverride || crypto.sign("sha256",Buffer.from(canonical),privateKey).toString("base64")};
}

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
  })({ method: "POST", headers: signedHeaders(makeBody({ amountUsdCents: 0 })), body: makeBody({ amountUsdCents: 0 }) }, res);

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
  })({ method: "POST", headers: signedHeaders(makeBody()), body: makeBody() }, res);

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
    headers: signedHeaders(makeBody(), Buffer.alloc(64, 1).toString("base64")),
    body: makeBody()
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
  assert.equal("merchantId" in res.body, false);
  assert.equal("receiverId" in res.body, false);
  assert.equal(res.body.currency, "USD");
  assert.equal(res.body.amountUsdCents, 1250);
  assert.equal(res.body.amountUsdtRaw, "12501250");
  assert.match(res.body.paymentUrl, /^https:\/\/payments\.example\.test\/pay\.html\?token=[A-Za-z0-9_-]{43}$/);
  assert.equal(pool.state.inserted, true);
  assert.equal(pool.state.committed, true);

  const insert = pool.state.queries.find(q =>
    q.sql.includes("INSERT INTO public.t2t_payment_orders")
  );
  assert.ok(insert);
  assert.equal(insert.params[5].length, 64);
  assert.equal(insert.params[5].includes("070707"), false);
  assert.deepEqual(JSON.parse(insert.params[9]), quoteMetadata);
});
