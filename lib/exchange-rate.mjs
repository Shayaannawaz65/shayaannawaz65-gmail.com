const PRICE_SCALE = 1_000_000_000_000n;
const MAX_KRAKEN_PRICE_AGE_MS = 30_000;
const MAX_COINGECKO_PRICE_AGE_MS = 120_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const MAX_DIVERGENCE_BPS = 50;
const REQUEST_TIMEOUT_MS = 5_000;

function parsePositiveDecimal(value, label) {
  const text = typeof value === "number" ? String(value) : value;
  if (
    typeof text !== "string" ||
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,12})?$/.test(text)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  const [whole, fraction = ""] = text.split(".");
  const scaled = BigInt(whole) * PRICE_SCALE +
    BigInt((fraction + "0".repeat(12)).slice(0, 12));
  if (scaled <= 0n) throw new Error(`Invalid ${label}`);
  return { scaled, text: scaledToDecimal(scaled) };
}

function scaledToDecimal(value) {
  const whole = value / PRICE_SCALE;
  const fraction = (value % PRICE_SCALE).toString().padStart(12, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function parseKrakenTimestamp(value) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("Invalid Kraken trade timestamp");
  }
  const text = String(value);
  if (!/^[0-9]{10}(?:\.[0-9]{1,9})?$/.test(text)) {
    throw new Error("Invalid Kraken trade timestamp");
  }
  const [seconds, fraction = ""] = text.split(".");
  return Number(seconds) * 1000 + Number((fraction + "000").slice(0, 3));
}

function validateFreshness(timestamp, now, label, maxAgeMs) {
  if (!Number.isSafeInteger(timestamp)) throw new Error(`Invalid ${label} timestamp`);
  const age = now - timestamp;
  if (age < -MAX_FUTURE_SKEW_MS || age > maxAgeMs) {
    throw new Error(`${label} price is stale or has an invalid timestamp`);
  }
}

async function fetchJson(url, { fetchImpl, headers = {} }) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json", ...headers },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response?.ok) throw new Error("Market data provider unavailable");
  const contentType = response.headers?.get?.("content-type") || "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new Error("Invalid market data response");
  }
  return response.json();
}

async function fetchKraken({ fetchImpl }) {
  const url = "https://api.kraken.com/0/public/Trades?pair=USDTUSD";
  const data = await fetchJson(url, { fetchImpl });
  if (!Array.isArray(data?.error) || data.error.length !== 0) {
    throw new Error("Kraken market data error");
  }
  const result = data.result;
  if (!result || typeof result !== "object") {
    throw new Error("Invalid Kraken market data");
  }
  const pairEntries = Object.entries(result).filter(([key, value]) =>
    key !== "last" && Array.isArray(value)
  );
  if (pairEntries.length !== 1 || pairEntries[0][1].length < 1) {
    throw new Error("Kraken USDT/USD market unavailable");
  }
  // Kraken may return several trades and does not guarantee that the first
  // array element is the newest. Select by the provider trade timestamp.
  let newest = null;
  for (const trade of pairEntries[0][1]) {
    if (!Array.isArray(trade) || trade.length < 3) {
      throw new Error("Invalid Kraken trade");
    }
    const timestamp = parseKrakenTimestamp(trade[2]);
    if (!newest || timestamp > newest.timestamp) {
      newest = {
        ...parsePositiveDecimal(trade[0], "Kraken price"),
        timestamp
      };
    }
  }
  if (!newest) throw new Error("Kraken USDT/USD market unavailable");
  return newest;
}

