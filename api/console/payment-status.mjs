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

export function createHandler({ poolProvider = getPool } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const token = typeof req.query?.token === "string" ? req.query.token : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return res.status(400).json({ error: "Invalid payment link" });
    }

    try {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const result = await poolProvider().query(
        `SELECT order_id, invoice_reference, currency, amount_usd_cents,
                amount_usdt_raw::text AS amount_usdt_raw,
                token_contract, receiver_address, status, expires_at,
                confirmed_at
           FROM public.t2t_payment_orders
          WHERE payment_token_hash = $1
          LIMIT 1`,
        [tokenHash]
      );

      if (result.rowCount !== 1) {
        return res.status(404).json({ error: "Payment link not found" });
      }

      const order = result.rows[0];
      const status =
        order.status === "PENDING" && new Date(order.expires_at).getTime() <= Date.now()
          ? "EXPIRED"
          : order.status;

      return res.status(200).json({
        orderId: order.order_id,
        invoiceReference: order.invoice_reference,
        currency: order.currency,
        amountUsdCents: Number(order.amount_usd_cents),
        amountUsdtRaw: order.amount_usdt_raw,
        tokenContract: order.token_contract,
        receiverAddress: order.receiver_address,
        status,
        expiresAt: new Date(order.expires_at).toISOString(),
        confirmedAt: order.confirmed_at
          ? new Date(order.confirmed_at).toISOString()
          : null
      });
    } catch {
      return res.status(503).json({ error: "Payment status temporarily unavailable" });
    }
  };
}

export default createHandler();
