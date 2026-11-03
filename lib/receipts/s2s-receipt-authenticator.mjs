import crypto from "node:crypto";

const KEY_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const TERMINAL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NONCE_RE = /^[a-fA-F0-9]{32,64}$/;
const verifiedPrincipals = new WeakSet();

export function isVerifiedS2sReceiptPrincipal(value) {
  return value !== null && typeof value === "object" && verifiedPrincipals.has(value);
}

/**
 * Durable S2S principal, signature and replay checks for a receipt adapter.
 * The approved wire adapter supplies extraction, canonicalization and signature
 * verification because those values are protocol-specific.
 */
export function createS2sReceiptAuthenticator({
  poolProvider,
  parseAuthorization,
  buildCanonicalPayload,
  verifySignature,
  maxClockSkewMs,
  now = () => Date.now()
} = {}) {
  if (typeof poolProvider !== "function") throw new TypeError("A PostgreSQL pool provider is required");
  if (typeof parseAuthorization !== "function") throw new TypeError("An approved authorization parser is required");
  if (typeof buildCanonicalPayload !== "function") throw new TypeError("An approved signature canonicalizer is required");
  if (typeof verifySignature !== "function") throw new TypeError("An approved signature verifier is required");
  if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 1) {
    throw new TypeError("The approved timestamp window is required");
  }

  return async function authenticateReceiptRequest(request) {
    const claims = await parseAuthorization(request);
    const keyId = String(claims?.keyId ?? "");
    const terminalId = String(claims?.terminalId ?? "");
    const timestamp = claims?.timestampMs;
    const nonce = String(claims?.nonce ?? "");
    if (!KEY_ID_RE.test(keyId) || !TERMINAL_ID_RE.test(terminalId) ||
        !Number.isSafeInteger(timestamp) || Math.abs(now() - timestamp) > maxClockSkewMs ||
        !NONCE_RE.test(nonce)) {
      throw new Error("Invalid or expired S2S receipt authorization");
    }

    const client = await poolProvider().connect();
    try {
      await client.query("BEGIN");
      const principalResult = await client.query(
        `SELECT c.client_id, c.client_type, c.status AS client_status,
                mk.public_key_base64, mk.status AS key_status
           FROM public.t2t_s2s_client_keys mk
           JOIN public.t2t_s2s_clients c ON c.client_id = mk.client_id
          WHERE mk.key_id = $1
            AND mk.status = 'ACTIVE'
            AND c.status = 'ACTIVE'
          FOR UPDATE OF mk, c`,
        [keyId]
      );
      if (principalResult.rowCount !== 1) throw new Error("S2S client or key is not active");
      const principal = principalResult.rows[0];
      const terminalResult = await client.query(
        `SELECT t.terminal_id
           FROM public.t2t_trusted_terminals t
           JOIN public.t2t_s2s_key_terminals auth
             ON auth.terminal_id = t.terminal_id
            AND auth.key_id = $2
            AND auth.status = 'ACTIVE'
          WHERE t.terminal_id = $1
            AND t.status = 'ACTIVE'
          FOR UPDATE OF t, auth`,
        [terminalId, keyId]
      );
      if (terminalResult.rowCount !== 1) throw new Error("S2S key is not authorized for this active terminal");

      const canonicalPayload = await buildCanonicalPayload({ request, claims, principal });
      if (typeof canonicalPayload !== "string" || !canonicalPayload ||
          !await verifySignature({ publicKeyBase64: principal.public_key_base64, canonicalPayload, signature: claims.signature, request, claims })) {
        throw new Error("Invalid S2S receipt signature");
      }

      await client.query(
        `INSERT INTO public.t2t_s2s_request_nonces (key_id, nonce)
         VALUES ($1, $2)`,
        [keyId, nonce]
      );
      await client.query("COMMIT");
      const authenticatedPrincipal = Object.freeze({
        clientId: principal.client_id,
        keyId,
        terminalId,
        clientType: principal.client_type
      });
      verifiedPrincipals.add(authenticatedPrincipal);
      return authenticatedPrincipal;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      if (error?.code === "23505") throw new Error("S2S receipt nonce replay detected");
      throw error;
    } finally {
      client.release();
    }
  };
}

/** Existing T2T ECDSA-SHA256 verifier, usable only when the approved contract selects it. */
export function verifyP256EcdsaSha256({ publicKeyBase64, canonicalPayload, signature }) {
  try {
    if (typeof publicKeyBase64 !== "string" || typeof canonicalPayload !== "string" ||
        typeof signature !== "string" || signature.length < 40 || signature.length > 1024) return false;
    const bytes = Buffer.from(signature, "base64");
    if (bytes.length < 32 || bytes.toString("base64") !== signature) return false;
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki"
    });
    return crypto.verify("sha256", Buffer.from(canonicalPayload, "utf8"), publicKey, bytes);
  } catch {
    return false;
  }
}
