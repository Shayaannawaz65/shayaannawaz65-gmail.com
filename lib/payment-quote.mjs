import crypto from "node:crypto";

const USDT_SCALE = 1_000_000n;
const CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";


export function buildPaymentQuoteCanonical({
  quoteId,
  terminalId,
  invoiceReference,
  amountUsdCents,
  rateNumerator,
  rateDenominator,
  expiresAt,
  rateMetadata
}) {
  const m = rateMetadata;
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

  return [
    "T2T_EXCHANGE_QUOTE_V2",
    quoteId,
    terminalId,
    invoiceReference,
    amountUsdCents,
    String(rateNumerator),
    String(rateDenominator),
    expiresAt,
    "TRON",
    CONTRACT,
    m.method,
    m.quoteCurrency,
    m.baseCurrency,
    m.krakenPriceUsdPerUsdt,
    m.krakenTradeAt,
    m.coingeckoPriceUsdPerUsdt,
    m.coingeckoUpdatedAt,
    m.referencePriceUsdPerUsdt,
    m.observedAt,
    m.maxAgeMs,
    m.maxDivergenceBps
  ].join(String.fromCharCode(10));
}

export function calculateUsdtRaw(amountUsdCents, numerator, denominator) {
  if (!Number.isSafeInteger(amountUsdCents) || amountUsdCents <= 0) {
    throw new Error("Invalid USD amount");
  }

  if (
    !/^[1-9][0-9]{0,17}$/.test(String(numerator)) ||
    !/^[1-9][0-9]{0,17}$/.test(String(denominator))
  ) {
    throw new Error("Invalid quote rate");
  }

  const value = BigInt(amountUsdCents) * BigInt(numerator) * USDT_SCALE;
  const divisor = 100n * BigInt(denominator);
  const raw = (value + divisor / 2n) / divisor;

  if (raw <= 0n || raw >= 10n ** 78n) {
    throw new Error("Calculated amount out of range");
  }

  return raw.toString();
}

export function verifyPaymentQuote({
  quote,
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
    quoteId, rateNumerator, rateDenominator, rateMetadata,
    expiresAt, signature
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

  const canonical = buildPaymentQuoteCanonical({
    quoteId,
    terminalId,
    invoiceReference,
    amountUsdCents,
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
    amountUsdCents,
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
