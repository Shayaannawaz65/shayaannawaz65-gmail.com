import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler } from "../lib/routes/console/payment-orders.mjs";
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
  maxKrakenAgeMs: 30000,
  maxCoinGeckoAgeMs: 120000,
  maxFutureSkewMs: 5000,
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
    clientId: "merchant-client-001",
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

function mockPool({ trusted = true, authorized = true } = {}) {
  const state = { queries: [], committed: false, inserted: false };

  return {
    state,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql.includes("INSERT INTO public.t2t_s2s_rate_limits")) {
            return { rowCount: 1, rows: [{ request_count: 1 }] };
          }

          state.queries.push({ sql, params });

          if (sql.includes("SELECT c.client_id, c.client_type")) {
            return trusted
              ? {
                  rowCount: 1,
                  rows: [{
                    client_id: "merchant-client-001",
                    client_type: "POS",
                    public_key_base64: publicKeyBase64
                  }]
                }
              : { rowCount: 0, rows: [] };
          }

          if (sql.includes("SELECT t.terminal_id")) {
            return trusted && authorized
              ? { rowCount: 1, rows: [{ terminal_id: terminalId }] }
              : { rowCount: 0, rows: [] };
          }

          if (sql.includes("INSERT INTO public.t2t_s2s_request_nonces")) {
            return { rowCount: 1, rows: [] };
          }

          if (sql.includes("UPDATE public.t2t_payment_orders")) {
            return { rowCount: 1, rows: [] };
          }

          if (sql.includes("INSERT INTO public.t2t_payment_orders")) {
            state.inserted = true;
            return {
              rowCount: 1,
              rows: [{
                order_id: "00000000-0000-4000-8000-000000000001",
                invoice_reference: params[3],
                amount_usd_cents: params[4],
                amount_usdt_raw: params[5],
                receiver_address: params[6],
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
  T2T_TRON_RECEIVER_ADDRESS: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  T2T_EXCHANGE_QUOTE_PUBLIC_KEY: quotePublicKeyBase64,
  NOWPAYMENTS_API_KEY: "test-api-key",
  NOWPAYMENTS_IPN_SECRET: "test-ipn-secret",
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://payments.example.test/api/nowpayments/ipn"
};

function signedHeaders(body, signatureOverride) {
  const q = body.quote;
  const metadataHash = crypto.createHash("sha256").update(JSON.stringify(q?.rateMetadata ?? null)).digest("hex");
  const canonical = ["T2T_S2S_PAYMENT_ORDER_V2", keyId, "merchant-client-001", body.terminalId || "", body.timestamp, body.nonce, body.invoiceReference, String(body.amountUsdCents), body.amountUsdtRaw, body.expiresInSeconds, String(q?.quoteId || ""), String(q?.rateNumerator || ""), String(q?.rateDenominator || ""), String(q?.expiresAt || ""), String(q?.signature || ""), metadataHash].join("\n");
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

  assert.equal(res.statusCode, 401, JSON.stringify(res.body));
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
  const body = makeBody();

  await createHandler({
    poolProvider: () => pool,
    env,
    now: () => now,
    randomBytes: size => Buffer.alloc(size, 7),
    sdkProvider: () => ({
      raw: {
        async createPayment(input) {
          assert.equal(input.price_amount, 12.5);
          assert.equal(input.price_currency, "usd");
          assert.equal(input.pay_amount, "12.501250");
          assert.equal(input.pay_currency, "usdttrc20");
          assert.equal(input.order_id, "00000000-0000-4000-8000-000000000001");
          assert.equal(input.ipn_callback_url, env.NOWPAYMENTS_IPN_CALLBACK_URL);
          return {
            payment_id: "np-payment-test-001",
            payment_status: "waiting",
            order_id: "00000000-0000-4000-8000-000000000001",
            price_currency: "usd",
            pay_currency: "usdttrc20",
            price_amount: 12.5,
            pay_amount: 12.50125,
            pay_address: "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"
          };
        }
      }
    })
  })({ method: "POST", headers: signedHeaders(body), body }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, "PENDING");
  assert.equal("merchantId" in res.body, false);
  assert.equal("receiverId" in res.body, false);
  assert.equal(res.body.currency, "USD");
  assert.equal(res.body.amountUsdCents, "1250");
  assert.equal(res.body.amountUsdtRaw, "12501250");
  assert.equal(res.body.provider, "NOWPAYMENTS");
  assert.equal(res.body.providerPaymentId, "np-payment-test-001");
  assert.equal(res.body.payCurrency, "usdttrc20");
  assert.equal(res.body.payAddress, "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8");
  assert.equal(res.body.payAmount, "12.501250");
  assert.equal(res.body.paymentNetwork, "TRON-TRC20");
  assert.match(res.body.paymentStatusUrl, /api\/console\/payment-status\?token=/);
  assert.equal(pool.state.inserted, true);
  assert.equal(pool.state.committed, true);

  const insert = pool.state.queries.find(q =>
    q.sql.includes("INSERT INTO public.t2t_payment_orders")
  );
  assert.ok(insert);
  assert.equal(insert.params[7].length, 64);
  assert.equal(insert.params[0], "merchant-client-001");
  assert.equal(insert.params[2], keyId);
  assert.equal(insert.params[6].includes("070707"), false);
  assert.deepEqual(JSON.parse(insert.params[11]), quoteMetadata);
});


test("rejects an active terminal not authorized for the S2S key", async () => {
  const pool = mockPool({ trusted: true, authorized: false });
  const res = makeResponse();
  const body = makeBody();

  await createHandler({
    poolProvider: () => pool,
    env,
    now: () => now
  })({
    method: "POST",
    headers: signedHeaders(body),
    body
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(pool.state.inserted, false);
  assert.ok(pool.state.queries.some(q =>
    q.sql.includes("JOIN public.t2t_s2s_key_terminals auth")
  ));
});
