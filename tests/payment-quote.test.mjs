import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  calculateUsdtRaw,
  verifyPaymentQuote,
  buildPaymentQuoteCanonical
} from "../lib/payment-quote.mjs";

const now = 1_800_000_000_000;
const terminalId = "OFFLINE-201.3-001";
const invoiceReference = "INV-QUOTE-001";
const amountUsdCents = 1250;
const rateNumerator = "2000000000000";
const rateDenominator = "1999800000000";
const amountUsdtRaw = calculateUsdtRaw(
  amountUsdCents, rateNumerator, rateDenominator
);
const rateMetadata = {
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

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});

const publicKeyBase64 = publicKey.export({
  format: "der",
  type: "spki"
}).toString("base64");

function makeQuote(overrides = {}) {
  const quote = {
    quoteId: "quote_test_1234567890",
    rateNumerator,
    rateDenominator,
    rateMetadata: structuredClone(rateMetadata),
    expiresAt: now + 30_000,
    ...overrides
  };

  const canonical = buildPaymentQuoteCanonical({
    quoteId: quote.quoteId,
    terminalId,
    invoiceReference,
    amountUsdCents,
    rateNumerator: quote.rateNumerator,
    rateDenominator: quote.rateDenominator,
    expiresAt: quote.expiresAt,
    rateMetadata: quote.rateMetadata
  });

  quote.signature = crypto.sign(
    "sha256",
    Buffer.from(canonical, "utf8"),
    privateKey
  ).toString("base64");

  return quote;
}

function verify(quote, overrides = {}) {
  return verifyPaymentQuote({
    quote,
    terminalId,
    invoiceReference,
    amountUsdCents,
    amountUsdtRaw,
    now,
    publicKeyBase64,
    ...overrides
  });
}

test("calculates USD-to-USDT raw amount with integer arithmetic", () => {
  assert.equal(calculateUsdtRaw(1250, "1", "1"), "12500000");
  assert.equal(calculateUsdtRaw(100, "99", "100"), "990000");
  assert.equal(amountUsdtRaw, "12501250");
});

test("accepts a valid signed quote with dual-source market audit metadata", () => {
  const result = verify(makeQuote());
  assert.equal(result.quoteId, "quote_test_1234567890");
  assert.equal(result.rateNumerator, rateNumerator);
  assert.equal(result.rateDenominator, rateDenominator);
  assert.equal(result.rateMetadata.method, "kraken_coingecko_midpoint_v1");
});

test("rejects expired quotes", () => {
  assert.throws(
    () => verify(makeQuote({ expiresAt: now })),
    /expired quote/i
  );
});

test("rejects a quote with a modified rate", () => {
  const quote = makeQuote();
  quote.rateNumerator = "2000000000001";
  assert.throws(() => verify(quote), /untrusted exchange-rate quote/i);
});

test("rejects modified source metadata", () => {
  const quote = makeQuote();
  quote.rateMetadata.krakenPriceUsdPerUsdt = "0.95";
  assert.throws(() => verify(quote), /untrusted exchange-rate quote/i);
});

test("rejects a quote whose source observation has become stale", () => {
  const quote = makeQuote({
    rateMetadata: {
      ...rateMetadata,
      krakenTradeAt: now - 30_001
    }
  });
  assert.throws(() => verify(quote), /market-rate quote is stale/i);
});

test("rejects an incorrect USDT amount", () => {
  assert.throws(
    () => verify(makeQuote(), { amountUsdtRaw: "12500001" }),
    /does not match trusted quote/i
  );
});

test("rejects a quote signed for a different invoice", () => {
  assert.throws(
    () => verify(makeQuote(), { invoiceReference: "INV-OTHER-001" }),
    /untrusted exchange-rate quote/i
  );
});

test("rejects a missing quote signing key", () => {
  assert.throws(
    () => verifyPaymentQuote({
      quote: makeQuote(),
      terminalId,
      invoiceReference,
      amountUsdCents,
      amountUsdtRaw,
      now
    }),
    /invalid or expired quote/i
  );
});



test("rejects signed quotes whose expiry exceeds the 30-second policy", () => {
  assert.throws(
    () => verify(makeQuote({ expiresAt: now + 30_001 })),
    /invalid or expired quote/i
  );
});
