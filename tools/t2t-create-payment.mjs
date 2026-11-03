import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const API = "https://t2t-tron-usdt-aili-qw8y7s8jm-shayaan-enterprise.vercel.app";
const CLIENT_ID = "T2T_INTERNAL";
const KEY_ID = "t2t-internal-key-20261101";
const PRIVATE_KEY_PATH = ".t2t-internal-private.pem";
const CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_SCALE = 1_000_000n;

const [invoiceReference, amountUsdCents, expiryArg] = process.argv.slice(2);
const expiresInSeconds = Number(expiryArg || "1800");

if (
  !invoiceReference ||
  !/^[A-Za-z0-9._/-]{1,120}$/.test(invoiceReference) ||
  !amountUsdCents ||
  !/^[1-9][0-9]{0,77}$/.test(amountUsdCents) ||
  !Number.isSafeInteger(expiresInSeconds) ||
  expiresInSeconds < 60 ||
  expiresInSeconds > 86400
) {
  console.error("Usage: node tools/t2t-create-payment.mjs <invoice-reference> <USD-cents> [expiry-seconds]");
  console.error("Example: node tools/t2t-create-payment.mjs INV-1001 2500 1800");
  process.exit(2);
}

if (!fs.existsSync(PRIVATE_KEY_PATH)) {
  console.error("Local P-256 private key file is missing.");
  process.exit(2);
}

const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_PATH));

function nonce() {
  return crypto.randomBytes(32).toString("hex");
}

function sign(canonical) {
  return crypto.sign("sha256", Buffer.from(canonical, "utf8"), privateKey).toString("base64");
}

async function post(path, body, signature) {
  const result = spawnSync("vercel", [
    "curl", path,
    "--deployment", API,
    "--yes",
    "--",
    "--request", "POST",
    "--header", "content-type: application/json",
    "--header", `x-t2t-key-id: ${KEY_ID}`,
    "--header", `x-t2t-signature: ${signature}`,
    "--data-binary", "@-"
  ], {
    input: JSON.stringify(body),
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });

  if (result.error) throw result.error;

  const output = (result.stdout || "").trim();
  const jsonStart = output.indexOf("{");
  const text = jsonStart >= 0 ? output.slice(jsonStart) : output;

  let data;
  try { data = JSON.parse(text); }
  catch { data = { responseText: text, stderr: result.stderr }; }

  if (result.status !== 0) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  // Step 1: request a signed, short-lived USD/USDT quote.
  const quoteTimestamp = Date.now();
  const quoteNonce = nonce();

  const quoteRequest = {
    timestamp: quoteTimestamp,
    nonce: quoteNonce,
    invoiceReference,
    amountUsdCents
  };

  const quoteCanonical = [
    "T2T_S2S_PAYMENT_QUOTE_V2",
    KEY_ID,
    CLIENT_ID,
    "",
    quoteTimestamp,
    quoteNonce,
    invoiceReference,
    amountUsdCents
  ].join("\n");

  const quoteResponse = await post(
    "/api/console/payment-quote",
    quoteRequest,
    sign(quoteCanonical)
  );

  const quote = quoteResponse.quote;
  if (!quote) throw new Error("Quote response did not contain a quote.");

  // Match the server's exact integer-only USDT conversion.
  const numerator = BigInt(quote.rateNumerator);
  const denominator = BigInt(quote.rateDenominator);
  if (numerator <= 0n || denominator <= 0n) {
    throw new Error("Quote contains an invalid exchange rate.");
  }

  const product = BigInt(amountUsdCents) * numerator * USDT_SCALE;
  const divisor = 100n * denominator;
  const amountUsdtRaw = ((product + divisor / 2n) / divisor).toString();

  // Step 2: sign the payment order with the registered T2T_INTERNAL key.
  const orderTimestamp = Date.now();
  const orderNonce = nonce();

  const orderRequest = {
    timestamp: orderTimestamp,
    nonce: orderNonce,
    invoiceReference,
    amountUsdCents,
    amountUsdtRaw,
    expiresInSeconds,
    quote
  };

  const metadataHash = crypto.createHash("sha256")
    .update(JSON.stringify(quote.rateMetadata))
    .digest("hex");

  const orderCanonical = [
    "T2T_S2S_PAYMENT_ORDER_V2",
    KEY_ID,
    CLIENT_ID,
    "",
    orderTimestamp,
    orderNonce,
    invoiceReference,
    amountUsdCents,
    amountUsdtRaw,
    expiresInSeconds,
    String(quote.quoteId || ""),
    String(quote.rateNumerator || ""),
    String(quote.rateDenominator || ""),
    String(quote.expiresAt || ""),
    String(quote.signature || ""),
    metadataHash
  ].join("\n");

  const orderResponse = await post(
    "/api/console/payment-orders",
    orderRequest,
    sign(orderCanonical)
  );

  console.log(JSON.stringify(orderResponse, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
