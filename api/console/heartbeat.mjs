import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const TERMINAL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NONCE_RE = /^[a-f0-9]{32,64}$/i;
let pool;

function getPool() {
  if (!pool) {
    const connectionString =
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

export function createHandler({ poolProvider = getPool, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const terminalId = String(body.terminalId || "");
    const timestamp = Number(body.timestamp);
    const nonce = String(body.nonce || "");
    const signatureB64 = String(body.signature || "");

    if (
      !TERMINAL_ID_RE.test(terminalId) ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(now() - timestamp) > MAX_CLOCK_SKEW_MS ||
      !NONCE_RE.test(nonce) ||
      signatureB64.length < 40 ||
      signatureB64.length > 1024
    ) {
      return res.status(400).json({ error: "Invalid heartbeat" });
    }

    let signature;
    try {
      signature = Buffer.from(signatureB64, "base64");
      if (signature.length < 32 || signature.toString("base64") !== signatureB64) {
        return res.status(400).json({ error: "Invalid heartbeat" });
      }
    } catch {
      return res.status(400).json({ error: "Invalid heartbeat" });
    }

    const clientPool = poolProvider();
    let client;

    try {
      client = await clientPool.connect();
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT public_key_base64
           FROM public.t2t_trusted_terminals
          WHERE terminal_id = $1 AND status = 'ACTIVE'
          FOR UPDATE`,
        [terminalId]
      );

      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return res.status(401).json({ error: "Terminal not trusted" });
      }

      const canonical = `${terminalId}\n${timestamp}\n${nonce}`;
      let verified = false;

      try {
        const publicKey = crypto.createPublicKey({
          key: Buffer.from(result.rows[0].public_key_base64, "base64"),
          format: "der",
          type: "spki"
        });

        verified = crypto.verify(
          "sha256",
          Buffer.from(canonical, "utf8"),
          publicKey,
          signature
        );
      } catch {
        verified = false;
      }

      if (!verified) {
        await client.query("ROLLBACK");
        return res.status(401).json({ error: "Invalid terminal signature" });
      }

      await client.query(
        `INSERT INTO public.t2t_heartbeat_nonces (terminal_id, nonce)
         VALUES ($1, $2)`,
        [terminalId, nonce]
      );

      await client.query(
        `UPDATE public.t2t_trusted_terminals
            SET last_seen_at = NOW()
          WHERE terminal_id = $1`,
        [terminalId]
      );

      await client.query("COMMIT");
      return res.status(200).json({
        accepted: true,
        terminalId,
        serverTime: new Date(now()).toISOString()
      });
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch {}
      }

      if (error?.code === "23505") {
        return res.status(409).json({ error: "Heartbeat replay rejected" });
      }

      // Never return database or cryptographic internals to the client.
      return res.status(503).json({ error: "Heartbeat temporarily unavailable" });
    } finally {
      client?.release();
    }
  };
}

export default createHandler();
