import crypto from "node:crypto";
import pg from "pg";
import { normalizeTronAddress } from "../tron/address.mjs";
import { verifyPaymentQuote } from "../../lib/payment-quote.mjs";

const { Pool } = pg;
const TERMINAL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NONCE_RE = /^[a-f0-9]{32,64}$/i;
const INVOICE_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const RAW_AMOUNT_RE = /^[1-9][0-9]{0,77}$/;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
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

    const terminalId = String(body.terminalId || "");
    const timestamp = Number(body.timestamp);
    const nonce = String(body.nonce || "");
    const signatureB64 = String(body.signature || "");
    const invoiceReference = String(body.invoiceReference || "");
    const amountUsdCents = body.amountUsdCents;
    const amountUsdtRaw = String(body.amountUsdtRaw || "");
    const quote = body.quote;
    const expiresInSeconds = body.expiresInSeconds;

    if (
      !TERMINAL_ID_RE.test(terminalId) ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(now() - timestamp) > MAX_CLOCK_SKEW_MS ||
      !NONCE_RE.test(nonce) ||
      !INVOICE_RE.test(invoiceReference) ||
      !Number.isSafeInteger(amountUsdCents) ||
      amountUsdCents <= 0 ||
      !RAW_AMOUNT_RE.test(amountUsdtRaw) ||
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
      if (
        signature.length < 32 ||
        signature.toString("base64") !== signatureB64
      ) {
        return res.status(400).json({ error: "Invalid payment order" });
      }
    } catch {
      return res.status(400).json({ error: "Invalid payment order" });
    }

    const baseUrl = String(env.T2T_PAYMENT_BASE_URL || "").replace(/\/+$/, "");
    let parsedBaseUrl;
    try {
      parsedBaseUrl = new URL(baseUrl);
      if (
        parsedBaseUrl.protocol !== "https:" &&
        parsedBaseUrl.hostname !== "localhost"
      ) {
        throw new Error("HTTPS required");
      }
    } catch {
      return res.status(503).json({ error: "Payment link configuration unavailable" });
    }

    const canonical = [
      "T2T_PAYMENT_ORDER_V1",
      terminalId,
      timestamp,
      nonce,
      invoiceReference,
      amountUsdCents,
      amountUsdtRaw,
      expiresInSeconds
    ].join("\n");

    let verifiedQuote;
    try {
      verifiedQuote = verifyPaymentQuote({
        quote,
        terminalId,
        invoiceReference,
        amountUsdCents,
        amountUsdtRaw,
        now: now(),
        publicKeyBase64: env.T2T_EXCHANGE_QUOTE_PUBLIC_KEY
      });
    } catch {
      return res.status(401).json({ error: "Invalid or untrusted exchange-rate quote" });
    }

    let client;
    let inTransaction = false;

    try {
      client = await poolProvider().connect();
      await client.query("BEGIN");
      inTransaction = true;

      const trusted = await client.query(
        `SELECT t.public_key_base64,
                m.internal_mid,
                m.receiver_id,
                m.receiver_address
           FROM public.t2t_trusted_terminals t
           JOIN public.t2t_terminal_merchant_mapping m
             ON m.terminal_id = t.terminal_id
          WHERE t.terminal_id = $1
            AND t.status = 'ACTIVE'
            AND m.status = 'ACTIVE'
          FOR UPDATE OF t, m`,
        [terminalId]
      );

      if (trusted.rowCount !== 1) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(401).json({ error: "Terminal or merchant not trusted" });
      }

      let verified = false;
      try {
        const publicKey = crypto.createPublicKey({
          key: Buffer.from(trusted.rows[0].public_key_base64, "base64"),
          format: "der",
          type: "spki"
        });
        verified = crypto.verify(
          "sha256",
          Buffer.from(canonical, "utf8"),
          publicKey,
          signature
        );
      } catch {
        verified = false;
      }

      if (!verified) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(401).json({ error: "Invalid terminal signature" });
      }

      const receiverAddress = trusted.rows[0].receiver_address;
      if (
        typeof receiverAddress !== "string" ||
        normalizeTronAddress(receiverAddress) !== receiverAddress
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(503).json({ error: "Receiver configuration invalid" });
      }

      await client.query(
        `INSERT INTO public.t2t_heartbeat_nonces (terminal_id, nonce)
         VALUES ($1, $2)`,
        [terminalId, nonce]
      );

      const token = randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      const inserted = await client.query(
        `INSERT INTO public.t2t_payment_orders (
           terminal_id,
           invoice_reference,
           currency,
           amount_usd_cents,
           token_contract,
           amount_usdt_raw,
           receiver_address,
           payment_token_hash,
           quote_id,
           exchange_rate_numerator,
           exchange_rate_denominator,
           exchange_rate_metadata,
           quote_expires_at,
           expires_at
         )
         VALUES (
           $1, $2, 'USD', $3,
           'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
           $4, $5, $6,
           $7, $8, $9, $10::jsonb, to_timestamp($11 / 1000.0),
           NOW() + ($12 * INTERVAL '1 second')
         )
         RETURNING order_id, invoice_reference, amount_usd_cents,
                   amount_usdt_raw::text AS amount_usdt_raw,
                   receiver_address, expires_at, status`,
        [
          terminalId,
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
        invoiceReference: order.invoice_reference,
        currency: "USD",
        amountUsdCents: Number(order.amount_usd_cents),
        amountUsdtRaw: order.amount_usdt_raw,
        tokenContract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        receiverAddress: order.receiver_address,
        status: order.status,
        expiresAt: new Date(order.expires_at).toISOString(),
        paymentUrl: `${baseUrl}/pay.html?token=${token}`,
        merchantId: trusted.rows[0].internal_mid,
        receiverId: trusted.rows[0].receiver_id
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
