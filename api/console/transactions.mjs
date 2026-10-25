import pg from "pg";
import { authorized } from "../tron/sync.mjs";

const { Pool } = pg;
let pool;

function connectionPool() {
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
      max: 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000
    });
  }
  return pool;
}

export function createTransactionsHandler({
  env = process.env,
  poolProvider = connectionPool
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const token = env.T2T_CONSOLE_FEED_TOKEN;
    if (!token || !authorized(req, token)) {
      return res.status(token ? 401 : 503).json({
        error: token ? "Unauthorized" : "Feed unavailable"
      });
    }

    const rawLimit = req.query?.limit ?? "50";
    const rawOffset = req.query?.offset ?? "0";
    const limitText = String(rawLimit);
    const offsetText = String(rawOffset);

    if (!/^(?:[1-9]\d{0,2})$/.test(limitText) ||
        Number(limitText) > 100 ||
        !/^(?:0|[1-9]\d{0,8})$/.test(offsetText)) {
      return res.status(400).json({
        error: "Invalid pagination; limit must be 1-100 and offset 0-999999999"
      });
    }

    try {
      const db = poolProvider();
      const result = await db.query(
        `SELECT transaction_id,
                event_index,
                sender_address,
                receiver_address,
                token_contract,
                amount_raw::text AS amount_raw,
                amount_usdt::text AS amount_usdt,
                block_timestamp,
                observation_status,
                first_seen_at,
                last_seen_at
           FROM public.tron_usdt_deposits
          WHERE observation_status = 'OBSERVED_CONFIRMED'
          ORDER BY block_timestamp DESC, transaction_id DESC, event_index DESC
          LIMIT $1 OFFSET $2`,
        [Number(limitText), Number(offsetText)]
      );

      return res.status(200).json({
        status: "ok",
        source: "tron_usdt_deposits",
        records: result.rows.map(row => ({
          transaction_id: row.transaction_id.trim(),
          event_index: row.event_index,
          sender_address: row.sender_address,
          receiver_address: row.receiver_address,
          token_contract: row.token_contract,
          amount_raw: row.amount_raw,
          amount_usdt: row.amount_usdt,
          block_timestamp: new Date(row.block_timestamp).toISOString(),
          observation_status: row.observation_status,
          first_seen_at: new Date(row.first_seen_at).toISOString(),
          last_seen_at: new Date(row.last_seen_at).toISOString(),
          deposit_approved: false,
          settlement_authorized: false
        })),
        pagination: {
          limit: Number(limitText),
          offset: Number(offsetText),
          returned: result.rows.length
        },
        safety: {
          read_only: true,
          blockchain_scanned: false,
          transaction_sync_run: false,
          deposits_auto_approved: false,
          settlement_executed: false
        }
      });
    } catch {
      return res.status(503).json({ error: "Transaction feed unavailable" });
    }
  };
}

export default createTransactionsHandler();
