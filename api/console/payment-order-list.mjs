import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
let pool;

function getPool() {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL_UNPOOLED ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL;

    if (!connectionString || connectionString.includes("[SENSITIVE]")) {
      throw new Error("Database configuration unavailable");
    }

    const url = new URL(connectionString);
    if (url.searchParams.get("sslmode") === "require") {
      url.searchParams.set("sslmode", "verify-full");
    }

    pool = new Pool({
      connectionString: url.toString(),
      ssl: { rejectUnauthorized: true },
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000
    });
  }
  return pool;
}

const KEY_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const NONCE_RE = /^[a-f0-9]{32,64}$/i;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;


function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

export function createHandler({
  env = process.env,
  poolProvider = getPool,
  now = () => Date.now()
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const keyId = String(req.headers?.["x-t2t-key-id"] || "");
    const timestamp = Number(req.headers?.["x-t2t-timestamp"]);
    const nonce = String(req.headers?.["x-t2t-nonce"] || "");
    const signatureB64 = String(req.headers?.["x-t2t-signature"] || "");
    if (
      !KEY_ID_RE.test(keyId) ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(now() - timestamp) > MAX_CLOCK_SKEW_MS ||
      !NONCE_RE.test(nonce) ||
      signatureB64.length < 40 || signatureB64.length > 1024
    ) return res.status(401).json({ error: "Invalid S2S authentication" });

    let signature;
    try {
      signature = Buffer.from(signatureB64, "base64");
      if (signature.length < 32 || signature.toString("base64") !== signatureB64) {
        return res.status(401).json({ error: "Invalid S2S authentication" });
      }
    } catch {
      return res.status(401).json({ error: "Invalid S2S authentication" });
    }

    const limitText = String(req.query?.limit ?? "25");
    const offsetText = String(req.query?.offset ?? "0");

    if (
      !/^(?:[1-9]\d{0,2})$/.test(limitText) ||
      Number(limitText) > 100 ||
      !/^(?:0|[1-9]\d{0,8})$/.test(offsetText)
    ) {
      return res.status(400).json({
        error: "Invalid pagination; limit must be 1-100 and offset 0-999999999"
      });
    }

    let client;
    let inTransaction = false;
    try {
      client = await poolProvider().connect();
      await client.query("BEGIN");
      const trusted = await client.query(
        `SELECT public_key_base64
           FROM public.t2t_s2s_client_keys
          WHERE key_id = $1 AND status = 'ACTIVE'
          FOR UPDATE`,
        [keyId]
      );
      if (trusted.rowCount !== 1) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(401).json({ error: "S2S client not trusted" });
      }

      const canonical = [
        "T2T_S2S_ORDER_LIST_V1",
        keyId,
        timestamp,
        nonce,
        limitText,
        offsetText
      ].join("\n");
      let verified = false;
      try {
        const publicKey = crypto.createPublicKey({
          key: Buffer.from(trusted.rows[0].public_key_base64, "base64"),
          format: "der",
          type: "spki"
        });
        verified = crypto.verify("sha256", Buffer.from(canonical), publicKey, signature);
      } catch {}
      if (!verified) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(401).json({ error: "Invalid S2S signature" });
      }

      await client.query(
        `INSERT INTO public.t2t_s2s_request_nonces (key_id, nonce)
         VALUES ($1, $2)`,
        [keyId, nonce]
      );
      const result = await client.query(
        `SELECT order_id,
                terminal_id,
                invoice_reference,
                currency,
                amount_usd_cents::text AS amount_usd_cents,
                amount_usdt_raw::text AS amount_usdt_raw,
                receiver_address,
                CASE WHEN status = 'PENDING' AND expires_at <= NOW()
                  THEN 'EXPIRED' ELSE status END AS status,
                matched_transaction_id,
                matched_event_index,
                forwarding_status,
                forwarding_transaction_id,
                expires_at,
                confirmed_at,
                forwarded_at,
                created_at,
                updated_at
           FROM public.t2t_payment_orders
          WHERE s2s_key_id = $1
          ORDER BY created_at DESC, order_id DESC
          LIMIT $2 OFFSET $3`,
        [keyId, Number(limitText), Number(offsetText)]
      );
      await client.query("COMMIT");
      inTransaction = false;
      const records = result.rows.map(row => ({
        orderId: row.order_id,
        terminalId: row.terminal_id,
        invoiceReference: row.invoice_reference,
        currency: row.currency,
        amountUsdCents: row.amount_usd_cents,
        amountUsdtRaw: row.amount_usdt_raw,
        receiverAddress: row.receiver_address,
        status: row.status,
        transactionId: row.matched_transaction_id?.trim() ?? null,
        eventIndex: row.matched_event_index,
        forwardingStatus: row.forwarding_status,
        forwardingTransactionId:
          row.forwarding_transaction_id?.trim() ?? null,
        expiresAt: iso(row.expires_at),
        confirmedAt: iso(row.confirmed_at),
        forwardedAt: iso(row.forwarded_at),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at)
      }));

      return res.status(200).json({
        status: "ok",
        records,
        pagination: {
          limit: Number(limitText),
          offset: Number(offsetText),
          returned: records.length
        },
        safety: {
          readOnly: true,
          databaseWrites: false,
          blockchainSyncRun: false,
          fundsForwarded: false
        }
      });
    } catch (error) {
      if (client && inTransaction) { try { await client.query("ROLLBACK"); } catch {} }
      if (error?.code === "23505") return res.status(409).json({ error: "S2S request replay rejected" });
      return res.status(503).json({ error: "Payment order list unavailable" });
    } finally {
      client?.release();
    }
  };
}

export default createHandler();
