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

function tokenMatches(req, expected) {
  const header = req.headers?.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }

  const supplied = Buffer.from(header.slice(7), "utf8");
  const configured = Buffer.from(expected, "utf8");

  return supplied.length > 0 &&
    supplied.length === configured.length &&
    crypto.timingSafeEqual(supplied, configured);
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

export function createHandler({
  env = process.env,
  poolProvider = getPool
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const expected = env.T2T_MERCHANT_DASHBOARD_TOKEN;
    if (typeof expected !== "string" || expected.length < 32) {
      return res.status(503).json({
        error: "Merchant dashboard authentication is not configured"
      });
    }

    if (!tokenMatches(req, expected)) {
      return res.status(401).json({ error: "Unauthorized" });
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
      const db = poolProvider();
      const result = await db.query(
        `SELECT order_id,
                terminal_id,
                invoice_reference,
                currency,
                amount_usd_cents::text AS amount_usd_cents,
                amount_usdt_raw::text AS amount_usdt_raw,
                receiver_address,
                CASE
                  WHEN status = 'PENDING' AND expires_at <= NOW()
                    THEN 'EXPIRED'
                  ELSE status
                END AS status,
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
          ORDER BY created_at DESC, order_id DESC
          LIMIT $1 OFFSET $2`,
        [Number(limitText), Number(offsetText)]
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
    } catch {
      return res.status(503).json({
        error: "Payment order list unavailable"
      });
    }
  };
}

export default createHandler();
