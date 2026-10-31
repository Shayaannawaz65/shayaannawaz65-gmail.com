import crypto from "node:crypto";
import pg from "pg";
import { getValidatedUsdtUsdRate } from "../../lib/exchange-rate.mjs";
import { buildPaymentQuoteCanonical } from "../../lib/payment-quote.mjs";

const { Pool } = pg;
const TERMINAL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NONCE_RE = /^[a-f0-9]{32,64}$/i;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const INVOICE_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const QUOTE_TTL_MS = 30 * 1000;
let pool;

function getPool() {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL_UNPOOLED ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL;

    if (!connectionString || connectionString.includes("[SENSITIVE]")) {
      throw new Error("Database configuration missing");
    }

    const parsed = new URL(connectionString);
    if (parsed.searchParams.get("sslmode") === "require") {
      parsed.searchParams.set("sslmode", "verify-full");
    }

    pool = new Pool({
      connectionString: parsed.toString(),
      ssl: { rejectUnauthorized: true },
      max: 2,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000
    });
  }
  return pool;
}

function loadQuoteConfig(env) {
  const privateKeyBase64 = String(env.T2T_EXCHANGE_QUOTE_PRIVATE_KEY || "");
  const publicKeyBase64 = String(env.T2T_EXCHANGE_QUOTE_PUBLIC_KEY || "");

  if (!privateKeyBase64 || !publicKeyBase64) {
    throw new Error("Quote signing configuration missing");
  }

  const privateDer = Buffer.from(privateKeyBase64, "base64");
  const publicDer = Buffer.from(publicKeyBase64, "base64");

  if (
    privateDer.toString("base64") !== privateKeyBase64 ||
    publicDer.toString("base64") !== publicKeyBase64
  ) {
    throw new Error("Invalid quote key encoding");
  }

  const privateKey = crypto.createPrivateKey({
    key: privateDer,
    format: "der",
    type: "pkcs8"
  });
  const publicKey = crypto.createPublicKey({
    key: publicDer,
    format: "der",
    type: "spki"
  });

  const derivedPublic = crypto.createPublicKey(privateKey).export({
    format: "der",
    type: "spki"
  });
  const configuredPublic = publicKey.export({
    format: "der",
    type: "spki"
  });

  if (!derivedPublic.equals(configuredPublic)) {
    throw new Error("Quote signing key pair mismatch");
  }

  return { privateKey };
}


