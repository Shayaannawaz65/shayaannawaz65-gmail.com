import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const TERMINAL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
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

function validP256PublicKey(value) {
  if (typeof value !== "string" || value.length < 100 || value.length > 1024) return false;
  try {
    const der = Buffer.from(value, "base64");
    if (der.toString("base64") !== value) return false;
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" &&
      key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
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
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const auth = authenticate(req, env);
    if (auth.unavailable) return res.status(503).json({ error: "Terminal administration is not configured" });
    if (!auth.ok) return res.status(401).json({ error: "Unauthorized" });

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const action = body.action;
    const terminalId = String(body.terminalId || "").trim();
    const publicKeyBase64 = body.publicKeyBase64;
    if (!TERMINAL_ID_RE.test(terminalId) ||
        !["register", "revoke", "rotate_key"].includes(action) ||
        ((action === "register" || action === "rotate_key") && !validP256PublicKey(publicKeyBase64))) {
      return res.status(400).json({ error: "Invalid terminal administration request" });
    }

    let client;
    let inTransaction = false;
    try {
      client = await poolProvider().connect();
      await client.query("BEGIN");
      inTransaction = true;
      const existing = await client.query(
        `SELECT terminal_id, public_key_base64, status
           FROM public.t2t_trusted_terminals
          WHERE terminal_id = $1
          FOR UPDATE`,
        [terminalId]
      );

      if (action === "register") {
        if (existing.rowCount !== 0) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return res.status(409).json({ error: "Terminal ID already exists; use the explicit key rotation action if authorized" });
        }
        await client.query(
          `INSERT INTO public.t2t_trusted_terminals
             (terminal_id, public_key_base64, status)
           VALUES ($1, $2, 'ACTIVE')`,
          [terminalId, publicKeyBase64]
        );
      } else {
        if (existing.rowCount !== 1) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return res.status(404).json({ error: "Trusted terminal not found" });
        }
        if (action === "revoke") {
          if (existing.rows[0].status === "REVOKED") {
            await client.query("COMMIT");
            inTransaction = false;
            return res.status(200).json({ status: "ok", action, changed: false, terminalId });
          }
          await client.query(
            `UPDATE public.t2t_trusted_terminals
                SET status = 'REVOKED'
              WHERE terminal_id = $1`,
            [terminalId]
          );
        } else {
          await client.query(
            `UPDATE public.t2t_trusted_terminals
                SET public_key_base64 = $2, status = 'ACTIVE'
              WHERE terminal_id = $1`,
            [terminalId, publicKeyBase64]
          );
        }
      }

      await client.query(
        `INSERT INTO public.t2t_trusted_terminal_admin_audit
           (terminal_id, action, actor_id)
         VALUES ($1, $2, $3)`,
        [terminalId, action === "rotate_key" ? "ROTATE_KEY" : action.toUpperCase(), auth.actorId]
      );
      await client.query("COMMIT");
      inTransaction = false;
      return res.status(action === "register" ? 201 : 200).json({
        status: "ok", action, changed: true, terminalId
      });
    } catch {
      if (inTransaction && client) {
        try { await client.query("ROLLBACK"); } catch {}
      }
      return res.status(503).json({ error: "Terminal administration failed" });
    } finally {
      client?.release();
    }
  };
}

export default createHandler();