async function fetchCoinGecko({ fetchImpl, env }) {
  const usePro = env.COINGECKO_API_PLAN === "pro";
  const base = usePro
    ? "https://pro-api.coingecko.com/api/v3"
    : "https://api.coingecko.com/api/v3";
  const url = `${base}/simple/price?ids=tether&vs_currencies=usd&include_last_updated_at=true`;
  const apiKey = String(env.COINGECKO_API_KEY || "");
  const headers = apiKey
    ? { [usePro ? "x-cg-pro-api-key" : "x-cg-demo-api-key"]: apiKey }
    : {};
  const data = await fetchJson(url, { fetchImpl, headers });
  const tether = data?.tether;
  if (
    !tether ||
    !Number.isSafeInteger(tether.last_updated_at) ||
    (typeof tether.usd !== "number" && typeof tether.usd !== "string")
  ) {
    throw new Error("Invalid CoinGecko market data");
  }
  return {
    ...parsePositiveDecimal(tether.usd, "CoinGecko price"),
    timestamp: tether.last_updated_at * 1000
  };
}

export function buildValidatedRate({
  kraken,
  coingecko,
  now = Date.now(),
  maxKrakenAgeMs = MAX_KRAKEN_PRICE_AGE_MS,
  maxCoinGeckoAgeMs = MAX_COINGECKO_PRICE_AGE_MS,
  maxDivergenceBps = MAX_DIVERGENCE_BPS
}) {
  if (
    typeof kraken?.scaled !== "bigint" || kraken.scaled <= 0n ||
    typeof coingecko?.scaled !== "bigint" || coingecko.scaled <= 0n
  ) {
    throw new Error("Invalid market price");
  }
  validateFreshness(kraken.timestamp, now, "Kraken", maxKrakenAgeMs);
  validateFreshness(coingecko.timestamp, now, "CoinGecko", maxCoinGeckoAgeMs);

  const difference = kraken.scaled >= coingecko.scaled
    ? kraken.scaled - coingecko.scaled
    : coingecko.scaled - kraken.scaled;
  const sum = kraken.scaled + coingecko.scaled;

  // divergence = absolute difference / arithmetic midpoint, in basis points.
  if (difference * 20_000n > sum * BigInt(maxDivergenceBps)) {
    throw new Error("Market sources diverge beyond allowed threshold");
  }

  // USDT per USD = 1 / average(USD per USDT).
  // Both values use the same 1e12 price scale; preserve the exact rational.
  const rateNumerator = (2n * PRICE_SCALE).toString();
  const rateDenominator = sum.toString();
  const midpointScaled = (sum + 1n) / 2n;

  return {
    rateNumerator,
    rateDenominator,
    metadata: {
      method: "kraken_coingecko_midpoint_v1",
      quoteCurrency: "USD",
      baseCurrency: "USDT",
      krakenPriceUsdPerUsdt: kraken.text,
      krakenTradeAt: kraken.timestamp,
      coingeckoPriceUsdPerUsdt: coingecko.text,
      coingeckoUpdatedAt: coingecko.timestamp,
      referencePriceUsdPerUsdt: scaledToDecimal(midpointScaled),
      observedAt: now,
      maxKrakenAgeMs,
      maxCoinGeckoAgeMs,
      maxFutureSkewMs: MAX_FUTURE_SKEW_MS,
      maxDivergenceBps
    }
  };
}

export async function getValidatedUsdtUsdRate({
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => Date.now()
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable");
  const [kraken, coingecko] = await Promise.all([
    fetchKraken({ fetchImpl }),
    fetchCoinGecko({ fetchImpl, env })
  ]);
  // Capture the observation time after both providers respond, not before
  // network latency. This timestamp is then included in the signed quote.
  const observedAt = typeof now === "function" ? now() : now;
  return buildValidatedRate({ kraken, coingecko, now: observedAt });
}

export const RATE_LIMITS = Object.freeze({
  maxKrakenAgeMs: MAX_KRAKEN_PRICE_AGE_MS,
  maxCoinGeckoAgeMs: MAX_COINGECKO_PRICE_AGE_MS,
  maxFutureSkewMs: MAX_FUTURE_SKEW_MS,
  maxDivergenceBps: MAX_DIVERGENCE_BPS
});
