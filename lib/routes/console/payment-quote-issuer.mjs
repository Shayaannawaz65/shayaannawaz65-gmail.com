import crypto from "node:crypto";
import pg from "pg";
import { consumeS2sRateLimit } from "../../s2s-rate-limit.mjs";
import { getValidatedUsdtUsdRate } from "../../exchange-rate.mjs";
import { buildPaymentQuoteCanonical } from "../../payment-quote.mjs";

const { Pool } = pg;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const TERMINAL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NONCE_RE = /^[a-f0-9]{32,64}$/i;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const INVOICE_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const USD_CENTS_RE = /^[1-9][0-9]{0,77}$/;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const QUOTE_TTL_MS = 30 * 1000;
let pool;

function getPool() {
  if (!pool) {
    const connectionString =
      process.env.T2T_DATABASE_URL ||
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

  if (!derivedPublic.equals(publicKey.export({ format: "der", type: "spki" }))) {
    throw new Error("Quote signing key pair mismatch");
  }
  if (!derivedPublic.equals(configuredPublic)) {
    throw new Error("Quote signing key pair mismatch");
  }

  return { privateKey };
}

function canonicalRequest({ keyId, clientId, terminalId, timestamp, nonce, invoiceReference, amountUsdCents }) {
  return [
    "T2T_S2S_PAYMENT_QUOTE_V2",
    keyId,
    clientId,
    terminalId || "",
    timestamp,
    nonce,
    invoiceReference,
    amountUsdCents
  ].join("\n");
}

function verifyClientSignature(publicKeyBase64, canonical, signature) {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki"
    });
    return crypto.verify("sha256", Buffer.from(canonical, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

async function loadPrincipal(client, { keyId, terminalId, lock = false }) {
  const result = await client.query(
    `SELECT c.client_id, c.client_type, mk.public_key_base64
       FROM public.t2t_s2s_client_keys mk
       JOIN public.t2t_s2s_clients c ON c.client_id = mk.client_id
      WHERE mk.key_id = $1
        AND mk.status = 'ACTIVE'
        AND c.status = 'ACTIVE'
      ${lock ? "FOR UPDATE OF mk, c" : ""}`,
    [keyId]
  );

  if (result.rowCount !== 1) return null;
  const principal = result.rows[0];

  if (principal.client_type === "POS") {
    if (!terminalId) return null;
  } else if (terminalId) {
    return null;
  }

  if (terminalId) {
    const terminal = await client.query(
      `SELECT t.terminal_id
         FROM public.t2t_trusted_terminals t
         JOIN public.t2t_s2s_key_terminals auth
           ON auth.terminal_id = t.terminal_id
          AND auth.key_id = $2
          AND auth.status = 'ACTIVE'
        WHERE t.terminal_id = $1
          AND t.status = 'ACTIVE'
        ${lock ? "FOR UPDATE OF t, auth" : ""}`,
      [terminalId, keyId]
    );
    if (terminal.rowCount !== 1) return null;
  }

  return principal;
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

    const terminalId = body.terminalId == null || body.terminalId === ""
      ? null : String(body.terminalId);
    const timestamp = Number(body.timestamp);
    const nonce = String(body.nonce || "");
    const invoiceReference = String(body.invoiceReference || "");
    const amountUsdCents = typeof body.amountUsdCents === "string"
      ? body.amountUsdCents
      : String(body.amountUsdCents ?? "");
    const keyId = String(req.headers?.["x-t2t-key-id"] || "");
    const signatureB64 = String(req.headers?.["x-t2t-signature"] || "");

    if (
      (terminalId !== null && !TERMINAL_ID_RE.test(terminalId)) ||
      !KEY_ID_RE.test(keyId) ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(now() - timestamp) > MAX_CLOCK_SKEW_MS ||
      !NONCE_RE.test(nonce) ||
      !INVOICE_RE.test(invoiceReference) ||
      !USD_CENTS_RE.test(amountUsdCents) ||
      signatureB64.length < 40 ||
      signatureB64.length > 1024
    ) {
      return res.status(400).json({ error: "Invalid quote request" });
    }

    let signature;
    try {
      signature = Buffer.from(signatureB64, "base64");
      if (signature.length < 32 || signature.toString("base64") !== signatureB64) {
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

    let client = null;
    let inTransaction = false;

    const releaseClient = () => {
      if (client) {
        client.release();
        client = null;
      }
    };

    try {
      // Resolve client identity from key ownership; no terminal is needed for BANK/MERCHANT.
      client = await poolProvider().connect();
      const initial = await loadPrincipal(client, { keyId, terminalId });
      if (!initial || !CLIENT_ID_RE.test(initial.client_id)) {
        return res.status(401).json({ error: "S2S client or key not trusted" });
      }

      const signedRequest = canonicalRequest({
        keyId,
        clientId: initial.client_id,
        terminalId,
        timestamp,
        nonce,
        invoiceReference,
        amountUsdCents
      });

      if (!verifyClientSignature(initial.public_key_base64, signedRequest, signature)) {
        return res.status(401).json({ error: "Invalid S2S signature" });
      }

      releaseClient();

      // Market-data calls happen without holding a DB connection or row lock.
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
        quoteNow - metadata.observedAt > 30000 ||
        metadata.observedAt - quoteNow > 5000 ||
        metadata.maxKrakenAgeMs !== 30000 ||
        metadata.maxCoinGeckoAgeMs !== 120000 ||
        metadata.maxFutureSkewMs !== 5000 ||
        metadata.maxDivergenceBps !== 50 ||
        !Number.isSafeInteger(metadata.krakenTradeAt) ||
        !Number.isSafeInteger(metadata.coingeckoUpdatedAt) ||
        quoteNow - metadata.krakenTradeAt > metadata.maxKrakenAgeMs ||
        quoteNow - metadata.coingeckoUpdatedAt > metadata.maxCoinGeckoAgeMs ||
        metadata.krakenTradeAt - quoteNow > metadata.maxFutureSkewMs ||
        metadata.coingeckoUpdatedAt - quoteNow > metadata.maxFutureSkewMs
      ) {
        throw new Error("Invalid or stale market-rate result");
      }

      const quoteId = randomBytes(24).toString("base64url");
      const expiresAt = quoteNow + QUOTE_TTL_MS;
      const canonicalQuote = buildPaymentQuoteCanonical({
        quoteId,
        clientId: initial.client_id,
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

      // Re-check key/client/optional terminal after external market calls.
      client = await poolProvider().connect();
      await client.query("BEGIN");
      inTransaction = true;

      const trusted = await loadPrincipal(client, { keyId, terminalId, lock: true });
      if (
        !trusted ||
        trusted.client_id !== initial.client_id ||
        trusted.client_type !== initial.client_type ||
        !verifyClientSignature(
          trusted.public_key_base64,
          signedRequest,
          signature
        )
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

      const withinLimit = await consumeS2sRateLimit(client, {
        subjectType: "CLIENT_KEY",
        subjectId: keyId,
        endpoint: "payment-quotes",
        limit: 60,
        now: now()
      });

      if (!withinLimit) {
        await client.query("COMMIT");
        inTransaction = false;
        return res.status(429).json({ error: "Client quote rate limit exceeded" });
      }

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
