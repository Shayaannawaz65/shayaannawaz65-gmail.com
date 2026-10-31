import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const KEY_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const TERMINAL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
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

export function createHandler({
  env = process.env,
  poolProvider = getPool
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
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

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { action, keyId, terminalId } = body;
    if (
      !["grant", "revoke"].includes(action) ||
      typeof keyId !== "string" ||
      !KEY_ID_RE.test(keyId) ||
      typeof terminalId !== "string" ||
      !TERMINAL_ID_RE.test(terminalId)
    ) {
      return res.status(400).json({ error: "Invalid authorization request" });
    }

    let client;
    try {
      client = await poolProvider().connect();
      await client.query("BEGIN");

      // Lock both parent records so concurrent access changes serialize.
      const parents = await client.query(
        `SELECT mk.key_id, mk.status AS key_status,
                t.terminal_id, t.status AS terminal_status
           FROM public.t2t_s2s_client_keys mk
           CROSS JOIN public.t2t_trusted_terminals t
          WHERE mk.key_id = $1
            AND t.terminal_id = $2
          FOR UPDATE OF mk, t`,
        [keyId, terminalId]
      );

      if (parents.rowCount !== 1) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "S2S key or trusted terminal not found"
        });
      }

      const parent = parents.rows[0];
      if (
        action === "grant" &&
        (parent.key_status !== "ACTIVE" ||
         parent.terminal_status !== "ACTIVE")
      ) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Active S2S key and trusted terminal required for grant"
        });
      }

      const mapping = await client.query(
        `SELECT status
           FROM public.t2t_s2s_key_terminals
          WHERE key_id = $1 AND terminal_id = $2
          FOR UPDATE`,
        [keyId, terminalId]
      );

      const current = mapping.rows[0]?.status;

      if (action === "grant" && current === "ACTIVE") {
        await client.query("COMMIT");
        return res.status(200).json({
          status: "ok", action, changed: false
        });
      }

      if (action === "revoke" && !current) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Authorization mapping not found"
        });
      }

      if (action === "revoke" && current === "REVOKED") {
        await client.query("COMMIT");
        return res.status(200).json({
          status: "ok", action, changed: false
        });
      }

      if (action === "grant" && current === "REVOKED") {
        await client.query(
          `UPDATE public.t2t_s2s_key_terminals
              SET status = 'ACTIVE', revoked_at = NULL
            WHERE key_id = $1 AND terminal_id = $2`,
          [keyId, terminalId]
        );
      } else if (action === "grant") {
        await client.query(
          `INSERT INTO public.t2t_s2s_key_terminals
             (key_id, terminal_id, status, revoked_at)
           VALUES ($1, $2, 'ACTIVE', NULL)`,
          [keyId, terminalId]
        );
      } else {
        await client.query(
          `UPDATE public.t2t_s2s_key_terminals
              SET status = 'REVOKED', revoked_at = NOW()
            WHERE key_id = $1 AND terminal_id = $2
              AND status = 'ACTIVE'`,
          [keyId, terminalId]
        );
      }

      await client.query(
        `INSERT INTO public.t2t_s2s_terminal_access_audit
           (key_id, terminal_id, action, actor_id)
         VALUES ($1, $2, $3, $4)`,
        [keyId, terminalId, action.toUpperCase(), actorId]
      );

      await client.query("COMMIT");
      return res.status(200).json({
        status: "ok", action, changed: true
      });
    } catch {
      if (client) {
        try { await client.query("ROLLBACK"); } catch {}
      }
      return res.status(503).json({
        error: "S2S terminal authorization operation unavailable"
      });
    } finally {
      client?.release();
    }
  };
}

export default createHandler();
