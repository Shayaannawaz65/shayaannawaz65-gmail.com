import crypto from "node:crypto";
import pg from "pg";
import { getNowPaymentsSdk } from "../../nowpayments/sdk.mjs";

const { Pool } = pg;
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

function sortObjectDeep(value) {
  if (Array.isArray(value)) return value.map(sortObjectDeep);
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = sortObjectDeep(value[key]);
      return result;
    }, {});
  }
  return value;
}

function usdCents(value) {
  const text = String(value ?? "");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return (BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2))).toString();
}

function mapStatus(value) {
  switch (String(value || "").toLowerCase()) {
    case "waiting": return "PENDING";
    case "confirming":
    case "confirmed":
    case "sending": return "PROCESSING";
    case "finished": return "CONFIRMED";
    case "partially_paid": return "PARTIALLY_PAID";
    case "failed": return "FAILED";
    case "refunded": return "REFUNDED";
    case "expired": return "EXPIRED";
    case "cancelled":
    case "canceled": return "CANCELLED";
    default: return null;
  }
}

export function createHandler({
  poolProvider = getPool,
  sdkProvider = () => getNowPaymentsSdk()
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    let event;
    try {
      const signature = String(req.headers?.["x-nowpayments-sig"] || "");
      if (!signature || !req.body || typeof req.body !== "object") {
        return res.status(400).json({ error: "Invalid IPN request" });
      }
      event = sdkProvider().parseWebhook(req.body, signature);
    } catch {
      return res.status(401).json({ error: "Invalid NOWPayments IPN signature" });
    }

    if (event?.type !== "payment.status_changed" || !event.payment) {
      return res.status(400).json({ error: "Unsupported NOWPayments event" });
    }

    const payment = event.payment;
    const orderId = String(payment.order_id || payment.purchase_id || "");
    const paymentId = String(payment.payment_id || "");
    const rawStatus = String(payment.payment_status || "");
    const nextStatus = mapStatus(rawStatus);
    const amountCents = usdCents(payment.price_amount);

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId) ||
      !paymentId ||
      !nextStatus ||
      String(payment.price_currency || "").toLowerCase() !== "usd" ||
      String(payment.pay_currency || "").toLowerCase() !== "usdttrc20" ||
      amountCents === null
    ) {
      return res.status(400).json({ error: "Invalid payment event data" });
    }

    const payloadHash = crypto.createHash("sha256")
      .update(JSON.stringify(sortObjectDeep(req.body)))
      .digest("hex");

    let client;
    try {
      client = await poolProvider().connect();
      await client.query("BEGIN");

      const orderResult = await client.query(
        `SELECT order_id, amount_usd_cents::text AS amount_usd_cents,
                provider_name, provider_payment_id, status
           FROM public.t2t_payment_orders
          WHERE order_id = $1
          FOR UPDATE`,
        [orderId]
      );

      if (orderResult.rowCount !== 1) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Payment order not found" });
      }

      const order = orderResult.rows[0];

      if (
        String(order.provider_name || "").toUpperCase() !== "NOWPAYMENTS" ||
        order.amount_usd_cents !== amountCents ||
        (order.provider_payment_id &&
          String(order.provider_payment_id) !== paymentId)
      ) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Payment does not match the USD invoice" });
      }

      const recorded = await client.query(
        `INSERT INTO public.t2t_nowpayments_ipn_events
           (payload_hash, payment_id, payment_status, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (payload_hash) DO NOTHING`,
        [payloadHash, paymentId, rawStatus, JSON.stringify(req.body)]
      );

      if (recorded.rowCount === 0) {
        await client.query("COMMIT");
        return res.status(200).json({ ok: true, duplicate: true });
      }

      const updatedOrder = await client.query(
        `UPDATE public.t2t_payment_orders
            SET provider_name = 'NOWPAYMENTS',
                provider_payment_id = COALESCE(provider_payment_id, $2),
                provider_payment_status = $3,
                provider_payload = $4::jsonb,
                status = CASE
                  WHEN status = 'CONFIRMED' AND $6 NOT IN ('CONFIRMED', 'REFUNDED')
                    THEN status
                  ELSE $6
                END,
                confirmed_at = CASE
                  WHEN $6 = 'CONFIRMED' THEN COALESCE(confirmed_at, NOW())
                  ELSE confirmed_at
                END,
                updated_at = NOW()
          WHERE order_id = $1`,
        [
          orderId,
          paymentId,
          rawStatus,
          JSON.stringify(req.body),
          nextStatus
        ]
      );

      if (updatedOrder.rowCount !== 1) {
        throw new Error("NOWPayments order update did not affect exactly one row");
      }

      await client.query("COMMIT");
      return res.status(200).json({ ok: true });
    } catch {
      try { await client?.query("ROLLBACK"); } catch {}
      return res.status(503).json({ error: "IPN processing temporarily unavailable" });
    } finally {
      client?.release();
    }
  };
}

export default createHandler();
