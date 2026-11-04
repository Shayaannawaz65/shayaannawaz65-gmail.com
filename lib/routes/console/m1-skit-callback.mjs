import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
let pool;

function getPool(env) {
  if (!pool) {
    const connectionString = env.T2T_DATABASE_URL || env.DATABASE_URL_UNPOOLED ||
      env.POSTGRES_URL_NON_POOLING || env.DATABASE_URL || env.POSTGRES_URL;
    if (!connectionString || connectionString.includes("[SENSITIVE]")) {
      throw new Error("M1 callback database is not configured");
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

function getHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : typeof value === "string" ? value : "";
}

async function readRawBody(req, maxBytes = 65536) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === "string") return Buffer.from(req.rawBody, "utf8");
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  if (!req.body && req && typeof req[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new Error("M1 callback body exceeds size limit");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Original callback body bytes are unavailable");
}

function callbackConfig(env) {
  const secret = env.M1_CALLBACK_HMAC_SECRET;
  const signatureHeader = String(env.M1_CALLBACK_SIGNATURE_HEADER || "").trim().toLowerCase();
  const eventIdHeader = String(env.M1_CALLBACK_EVENT_ID_HEADER || "").trim().toLowerCase();
  const encoding = String(env.M1_CALLBACK_SIGNATURE_ENCODING || "").trim().toLowerCase();
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32 ||
      !/^[a-z0-9-]{3,80}$/.test(signatureHeader) ||
      !/^[a-z0-9-]{3,80}$/.test(eventIdHeader) ||
      !["hex", "base64url"].includes(encoding)) {
    return null;
  }
  let statusMap;
  try {
    statusMap = JSON.parse(String(env.M1_CALLBACK_STATUS_MAP || ""));
  } catch {
    return null;
  }
  if (!statusMap || typeof statusMap !== "object" || Array.isArray(statusMap)) return null;
  const allowed = new Set(["ACCEPTED", "PROCESSING", "SETTLED", "REJECTED", "UNKNOWN"]);
  for (const [external, internal] of Object.entries(statusMap)) {
    if (!external.trim() || !allowed.has(internal)) return null;
  }
  return { secret, signatureHeader, eventIdHeader, encoding, statusMap };
}

function verifySignature(rawBody, supplied, config) {
  if (!supplied || supplied.length > 256) return false;
  const expected = crypto.createHmac("sha256", config.secret)
    .update(rawBody).digest(config.encoding);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizedPayload(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new TypeError("Callback body must be valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Callback body must be a JSON object");
  }
  const transactionId = typeof payload.transaction_id === "string"
    ? payload.transaction_id.trim() : "";
  const status = typeof payload.status === "string" ? payload.status.trim().toUpperCase() : "";
  if (!transactionId || transactionId.length > 200 || !status || status.length > 80) {
    throw new TypeError("Callback transaction_id and status are required");
  }
  const settlementReference = typeof payload.settlement_ref === "string"
    ? payload.settlement_ref.trim().slice(0, 200) : null;
  return { transactionId, status, settlementReference };
}

const TERMINAL = new Set(["SETTLED", "REJECTED"]);
const TRANSITIONS = Object.freeze({
  NOT_REPORTED: new Set(["ACCEPTED", "PROCESSING", "SETTLED", "REJECTED", "UNKNOWN"]),
  ACCEPTED: new Set(["PROCESSING", "SETTLED", "REJECTED", "UNKNOWN"]),
  PROCESSING: new Set(["SETTLED", "REJECTED", "UNKNOWN"]),
  UNKNOWN: new Set(["ACCEPTED", "PROCESSING", "SETTLED", "REJECTED"]),
  SETTLED: new Set(),
  REJECTED: new Set()
});

export function createSkitCallbackHandler({
  env = process.env,
  poolProvider = () => getPool(env),
  readBody = readRawBody,
  onError = () => {}
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const config = callbackConfig(env);
    if (!config) return res.status(503).json({ error: "M1 callback authentication is not configured" });

    let rawBody;
    let callback;
    try {
      rawBody = await readBody(req);
      if (!Buffer.isBuffer(rawBody) || rawBody.length < 2 || rawBody.length > 65536) {
        return res.status(400).json({ error: "Invalid callback body size" });
      }
      const signature = getHeader(req, config.signatureHeader);
      const eventId = getHeader(req, config.eventIdHeader).trim();
      if (!eventId || eventId.length > 200) {
        return res.status(401).json({ error: "Missing or invalid callback event ID" });
      }
      if (!verifySignature(rawBody, signature, config)) {
        return res.status(403).json({ error: "Callback signature verification failed" });
      }
      callback = normalizedPayload(rawBody);
    } catch (error) {
      return res.status(error instanceof TypeError ? 400 : 503).json({ error: "Invalid callback request" });
    }

    const mappedStatus = config.statusMap[callback.status] || "UNKNOWN";
    const payloadHash = crypto.createHash("sha256").update(rawBody).digest("hex");
    const safePayload = {
      transaction_id: callback.transactionId,
      status: callback.status,
      ...(callback.settlementReference ? { settlement_ref: callback.settlementReference } : {})
    };
    const client = await poolProvider().connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        `SELECT instruction_id, settlement_status
           FROM public.t2t_m1_settlement_outbox
          WHERE transaction_id = $1
          FOR UPDATE`,
        [callback.transactionId]
      );
      if (found.rowCount !== 1) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Unknown M1 transaction" });
      }
      const instruction = found.rows[0];
      const inserted = await client.query(
        `INSERT INTO public.t2t_m1_settlement_callback_events
           (external_event_id, instruction_id, payload_hash, signature_verified,
            external_status, mapped_status, payload)
         VALUES ($1,$2,$3,true,$4,$5,$6::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING callback_event_id`,
        [eventId, instruction.instruction_id, payloadHash, callback.status,
          mappedStatus, JSON.stringify(safePayload)]
      );
      if (inserted.rowCount !== 1) {
        await client.query("ROLLBACK");
        return res.status(200).json({ status: "DUPLICATE", duplicate: true });
      }

      const currentStatus = instruction.settlement_status || "NOT_REPORTED";
      let effectiveStatus = currentStatus;
      if (!TERMINAL.has(currentStatus) && TRANSITIONS[currentStatus]?.has(mappedStatus)) {
        await client.query(
          `UPDATE public.t2t_m1_settlement_outbox
              SET settlement_status = $2,
                  settlement_status_at = NOW(),
                  external_settlement_reference = COALESCE($3, external_settlement_reference),
                  updated_at = NOW()
            WHERE instruction_id = $1`,
          [instruction.instruction_id, mappedStatus, callback.settlementReference]
        );
        effectiveStatus = mappedStatus;
      }
      await client.query(
        `UPDATE public.t2t_m1_settlement_callback_events
            SET processed_at = NOW()
          WHERE callback_event_id = $1`,
        [inserted.rows[0].callback_event_id]
      );
      await client.query("COMMIT");
      return res.status(200).json({
        status: "PROCESSED",
        transaction_id: callback.transactionId,
        settlement_status: effectiveStatus
      });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      try { onError(error); } catch {}
      return res.status(503).json({ error: "Callback could not be committed; sender may retry" });
    } finally {
      client.release();
    }
  };
}

export default createSkitCallbackHandler();
