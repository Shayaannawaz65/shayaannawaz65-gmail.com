import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const ACTOR_RE = /^[A-Za-z0-9._-]{1,64}$/;
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
      max: 3,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000
    });
  }
  return pool;
}

function validPublicKey(value) {
  if (typeof value !== "string" || value.length < 100 || value.length > 1024) {
    return false;
  }

  try {
    const der = Buffer.from(value, "base64");
    if (der.toString("base64") !== value) return false;

    const key = crypto.createPublicKey({
      key: der,
      format: "der",
      type: "spki"
    });

    return key.asymmetricKeyType === "ec" &&
      key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

function authorized(req, env) {
  const expected = env.T2T_S2S_AUTHORIZATION_ADMIN_TOKEN;
  const actorId = env.T2T_S2S_AUTHORIZATION_ADMIN_ID;
  const header = String(req.headers?.authorization || "");
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (
    typeof expected !== "string" || expected.length < 32 ||
    typeof actorId !== "string" || !ACTOR_RE.test(actorId)
  ) return { ok: false, unavailable: true };

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return {
    ok: a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b),
    actorId
  };
}

export function createHandler({ env = process.env, poolProvider = getPool } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");

    if (!["GET", "POST"].includes(req.method)) {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const auth = authorized(req, env);
    if (auth.unavailable) {
      return res.status(503).json({ error: "S2S client administration is not configured" });
    }
    if (!auth.ok) return res.status(401).json({ error: "Unauthorized" });

    if (req.method === "GET") {
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
          `SELECT audit_id, client_id, key_id, action, actor_id, created_at
             FROM public.t2t_s2s_client_admin_audit
            ORDER BY created_at DESC, audit_id DESC
            LIMIT $1 OFFSET $2`,
          [Number(limitText), Number(offsetText)]
        );
        return res.status(200).json({
          records: result.rows.map(row => ({
            auditId: String(row.audit_id),
            clientId: row.client_id,
            keyId: row.key_id,
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
        return res.status(503).json({ error: "S2S client audit unavailable" });
      }
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { action } = body;
    if (!["create_client", "register_key", "revoke_client", "revoke_key"].includes(action)) {
      return res.status(400).json({ error: "Unsupported action" });
    }

    if (action === "create_client") {
      const { clientId, clientType, displayName, keyId, publicKeyBase64 } = body;
      if (
        typeof clientId !== "string" || !ID_RE.test(clientId) ||
        !["BANK", "MERCHANT", "POS", "T2T_INTERNAL"].includes(clientType) ||
        typeof displayName !== "string" ||
        displayName !== displayName.trim() ||
        displayName.length < 1 || displayName.length > 160 ||
        typeof keyId !== "string" || !ID_RE.test(keyId) ||
        !validPublicKey(publicKeyBase64)
      ) {
        return res.status(400).json({ error: "Invalid client or P-256 public-key fields" });
      }
    }

    if (action === "register_key") {
      if (
        typeof body.clientId !== "string" || !ID_RE.test(body.clientId) ||
        typeof body.keyId !== "string" || !ID_RE.test(body.keyId) ||
        !validPublicKey(body.publicKeyBase64)
      ) {
        return res.status(400).json({ error: "Invalid client, key ID or P-256 public key" });
      }
    }

    if (action === "revoke_client" &&
        (typeof body.clientId !== "string" || !ID_RE.test(body.clientId))) {
      return res.status(400).json({ error: "Invalid client ID" });
    }

    if (action === "revoke_key" &&
        (typeof body.keyId !== "string" || !ID_RE.test(body.keyId))) {
      return res.status(400).json({ error: "Invalid key ID" });
    }

    let client;
    try {
      client = await poolProvider().connect();
      await client.query("BEGIN");

      let result;

      if (action === "create_client") {
        const inserted = await client.query(
          `INSERT INTO public.t2t_s2s_clients
             (client_id, client_type, display_name, status)
           VALUES ($1, $2, $3, 'ACTIVE')
           RETURNING client_id, client_type, display_name, status`,
          [body.clientId, body.clientType, body.displayName]
        );

        await client.query(
          `INSERT INTO public.t2t_s2s_client_keys
             (key_id, client_id, public_key_base64, status)
           VALUES ($1, $2, $3, 'ACTIVE')`,
          [body.keyId, body.clientId, body.publicKeyBase64]
        );

        await client.query(
          `INSERT INTO public.t2t_s2s_client_admin_audit
             (client_id, key_id, action, actor_id)
           VALUES ($1, $2, 'CREATE_CLIENT', $3)`,
          [body.clientId, body.keyId, auth.actorId]
        );

        result = {
          action,
          client: inserted.rows[0],
          keyId: body.keyId,
          keyStatus: "ACTIVE"
        };
      }

      if (action === "register_key") {
        const parent = await client.query(
          `SELECT client_id, status
             FROM public.t2t_s2s_clients
            WHERE client_id = $1
            FOR UPDATE`,
          [body.clientId]
        );
        if (!parent.rowCount) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "S2S client not found" });
        }
        if (parent.rows[0].status !== "ACTIVE") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Cannot register a key to a revoked client" });
        }

        await client.query(
          `INSERT INTO public.t2t_s2s_client_keys
             (key_id, client_id, public_key_base64, status)
           VALUES ($1, $2, $3, 'ACTIVE')`,
          [body.keyId, body.clientId, body.publicKeyBase64]
        );

        await client.query(
          `INSERT INTO public.t2t_s2s_client_admin_audit
             (client_id, key_id, action, actor_id)
           VALUES ($1, $2, 'REGISTER_KEY', $3)`,
          [body.clientId, body.keyId, auth.actorId]
        );
        result = { action, clientId: body.clientId, keyId: body.keyId, keyStatus: "ACTIVE" };
      }

      if (action === "revoke_key") {
        const updated = await client.query(
          `UPDATE public.t2t_s2s_client_keys
              SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, NOW())
            WHERE key_id = $1 AND status = 'ACTIVE'
            RETURNING key_id, client_id`,
          [body.keyId]
        );
        if (!updated.rowCount) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Active S2S key not found" });
        }

        await client.query(
          `INSERT INTO public.t2t_s2s_client_admin_audit
             (client_id, key_id, action, actor_id)
           VALUES ($1, $2, 'REVOKE_KEY', $3)`,
          [updated.rows[0].client_id, body.keyId, auth.actorId]
        );
        result = { action, keyId: body.keyId, keyStatus: "REVOKED" };
      }

      if (action === "revoke_client") {
        const updated = await client.query(
          `UPDATE public.t2t_s2s_clients
              SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, NOW())
            WHERE client_id = $1 AND status = 'ACTIVE'
            RETURNING client_id`,
          [body.clientId]
        );
        if (!updated.rowCount) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Active S2S client not found" });
        }

        const keys = await client.query(
          `UPDATE public.t2t_s2s_client_keys
              SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, NOW())
            WHERE client_id = $1 AND status = 'ACTIVE'
            RETURNING key_id`,
          [body.clientId]
        );

        await client.query(
          `INSERT INTO public.t2t_s2s_client_admin_audit
             (client_id, action, actor_id)
           VALUES ($1, 'REVOKE_CLIENT', $2)`,
          [body.clientId, auth.actorId]
        );
        result = {
          action,
          clientId: body.clientId,
          clientStatus: "REVOKED",
          revokedKeys: keys.rowCount
        };
      }

      await client.query("COMMIT");
      return res.status(200).json({ status: "ok", ...result });
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch {}
      }
      if (error?.code === "23505") {
        return res.status(409).json({ error: "Client ID or key ID already exists" });
      }
      return res.status(503).json({ error: "S2S client administration database operation failed" });
    } finally {
      client?.release();
    }
  };
}

export default createHandler();
