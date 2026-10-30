import test from "node:test";
import assert from "node:assert/strict";
import {
  buildValidatedRate,
  getValidatedUsdtUsdRate,
  RATE_LIMITS
} from "../lib/exchange-rate.mjs";

const NOW = 1_800_000_000_000;
const SCALE = 1_000_000_000_000n;

function price(text) {
  const [whole, fraction = ""] = text.split(".");
  const scaled = BigInt(whole) * SCALE +
    BigInt((fraction + "0".repeat(12)).slice(0, 12));
  return { scaled, text };
}

function pair({
  krakenPrice = "0.9998",
  coingeckoPrice = "1.0000",
  krakenAge = 1000,
  coingeckoAge = 2000
} = {}) {
  return {
    kraken: {
      ...price(krakenPrice),
      timestamp: NOW - krakenAge
    },
    coingecko: {
      ...price(coingeckoPrice),
      timestamp: NOW - coingeckoAge
    }
  };
}

function fakeFetch() {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    const isKraken = String(url).includes("kraken.com");
    const payload = isKraken
      ? {
          error: [],
          result: {
            USDTUSD: [
              ["0.9997", "100", NOW / 1000 - 5, "b", "l", ""],
              ["0.9998", "100", NOW / 1000 - 1, "b", "l", ""]
            ],
            last: "123"
          }
        }
      : {
          tether: {
            usd: 1,
            last_updated_at: NOW / 1000 - 2
          }
        };
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => payload
    };
  };
  return { fetchImpl, urls };
}

test("accepts two fresh independent observations and produces exact inverse rate", () => {
  const result = buildValidatedRate({ ...pair(), now: NOW });
  assert.equal(result.rateNumerator, "2000000000000");
  assert.equal(result.rateDenominator, "1999800000000");
  assert.equal(result.metadata.referencePriceUsdPerUsdt, "0.9999");
  assert.equal(result.metadata.maxAgeMs, 30000);
  assert.equal(result.metadata.maxDivergenceBps, 50);
});

test("rejects stale Kraken trade data", () => {
  assert.throws(
    () => buildValidatedRate({
      ...pair({ krakenAge: 30_001 }),
      now: NOW
    }),
    /Kraken price is stale/i
  );
});

test("rejects stale CoinGecko update data", () => {
  assert.throws(
    () => buildValidatedRate({
      ...pair({ coingeckoAge: 30_001 }),
      now: NOW
    }),
    /CoinGecko price is stale/i
  );
});

test("rejects future-dated source observations outside allowed clock skew", () => {
  assert.throws(
    () => buildValidatedRate({
      ...pair({ krakenAge: -5001 }),
      now: NOW
    }),
    /Kraken price is stale/i
  );
});

test("rejects source prices that diverge by more than 0.5 percent", () => {
  assert.throws(
    () => buildValidatedRate({
      ...pair({ krakenPrice: "0.99", coingeckoPrice: "1.00" }),
      now: NOW
    }),
    /diverge beyond allowed threshold/i
  );
});

test("accepts a source spread within the configured divergence boundary", () => {
  const result = buildValidatedRate({
    ...pair({ krakenPrice: "0.995024875622", coingeckoPrice: "1.000" }),
    now: NOW
  });
  assert.equal(result.metadata.maxDivergenceBps, 50);
});

test("rejects zero or malformed source price", () => {
  assert.throws(() => buildValidatedRate({
    kraken: { ...price("0"), timestamp: NOW },
    coingecko: { ...price("1"), timestamp: NOW },
    now: NOW
  }), /invalid/i);
});

test("fetches Kraken trade timestamp and CoinGecko last_updated_at", async () => {
  const { fetchImpl, urls } = fakeFetch();
  const result = await getValidatedUsdtUsdRate({
    fetchImpl,
    env: {},
    now: NOW
  });
  assert.equal(result.metadata.krakenTradeAt, NOW - 1000);
  assert.equal(result.metadata.krakenPriceUsdPerUsdt, "0.9998");
  assert.equal(result.metadata.coingeckoUpdatedAt, NOW - 2000);
  assert.equal(urls.length, 2);
  assert.ok(urls.some(url => url.includes("/Trades?pair=USDTUSD")));
  assert.ok(urls.some(url => url.includes("include_last_updated_at=true")));
});


test("captures observedAt only after both market providers finish", async () => {
  let completed = 0;
  const { fetchImpl } = fakeFetch();
  const trackedFetch = async (...args) => {
    const result = await fetchImpl(...args);
    completed += 1;
    return result;
  };
  const result = await getValidatedUsdtUsdRate({
    fetchImpl: trackedFetch,
    env: {},
    now: () => {
      assert.equal(completed, 2, "both providers must have responded before observedAt is captured");
      return NOW;
    }
  });
  assert.equal(result.metadata.observedAt, NOW);
});

test("fails closed when a provider returns a non-success response", async () => {
  await assert.rejects(
    getValidatedUsdtUsdRate({
      fetchImpl: async () => ({
        ok: false,
        headers: { get: () => "application/json" },
        json: async () => ({})
      }),
      env: {},
      now: NOW
    }),
    /provider unavailable/i
  );
});

test("keeps the approved freshness and divergence guardrails", () => {
  assert.deepEqual(RATE_LIMITS, {
    maxAgeMs: 30000,
    maxFutureSkewMs: 5000,
    maxDivergenceBps: 50
  });
});
