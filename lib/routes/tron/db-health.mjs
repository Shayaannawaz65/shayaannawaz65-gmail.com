import pg from "pg";
import { authorized } from "./sync.mjs";

const { Pool } = pg;
let pool;

function getPool(env) {
  if (!pool) {
    const connectionString =
      env.T2T_DATABASE_URL ||
      env.DATABASE_URL_UNPOOLED ||
      env.POSTGRES_URL_NON_POOLING ||
      env.DATABASE_URL ||
      env.POSTGRES_URL;

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
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 10000
    });
  }

  return pool;
}

export function createDbHealthHandler({
  env = process.env,
  poolProvider = () => getPool(env)
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const token = env.T2T_TRON_SYNC_TOKEN;
    if (!token) {
      return res.status(503).json({
        status: "unavailable",
        database_accessed: false,
        schema_ready: false
      });
    }

    if (!authorized(req, token)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const db = poolProvider();

      await db.query("SELECT 1 AS ok");

      const columnsResult = await db.query(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = ANY($1::text[])`,
        [["tron_usdt_deposits", "tron_usdt_sync_state"]]
      );

      const indexesResult = await db.query(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = ANY($1::text[])`,
        [["tron_usdt_deposits_pkey", "idx_tron_usdt_deposits_receiver_time"]]
      );

      const columns = new Set(
        columnsResult.rows.map(row => `${row.table_name}.${row.column_name}`)
      );

      const requiredColumns = [
        "tron_usdt_deposits.transaction_id",
        "tron_usdt_deposits.event_index",
        "tron_usdt_deposits.sender_address",
        "tron_usdt_deposits.receiver_address",
        "tron_usdt_deposits.token_contract",
        "tron_usdt_deposits.amount_raw",
        "tron_usdt_deposits.amount_usdt",
        "tron_usdt_deposits.block_timestamp",
        "tron_usdt_deposits.observation_status",
        "tron_usdt_deposits.first_seen_at",
        "tron_usdt_deposits.last_seen_at",
        "tron_usdt_deposits.raw_event_json",
        "tron_usdt_sync_state.receiver_address",
        "tron_usdt_sync_state.last_completed_timestamp",
        "tron_usdt_sync_state.updated_at",
        "tron_usdt_sync_state.lease_token",
        "tron_usdt_sync_state.lease_until"
      ];

      const indexes = new Set(indexesResult.rows.map(row => row.indexname));
      const missingColumns = requiredColumns.filter(name => !columns.has(name));
      const missingIndexes = [
        "tron_usdt_deposits_pkey",
        "idx_tron_usdt_deposits_receiver_time"
      ].filter(name => !indexes.has(name));

      const schemaReady = missingColumns.length === 0 &&
        missingIndexes.length === 0;

      return res.status(schemaReady ? 200 : 503).json({
        status: schemaReady ? "connected" : "schema_incomplete",
        database_accessed: true,
        read_only_check: true,
        connection_test: "passed",
        schema_ready: schemaReady,
        missing_column_count: missingColumns.length,
        missing_index_count: missingIndexes.length,
        transaction_sync_run: false,
        blockchain_scanned: false
      });
    } catch {
      return res.status(503).json({
        status: "database_unavailable",
        database_accessed: false,
        read_only_check: true,
        schema_ready: false,
        transaction_sync_run: false,
        blockchain_scanned: false
      });
    }
  };
}

export default createDbHealthHandler();
