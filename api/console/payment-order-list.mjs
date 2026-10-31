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

    const expected = env.T2T_MERCHANT_DASHBOARD_TOKEN;
    const supplied = String(req.headers?.authorization || "");
    const token = supplied.startsWith("Bearer ") ? supplied.slice(7) : "";
    if (typeof expected !== "string" || expected.length < 32) {
      return res.status(503).json({ error: "Dashboard authentication is not configured" });
    }
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const keyId = env.T2T_DASHBOARD_S2S_KEY_ID;
    if (typeof keyId !== "string" || keyId.length < 8) {
      return res.status(503).json({ error: "Dashboard merchant scope is not configured" });
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

    try {
      const result = await poolProvider().query(
        `SELECT order_id, terminal_id, invoice_reference, currency,
                amount_usd_cents::text AS amount_usd_cents,
                amount_usdt_raw::text AS amount_usdt_raw, receiver_address,
                CASE WHEN status = 'PENDING' AND expires_at <= NOW()
                  THEN 'EXPIRED' ELSE status END AS status,
                matched_transaction_id, matched_event_index,
                forwarding_status, forwarding_transaction_id,
                expires_at, confirmed_at, forwarded_at, created_at, updated_at
           FROM public.t2t_payment_orders
          WHERE s2s_key_id = $1
          ORDER BY created_at DESC, order_id DESC
          LIMIT $2 OFFSET $3`,
        [keyId, Number(limitText), Number(offsetText)]
      );
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
