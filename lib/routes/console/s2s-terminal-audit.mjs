import crypto from "node:crypto";
import pg from "pg";

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

export function createHandler({ env = process.env, poolProvider = getPool } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const expected = env.T2T_S2S_AUTHORIZATION_ADMIN_TOKEN;
    const actorId = env.T2T_S2S_AUTHORIZATION_ADMIN_ID;
    const header = String(req.headers?.authorization || "");
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (
      typeof expected !== "string" || expected.length < 32 ||
      typeof actorId !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(actorId)
    ) {
      return res.status(503).json({
        error: "S2S authorization administration is not configured"
      });
    }

    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const limitText = String(req.query?.limit ?? "50");
    const offsetText = String(req.query?.offset ?? "0");

    if (
      !/^(?:[1-9]\d{0,2})$/.test(limitText) ||
      Number(limitText) > 100 ||
      !/^(?:0|[1-9]\d{0,8})$/.test(offsetText)
    ) {
      return res.status(400).json({ error: "Invalid pagination" });
    }

    try {
      const result = await poolProvider().query(
        `SELECT audit_id, key_id, terminal_id, action, actor_id, created_at
           FROM public.t2t_s2s_terminal_access_audit
          ORDER BY created_at DESC, audit_id DESC
          LIMIT $1 OFFSET $2`,
        [Number(limitText), Number(offsetText)]
      );

      return res.status(200).json({
        records: result.rows.map(row => ({
          auditId: String(row.audit_id),
          keyId: row.key_id,
          terminalId: row.terminal_id,
          action: row.action,
          actorId: row.actor_id,
          createdAt: row.created_at
        })),
        pagination: {
          limit: Number(limitText),
          offset: Number(offsetText),
          returned: result.rows.length
        }
      });
    } catch {
      return res.status(503).json({
        error: "S2S authorization audit unavailable"
      });
    }
  };
}

export default createHandler();
