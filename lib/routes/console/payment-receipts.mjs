import pg from "pg";
import { authorized } from "../tron/sync.mjs";

const { Pool } = pg;
let pool;

function connectionPool(env = process.env) {
  if (!pool) {
    const connectionString = env.T2T_DATABASE_URL || env.DATABASE_URL_UNPOOLED ||
      env.POSTGRES_URL_NON_POOLING || env.DATABASE_URL || env.POSTGRES_URL;
    if (!connectionString || connectionString.includes("[SENSITIVE]")) {
      throw new Error("Database configuration unavailable");
    }
    const url = new URL(connectionString);
    if (url.searchParams.get("sslmode") === "require") url.searchParams.set("sslmode", "verify-full");
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

function usd(cents) {
  if (cents == null) return null;
  const value = BigInt(cents);
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

export function createPaymentReceiptsHandler({ env = process.env, poolProvider = connectionPool } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const token = env.T2T_S2S_AUTHORIZATION_ADMIN_TOKEN;
    if (!token || !authorized(req, token)) {
      return res.status(token ? 401 : 503).json({ error: token ? "Unauthorized" : "Receipt ledger unavailable" });
    }

    const limitText = String(req.query?.limit ?? "50");
    const offsetText = String(req.query?.offset ?? "0");
    if (!/^(?:[1-9]\\d{0,2})$/.test(limitText) || Number(limitText) > 100 ||
        !/^(?:0|[1-9]\\d{0,8})$/.test(offsetText)) {
      return res.status(400).json({ error: "Invalid pagination" });
    }

    try {
      const db = poolProvider();
      const [rows, summary] = await Promise.all([
        db.query(
          `SELECT receipt_id, source_receipt_reference, payment_reference, currency,
                  expected_amount_usd_cents::text AS expected_amount_usd_cents,
                  cm_reported_amount_usd_cents::text AS cm_reported_amount_usd_cents,
                  loader_received_amount_usd_cents::text AS loader_received_amount_usd_cents,
                  cm_release_status, loader_status, blockchain_status,
                  exchange_status, wallet_settlement_status,
                  cm_client_id, cm_key_id, cm_terminal_id, created_at, updated_at,
                  (SELECT count(*)::int FROM public.t2t_payment_receipt_operations o
                    WHERE o.receipt_id = r.receipt_id) AS operation_count,
                  count(*) OVER()::int AS total_count
             FROM public.t2t_payment_receipts r
            ORDER BY created_at DESC, receipt_id DESC
            LIMIT $1 OFFSET $2`,
          [Number(limitText), Number(offsetText)]
        ),
        db.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE loader_status = 'AWAITING')::int AS awaiting_loader,
                  count(*) FILTER (WHERE loader_status = 'RECEIVED')::int AS loader_received,
                  count(*) FILTER (WHERE blockchain_status = 'VERIFIED')::int AS blockchain_verified,
                  count(*) FILTER (WHERE wallet_settlement_status = 'SETTLED')::int AS wallet_settled
             FROM public.t2t_payment_receipts`
        )
      ]);
      const total = Number(summary.rows[0]?.total ?? 0);
      return res.status(200).json({
        status: "ok",
        source: "neon.t2t_payment_receipts",
        records: rows.rows.map(row => ({
          receiptId: row.receipt_id,
          sourceReceiptReference: row.source_receipt_reference,
          paymentReference: row.payment_reference,
          currency: row.currency.trim(),
          expectedAmountUsd: usd(row.expected_amount_usd_cents),
          cmReportedAmountUsd: usd(row.cm_reported_amount_usd_cents),
          loaderReceivedAmountUsd: usd(row.loader_received_amount_usd_cents),
          cmReleaseStatus: row.cm_release_status,
          loaderStatus: row.loader_status,
          blockchainStatus: row.blockchain_status,
          exchangeStatus: row.exchange_status,
          walletSettlementStatus: row.wallet_settlement_status,
          cmClientId: row.cm_client_id,
          cmKeyId: row.cm_key_id,
          cmTerminalId: row.cm_terminal_id,
          operationCount: row.operation_count,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString()
        })),
        summary: {
          total,
          awaitingLoader: Number(summary.rows[0]?.awaiting_loader ?? 0),
          loaderReceived: Number(summary.rows[0]?.loader_received ?? 0),
          blockchainVerified: Number(summary.rows[0]?.blockchain_verified ?? 0),
          walletSettled: Number(summary.rows[0]?.wallet_settled ?? 0)
        },
        pagination: {
          limit: Number(limitText),
          offset: Number(offsetText),
          returned: rows.rows.length,
          total
        },
        safety: {
          readOnly: true,
          receiptInserted: false,
          depositsAutoApproved: false,
          settlementExecuted: false
        }
      });
    } catch {
      return res.status(503).json({ error: "Receipt ledger temporarily unavailable" });
    }
  };
}

export default createPaymentReceiptsHandler();
