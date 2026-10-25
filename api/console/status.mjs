import { createDbHealthHandler } from "../tron/db-health.mjs";
import { createProviderHealthHandler } from "../tron/provider-health.mjs";
import pg from "pg";

const { Pool } = pg;
let pool;

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function connectionPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL_UNPOOLED ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.DATABASE_URL || process.env.POSTGRES_URL;
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

async function runCheck(handler, req) {
  const res = responseCapture();
  try {
    await handler(req, res);
    return { httpStatus: res.statusCode, ...(res.body || {}) };
  } catch {
    return { httpStatus: 503, status: "unavailable" };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const usable = value =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("[SENSITIVE]");

  const token = process.env.T2T_TRON_SYNC_TOKEN || "";
  const databaseConfigured = [
    process.env.DATABASE_URL_UNPOOLED,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL
  ].some(usable);

  const providerConfigured = [
    process.env.TRONGRID_API_KEY,
    process.env.TRONGRID_JWT_PRIVATE_KEY,
    process.env.TRONGRID_JWT_KEY_ID
  ].every(usable);

  const internalReq = {
    method: "GET",
    headers: { authorization: usable(token) ? `Bearer ${token}` : "" }
  };

  const [database, provider] = await Promise.all([
    usable(token) && databaseConfigured
      ? runCheck(createDbHealthHandler(), internalReq)
      : Promise.resolve({ status: "configuration_incomplete" }),
    usable(token) && providerConfigured
      ? runCheck(createProviderHealthHandler(), internalReq)
      : Promise.resolve({ status: "configuration_incomplete" })
  ]);

  let terminal = {
    status: "unavailable",
    terminal_id: "OFFLINE-201.3-001",
    last_seen_at: null,
    detail: "Database or heartbeat schema unavailable"
  };

  try {
    const result = await connectionPool().query(
      `SELECT terminal_id, last_seen_at, status
         FROM public.t2t_trusted_terminals
        WHERE terminal_id = $1`,
      ["OFFLINE-201.3-001"]
    );
    if (result.rowCount === 0) {
      terminal = {
        status: "not_registered",
        terminal_id: "OFFLINE-201.3-001",
        last_seen_at: null,
        detail: "Terminal public key must be registered before heartbeats can be accepted"
      };
    } else {
      const row = result.rows[0];
      const lastSeen = row.last_seen_at ? new Date(row.last_seen_at) : null;
      const recent = lastSeen && Date.now() - lastSeen.getTime() <= 2 * 60 * 1000;
      terminal = {
        status: row.status !== "ACTIVE" ? "revoked" :
          recent ? "connected" : lastSeen ? "stale" : "awaiting_heartbeat",
        terminal_id: row.terminal_id,
        last_seen_at: lastSeen ? lastSeen.toISOString() : null,
        detail: row.status !== "ACTIVE" ? "Terminal trust is revoked" :
          recent ? "Authenticated heartbeat received within the last 2 minutes" :
          lastSeen ? "Last heartbeat is older than 2 minutes" :
          "Terminal is trusted but has not sent a heartbeat yet"
      };
    }
  } catch {
    // Never expose DB connection details in the public dashboard response.
  }

  return res.status(200).json({
    checked_at: new Date().toISOString(),
    backend: { status: "responding" },
    database: {
      status: database.status || "unavailable",
      schema_ready: database.schema_ready === true,
      database_accessed: database.database_accessed === true,
      detail: database.status === "connected" ? "Connection and required TRON schema verified" :
        database.status === "schema_incomplete" ? "Database reachable, but required TRON schema is incomplete" :
        database.status === "configuration_incomplete" ? "Database credentials are missing or contain deployment placeholders" :
        "Database check unavailable; verify server configuration and migration"
    },
    provider: {
      status: provider.status || "unavailable",
      current_block_number: Number.isSafeInteger(provider.current_block_number) ?
        provider.current_block_number : null,
      detail: provider.status === "connected" ?
        "TronGrid returned current mainnet block metadata" :
        provider.status === "configuration_incomplete" ?
          "TronGrid credentials are missing or contain deployment placeholders" :
          "TronGrid provider check unavailable"
    },
    terminal,
    merchantBranch: {
      status: "not_configured",
      detail: "Merchant and branch mapping has not been configured"
    },
    transactionFeed: {
      status: typeof process.env.T2T_CONSOLE_FEED_TOKEN === "string" &&
        process.env.T2T_CONSOLE_FEED_TOKEN.trim().length >= 32 &&
        !process.env.T2T_CONSOLE_FEED_TOKEN.includes("[SENSITIVE]")
          ? "configured"
          : "not_configured",
      detail: typeof process.env.T2T_CONSOLE_FEED_TOKEN === "string" &&
        process.env.T2T_CONSOLE_FEED_TOKEN.trim().length >= 32 &&
        !process.env.T2T_CONSOLE_FEED_TOKEN.includes("[SENSITIVE]")
          ? "Read-only observed-transfer feed is configured; no approvals or settlements are performed"
          : "A dedicated feed credential is not configured"
    },
    blockchainSync: {
      status: "monitor_only",
      detail: "Dashboard checks do not initiate blockchain sync or approve deposits"
    },
    safety: {
      blockchain_scanned: false,
      transaction_sync_run: false,
      deposits_auto_approved: false
    }
  });
}
