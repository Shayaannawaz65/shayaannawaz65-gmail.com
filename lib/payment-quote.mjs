import crypto from "node:crypto";

const USDT_SCALE = 1_000_000n;
const CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const UINT256_MAX =
  115792089237316195423570985008687907853269984665640564039457584007913129639935n;

function normalizeUsdCents(value) {
  const cents = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : value;

  if (
    typeof cents !== "string" ||
    !/^[1-9][0-9]{0,77}$/.test(cents)
  ) {
    throw new Error("Invalid USD amount");
  }

  return cents;
}

function validateRate(value) {
  const rate = String(value ?? "");
  if (!/^[1-9][0-9]{0,17}$/.test(rate)) {
    throw new Error("Invalid quote rate");
  }
  return rate;
}

function validateRateMetadata(m) {
  if (
    !m ||
    m.method !== "kraken_coingecko_midpoint_v1" ||
    m.quoteCurrency !== "USD" ||
    m.baseCurrency !== "USDT" ||
    typeof m.krakenPriceUsdPerUsdt !== "string" ||
    !Number.isSafeInteger(m.krakenTradeAt) ||
    typeof m.coingeckoPriceUsdPerUsdt !== "string" ||
    !Number.isSafeInteger(m.coingeckoUpdatedAt) ||
    typeof m.referencePriceUsdPerUsdt !== "string" ||
    !Number.isSafeInteger(m.observedAt) ||
    m.maxAgeMs !== 30_000 ||
    m.maxDivergenceBps !== 50
  ) {
    throw new Error("Invalid market-rate metadata");
  }
}

export function buildPaymentQuoteCanonical({
  quoteId,
  clientId,
  terminalId,
  invoiceReference,
  amountUsdCents,
  rateNumerator,
  rateDenominator,
  expiresAt,
  rateMetadata
}) {
  validateRateMetadata(rateMetadata);

  // New quotes bind to the registered S2S client. terminalId remains
  // supported as a compatibility identity for existing POS quote tests.
  const principalId = clientId ?? terminalId;
  if (typeof principalId !== "string" || !principalId) {
    throw new Error("S2S client identity required");
  }

  const cents = normalizeUsdCents(amountUsdCents);
  const numerator = validateRate(rateNumerator);
  const denominator = validateRate(rateDenominator);

  return [
    "T2T_EXCHANGE_QUOTE_V3",
    principalId,
    invoiceReference,
    cents,
    numerator,
    denominator,
    expiresAt,
    "TRON",
    CONTRACT,
    rateMetadata.method,
    rateMetadata.quoteCurrency,
    rateMetadata.baseCurrency,
    rateMetadata.krakenPriceUsdPerUsdt,
    rateMetadata.krakenTradeAt,
    rateMetadata.coingeckoPriceUsdPerUsdt,
    rateMetadata.coingeckoUpdatedAt,
    rateMetadata.referencePriceUsdPerUsdt,
    rateMetadata.observedAt,
    rateMetadata.maxAgeMs,
    rateMetadata.maxDivergenceBps
  ].join("\n");
}

export function calculateUsdtRaw(amountUsdCents, numerator, denominator) {
  const cents = normalizeUsdCents(amountUsdCents);
  const rateN = validateRate(numerator);
  const rateD = validateRate(denominator);

  const value = BigInt(cents) * BigInt(rateN) * USDT_SCALE;
  const divisor = 100n * BigInt(rateD);
  const raw = (value + divisor / 2n) / divisor;

  if (raw <= 0n || raw > UINT256_MAX) {
    throw new Error("Calculated amount exceeds TRC20 uint256 range");
  }

  return raw.toString();
}

export function verifyPaymentQuote({
  quote,
  clientId,
  terminalId,
  invoiceReference,
  amountUsdCents,
  amountUsdtRaw,
  now = Date.now(),
  publicKeyBase64
}) {
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
    throw new Error("Trusted quote required");
  }

  const {
    quoteId,
    rateNumerator,
    rateDenominator,
    rateMetadata,
    expiresAt,
    signature
  } = quote;

  if (
    typeof quoteId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(quoteId) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 30_000 ||
    typeof signature !== "string" ||
    signature.length < 40 ||
    signature.length > 1024 ||
    typeof publicKeyBase64 !== "string" ||
    !publicKeyBase64
  ) {
    throw new Error("Invalid or expired quote");
  }

  const cents = normalizeUsdCents(amountUsdCents);
  if (
    typeof amountUsdtRaw !== "string" ||
    !/^[1-9][0-9]{0,77}$/.test(amountUsdtRaw) ||
    BigInt(amountUsdtRaw) > UINT256_MAX
  ) {
    throw new Error("Invalid USDT raw amount");
  }

  const canonical = buildPaymentQuoteCanonical({
    quoteId,
    clientId,
    terminalId,
    invoiceReference,
    amountUsdCents: cents,
    rateNumerator,
    rateDenominator,
    expiresAt,
    rateMetadata
  });

  let valid = false;

  try {
    const sig = Buffer.from(signature, "base64");
    if (sig.toString("base64") !== signature) {
      throw new Error("Invalid signature encoding");
    }

    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki"
    });

    valid = crypto.verify(
      "sha256",
      Buffer.from(canonical, "utf8"),
      publicKey,
      sig
    );
  } catch {
    valid = false;
  }

  if (!valid) throw new Error("Untrusted exchange-rate quote");

  const freshnessTimes = [
    rateMetadata.krakenTradeAt,
    rateMetadata.coingeckoUpdatedAt,
    rateMetadata.observedAt
  ];

  if (freshnessTimes.some(timestamp =>
    !Number.isSafeInteger(timestamp) ||
    now - timestamp > 30_000 ||
    timestamp - now > 5_000
  )) {
    throw new Error("Market-rate quote is stale");
  }

  const calculated = calculateUsdtRaw(
    cents,
    rateNumerator,
    rateDenominator
  );

  if (calculated !== amountUsdtRaw) {
    throw new Error("USDT amount does not match trusted quote");
  }

  return {
    quoteId,
    rateNumerator: String(rateNumerator),
    rateDenominator: String(rateDenominator),
    rateMetadata,
    expiresAt
  };
}