export function createHandler({
  poolProvider = getPool,
  env = process.env,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  rateProvider = getValidatedUsdtUsdRate
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Invalid quote request" });
    }

    const terminalId = String(body.terminalId || "");
    const timestamp = Number(body.timestamp);
    const nonce = String(body.nonce || "");
    const invoiceReference = String(body.invoiceReference || "");
    const amountUsdCents = body.amountUsdCents;
    const keyId = String(req.headers?.["x-t2t-key-id"] || "");
    const signatureB64 = String(req.headers?.["x-t2t-signature"] || "");

    if (
      !TERMINAL_ID_RE.test(terminalId) ||
      !KEY_ID_RE.test(keyId) ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(now() - timestamp) > MAX_CLOCK_SKEW_MS ||
      !NONCE_RE.test(nonce) ||
      !INVOICE_RE.test(invoiceReference) ||
      !Number.isSafeInteger(amountUsdCents) ||
      amountUsdCents <= 0 ||
      signatureB64.length < 40 ||
      signatureB64.length > 1024
    ) {
      return res.status(400).json({ error: "Invalid quote request" });
    }

    let signature;
    try {
      signature = Buffer.from(signatureB64, "base64");
      if (
        signature.length < 32 ||
        signature.toString("base64") !== signatureB64
      ) {
        throw new Error("Invalid signature");
      }
    } catch {
      return res.status(400).json({ error: "Invalid quote request" });
    }

    let config;
    try {
      config = loadQuoteConfig(env);
    } catch {
      return res.status(503).json({ error: "Quote service not configured" });
    }

    const canonicalRequest = [
      "T2T_S2S_PAYMENT_QUOTE_V1",
      keyId,
      terminalId,
      timestamp,
      nonce,
      invoiceReference,
      amountUsdCents
    ].join("\n");

    let client = null;
    let inTransaction = false;

    const releaseClient = () => {
      if (client) {
        client.release();
        client = null;
      }
    };

    try {
      // Read the terminal key, verify the request, then release the DB
      // connection before making any external market-data requests.
      client = await poolProvider().connect();
      const initial = await client.query(
        `SELECT public_key_base64
           FROM public.t2t_s2s_client_keys
          WHERE key_id = $1 AND status = 'ACTIVE'`,
        [keyId]
      );
      if (initial.rowCount !== 1) {
        return res.status(401).json({ error: "S2S client not trusted" });
      }

      const verifyTerminalSignature = publicKeyBase64 => {
        try {
          const terminalPublicKey = crypto.createPublicKey({
            key: Buffer.from(publicKeyBase64, "base64"),
            format: "der",
            type: "spki"
          });
          return crypto.verify(
            "sha256",
            Buffer.from(canonicalRequest, "utf8"),
            terminalPublicKey,
            signature
          );
        } catch {
          return false;
        }
      };

      if (!verifyTerminalSignature(initial.rows[0].public_key_base64)) {
        return res.status(401).json({ error: "Invalid terminal signature" });
      }

      releaseClient();

      // No database connection, transaction, or row lock is held while
      // Kraken and CoinGecko are contacted.
      const marketRate = await rateProvider({ now, env });
      const rateNumerator = String(marketRate?.rateNumerator || "");
      const rateDenominator = String(marketRate?.rateDenominator || "");
      const metadata = marketRate?.metadata;
      const quoteNow = now();
      if (
        !/^[1-9][0-9]{0,17}$/.test(rateNumerator) ||
        !/^[1-9][0-9]{0,17}$/.test(rateDenominator) ||
        !metadata ||
        metadata.method !== "kraken_coingecko_midpoint_v1" ||
        !Number.isSafeInteger(metadata.observedAt) ||
        quoteNow - metadata.observedAt > 30_000 ||
        metadata.observedAt - quoteNow > 5_000 ||
        !Number.isSafeInteger(metadata.krakenTradeAt) ||
        !Number.isSafeInteger(metadata.coingeckoUpdatedAt) ||
        [metadata.krakenTradeAt, metadata.coingeckoUpdatedAt].some(
          time => quoteNow - time > 30_000 || time - quoteNow > 5_000
        )
      ) {
        throw new Error("Invalid or stale market-rate result");
      }

      const quoteId = randomBytes(24).toString("base64url");
      const expiresAt = quoteNow + QUOTE_TTL_MS;
      const canonicalQuote = buildPaymentQuoteCanonical({
        quoteId,
        terminalId,
        invoiceReference,
        amountUsdCents,
        rateNumerator,
        rateDenominator,
        expiresAt,
        rateMetadata: metadata
      });
      const quoteSignature = crypto.sign(
        "sha256",
        Buffer.from(canonicalQuote, "utf8"),
        config.privateKey
      ).toString("base64");

      // Reacquire and lock the terminal after market calls. This closes the
      // revocation/key-rotation race before the nonce is consumed.
      client = await poolProvider().connect();
      await client.query("BEGIN");
      inTransaction = true;
      const trusted = await client.query(
        `SELECT public_key_base64
           FROM public.t2t_s2s_client_keys
          WHERE key_id = $1 AND status = 'ACTIVE'
          FOR UPDATE`,
        [keyId]
      );
      if (
        trusted.rowCount !== 1 ||
        !verifyTerminalSignature(trusted.rows[0]?.public_key_base64 || "")
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(401).json({ error: "S2S client trust changed" });
      }

      await client.query(
        `INSERT INTO public.t2t_s2s_request_nonces (key_id, nonce)
         VALUES ($1, $2)`,
        [keyId, nonce]
      );
      await client.query("COMMIT");
      inTransaction = false;

      return res.status(200).json({
        quote: {
          quoteId,
          rateNumerator,
          rateDenominator,
          rateMetadata: metadata,
          expiresAt,
          signature: quoteSignature
        }
      });
    } catch (error) {
      if (client && inTransaction) {
        try { await client.query("ROLLBACK"); } catch {}
      }
      if (error?.code === "23505") {
        return res.status(409).json({ error: "Quote request replay rejected" });
      }
      return res.status(503).json({ error: "Quote service temporarily unavailable" });
    } finally {
      releaseClient();
    }
  };
}

export default createHandler();
