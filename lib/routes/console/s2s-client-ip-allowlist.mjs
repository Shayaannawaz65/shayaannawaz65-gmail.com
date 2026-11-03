import crypto from "node:crypto";
import pg from "pg";
import { normalizeIpNetwork } from "../../s2s-client-ip.mjs";

const { Pool } = pg;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const ACTOR_RE = /^[A-Za-z0-9._-]{1,64}$/;
let pool;

function getPool(env = process.env) {
  if (!pool) {
    const connectionString = env.T2T_DATABASE_URL ||
      env.DATABASE_URL_UNPOOLED || env.POSTGRES_URL_NON_POOLING ||
      env.DATABASE_URL || env.POSTGRES_URL;
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

function authenticate(req, env) {
  const expected = env.T2T_S2S_AUTHORIZATION_ADMIN_TOKEN;
  const actorId = env.T2T_S2S_AUTHORIZATION_ADMIN_ID;
  const header = String(req.headers?.authorization || "");
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (typeof expected !== "string" || expected.length < 32 ||
      typeof actorId !== "string" || !ACTOR_RE.test(actorId)) {
    return { unavailable: true };
  }
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return {
    ok: a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b),
    actorId
  };
}

export function createHandler({ env = process.env, poolProvider = () => getPool(env) } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    if (!["GET", "POST"].includes(req.method)) {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const auth = authenticate(req, env);
    if (auth.unavailable) {
      return res.status(503).json({ error: "S2S client administration is not configured" });
    }
    if (!auth.ok) return res.status(401).json({ error: "Unauthorized" });

    const clientId = String(req.method === "GET"
      ? req.query?.clientId ?? ""
      : req.body?.clientId ?? "").trim();
    if (!CLIENT_ID_RE.test(clientId)) {
      return res.status(400).json({ error: "Valid merchant client ID required" });
    }

    if (req.method === "GET") {
      try {
        const result = await poolProvider().query(
          `SELECT a.allowlist_id, a.network::text AS network, a.status,
                  a.created_by, a.created_at, a.updated_at
             FROM public.t2t_s2s_client_ip_allowlist a
             JOIN public.t2t_s2s_clients c ON c.client_id = a.client_id
            WHERE a.client_id = $1 AND c.client_type = 'MERCHANT'
            ORDER BY a.network, a.allowlist_id`,
          [clientId]
        );
        return res.status(200).json({ clientId, records: result.rows });
      } catch {
        return res.status(503).json({ error: "Merchant IP allowlist unavailable" });
      }
    }

    const body = req.body;
    const action = body?.action;
    const network = normalizeIpNetwork(body?.network);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !["allow", "revoke"].includes(action) || !network) {
      return res.status(400).json({ error: "Invalid IP allowlist request" });
    }

    let client;
    let inTransaction = false;
    try {
      client = await poolProvider().connect();
      await client.query("BEGIN");
      inTransaction = true;

      const merchant = await client.query(
        `SELECT client_id, client_type
           FROM public.t2t_s2s_clients
          WHERE client_id = $1
          FOR UPDATE`,
        [clientId]
      );
      if (merchant.rowCount !== 1 || merchant.rows[0].client_type !== "MERCHANT") {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(404).json({ error: "Merchant client not found" });
      }

      let result;
      if (action === "allow") {
        result = await client.query(
          `INSERT INTO public.t2t_s2s_client_ip_allowlist
             (client_id, network, status, created_by)
           VALUES ($1, $2::cidr, 'ACTIVE', $3)
           ON CONFLICT (client_id, network) DO UPDATE
             SET status = 'ACTIVE', updated_at = NOW()
           RETURNING allowlist_id, network::text AS network, status,
                     created_by, created_at, updated_at`,
          [clientId, network, auth.actorId]
        );
      } else {
        result = await client.query(
          `UPDATE public.t2t_s2s_client_ip_allowlist
              SET status = 'REVOKED', updated_at = NOW()
            WHERE client_id = $1 AND network = $2::cidr AND status = 'ACTIVE'
            RETURNING allowlist_id, network::text AS network, status,
                      created_by, created_at, updated_at`,
          [clientId, network]
        );
        if (result.rowCount === 0) {
          const existing = await client.query(
            `SELECT allowlist_id, network::text AS network, status,
                    created_by, created_at, updated_at
               FROM public.t2t_s2s_client_ip_allowlist
              WHERE client_id = $1 AND network = $2::cidr`,
            [clientId, network]
          );
          if (existing.rowCount === 0) {
            await client.query("ROLLBACK");
            inTransaction = false;
            return res.status(404).json({ error: "IP allowlist entry not found" });
          }
          result = existing;
        }
      }

      await client.query(
        `INSERT INTO public.t2t_s2s_client_ip_audit
           (client_id, network, action, actor_id)
         VALUES ($1, $2::cidr, $3, $4)`,
        [clientId, network, action === "allow" ? "ALLOW" : "REVOKE", auth.actorId]
      );
      await client.query("COMMIT");
      inTransaction = false;
      return res.status(200).json({
        status: "ok",
        action,
        entry: result.rows[0]
      });
    } catch {
      if (inTransaction && client) {
        try { await client.query("ROLLBACK"); } catch {}
      }
      return res.status(503).json({ error: "Merchant IP allowlist update failed" });
    } finally {
      client?.release();
    }
  };
}

export default createHandler();
