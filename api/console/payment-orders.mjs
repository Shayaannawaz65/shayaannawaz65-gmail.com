import crypto from "node:crypto";
import pg from "pg";
import { consumeS2sRateLimit } from "../../lib/s2s-rate-limit.mjs";
import { normalizeTronAddress } from "../tron/address.mjs";
import { verifyPaymentQuote } from "../../lib/payment-quote.mjs";

const { Pool } = pg;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const TERMINAL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NONCE_RE = /^[a-f0-9]{32,64}$/i;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const INVOICE_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const USD_CENTS_RE = /^[1-9][0-9]{0,77}$/;
const RAW_AMOUNT_RE = /^[1-9][0-9]{0,77}$/;
const UINT256_MAX = 2n ** 256n - 1n;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
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

function validRawAmount(value) {
  return RAW_AMOUNT_RE.test(value) && BigInt(value) <= UINT256_MAX;
}

function canonicalOrder({
  keyId, clientId, terminalId, timestamp, nonce, invoiceReference,
  amountUsdCents, amountUsdtRaw, expiresInSeconds, quote
}) {
  const metadataHash = crypto.createHash("sha256")
    .update(JSON.stringify(quote?.rateMetadata ?? null))
    .digest("hex");

  return [
    "T2T_S2S_PAYMENT_ORDER_V2",
    keyId,
    clientId,
    terminalId || "",
    timestamp,
    nonce,
    invoiceReference,
    amountUsdCents,
    amountUsdtRaw,
    expiresInSeconds,
    String(quote?.quoteId || ""),
    String(quote?.rateNumerator || ""),
    String(quote?.rateDenominator || ""),
    String(quote?.expiresAt || ""),
    String(quote?.signature || ""),
    metadataHash
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

async function loadAuthorizedPrincipal(client, { keyId, terminalId, lock = false }) {
  const result = await client.query(
    `SELECT c.client_id, c.client_type, c.status AS client_status,
            mk.public_key_base64, mk.status AS key_status
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
  randomBytes = crypto.randomBytes
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const terminalId = body.terminalId == null || body.terminalId === ""
      ? null : String(body.terminalId);
    const timestamp = Number(body.timestamp);
    const nonce = String(body.nonce || "");
    const keyId = String(req.headers?.["x-t2t-key-id"] || "");
    const signatureB64 = String(req.headers?.["x-t2t-signature"] || "");
    const invoiceReference = String(body.invoiceReference || "");
    const amountUsdCents = typeof body.amountUsdCents === "string"
      ? body.amountUsdCents
      : String(body.amountUsdCents ?? "");
    const amountUsdtRaw = String(body.amountUsdtRaw || "");
    const quote = body.quote;
    const expiresInSeconds = body.expiresInSeconds;

    if (
      (terminalId !== null && !TERMINAL_ID_RE.test(terminalId)) ||
      !KEY_ID_RE.test(keyId) ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(now() - timestamp) > MAX_CLOCK_SKEW_MS ||
      !NONCE_RE.test(nonce) ||
      !INVOICE_RE.test(invoiceReference) ||
      !USD_CENTS_RE.test(amountUsdCents) ||
      !validRawAmount(amountUsdtRaw) ||
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 60 ||
      expiresInSeconds > 86400 ||
      signatureB64.length < 40 ||
      signatureB64.length > 1024
    ) {
      return res.status(400).json({ error: "Invalid payment order" });
    }

    let signature;
    try {
      signature = Buffer.from(signatureB64, "base64");
      if (signature.length < 32 || signature.toString("base64") !== signatureB64) {
        return res.status(400).json({ error: "Invalid S2S signature" });
      }
    } catch {
      return res.status(400).json({ error: "Invalid S2S signature" });
    }

    const baseUrl = String(env.T2T_PAYMENT_BASE_URL || "").replace(/\/+$/, "");
    let parsedBaseUrl;
    try {
      parsedBaseUrl = new URL(baseUrl);
      if (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.hostname !== "localhost") {
        throw new Error("HTTPS required");
      }
    } catch {
      return res.status(503).json({ error: "Payment link configuration unavailable" });
    }

    let client;
    let inTransaction = false;

    try {
      client = await poolProvider().connect();
      await client.query("BEGIN");
      inTransaction = true;

      const principal = await loadAuthorizedPrincipal(client, {
        keyId, terminalId, lock: true
      });

      if (!principal || !CLIENT_ID_RE.test(principal.client_id)) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(401).json({ error: "S2S client or key not trusted" });
      }

      const canonical = canonicalOrder({
        keyId,
        clientId: principal.client_id,
        terminalId,
        timestamp,
        nonce,
        invoiceReference,
        amountUsdCents,
        amountUsdtRaw,
        expiresInSeconds,
        quote
      });

      if (!verifyClientSignature(principal.public_key_base64, canonical, signature)) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(401).json({ error: "Invalid S2S signature" });
      }

      let verifiedQuote;
      try {
        verifiedQuote = verifyPaymentQuote({
          quote,
          clientId: principal.client_id,
          invoiceReference,
          amountUsdCents,
          amountUsdtRaw,
          now: now(),
          publicKeyBase64: env.T2T_EXCHANGE_QUOTE_PUBLIC_KEY
        });
      } catch {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(401).json({ error: "Invalid or untrusted exchange-rate quote" });
      }

      const receiverAddress = env.T2T_TRON_RECEIVER_ADDRESS || "";
      if (
        typeof receiverAddress !== "string" ||
        normalizeTronAddress(receiverAddress) !== receiverAddress
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(503).json({ error: "Receiver configuration invalid" });
      }

      await client.query(
        `INSERT INTO public.t2t_s2s_request_nonces (key_id, nonce)
         VALUES ($1, $2)`,
        [keyId, nonce]
      );

      const withinLimit = await consumeS2sRateLimit(client, {
        subjectType: "CLIENT_KEY",
        subjectId: keyId,
        endpoint: "payment-orders",
        limit: 30,
        now: now()
      });

      if (!withinLimit) {
        await client.query("COMMIT");
        inTransaction = false;
        return res.status(429).json({ error: "Client request rate limit exceeded" });
      }

      const token = randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      const inserted = await client.query(
        `INSERT INTO public.t2t_payment_orders (
           client_id, terminal_id, s2s_key_id, invoice_reference, currency,
           amount_usd_cents, token_contract, amount_usdt_raw, receiver_address,
           payment_token_hash, quote_id, exchange_rate_numerator,
           exchange_rate_denominator, exchange_rate_metadata,
           quote_expires_at, expires_at
         )
         VALUES (
           $1, $2, $3, $4, 'USD', $5,
           'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
           $6, $7, $8, $9, $10, $11, $12::jsonb,
           to_timestamp($13 / 1000.0),
           NOW() + ($14 * INTERVAL '1 second')
         )
         RETURNING order_id, invoice_reference,
                   amount_usd_cents::text AS amount_usd_cents,
                   amount_usdt_raw::text AS amount_usdt_raw,
                   receiver_address, expires_at, status`,
        [
          principal.client_id,
          terminalId,
          keyId,
          invoiceReference,
          amountUsdCents,
          amountUsdtRaw,
          receiverAddress,
          tokenHash,
          verifiedQuote.quoteId,
          verifiedQuote.rateNumerator,
          verifiedQuote.rateDenominator,
          JSON.stringify(verifiedQuote.rateMetadata),
          verifiedQuote.expiresAt,
          expiresInSeconds
        ]
      );

      await client.query("COMMIT");
      inTransaction = false;

      const order = inserted.rows[0];
      return res.status(201).json({
        orderId: order.order_id,
        clientId: principal.client_id,
        clientType: principal.client_type,
        invoiceReference: order.invoice_reference,
        currency: "USD",
        amountUsdCents: order.amount_usd_cents,
        amountUsdtRaw: order.amount_usdt_raw,
        tokenContract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        receiverAddress: order.receiver_address,
        status: order.status,
        expiresAt: new Date(order.expires_at).toISOString(),
        paymentUrl: `${baseUrl}/pay.html?token=${token}`
      });
    } catch (error) {
      if (client && inTransaction) {
        try { await client.query("ROLLBACK"); } catch {}
      }

      if (error?.code === "23505") {
        return res.status(409).json({
          error: "Duplicate invoice reference or replayed nonce"
        });
      }

      return res.status(503).json({ error: "Payment order temporarily unavailable" });
    } finally {
      client?.release();
    }
  };
}

export default createHandler();
