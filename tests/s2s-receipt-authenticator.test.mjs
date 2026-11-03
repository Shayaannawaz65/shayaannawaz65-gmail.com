import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createS2sReceiptAuthenticator, verifyP256EcdsaSha256 } from "../lib/receipts/s2s-receipt-authenticator.mjs";

const claims = {
  keyId: "skit-test-key-01",
  terminalId: "OFFLINE-201.3-001",
  timestampMs: 1_000_000,
  nonce: "a".repeat(32),
  signature: "test-signature"
};

function poolProvider({ replay = false, trusted = true, authorized = true } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM public.t2t_s2s_client_keys")) {
        return trusted
          ? { rowCount: 1, rows: [{ client_id: "skit-client-01", client_type: "POS", public_key_base64: "DER-SPKI" }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM public.t2t_trusted_terminals")) {
        return authorized ? { rowCount: 1, rows: [{ terminal_id: claims.terminalId }] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO public.t2t_s2s_request_nonces") && replay) {
        const error = new Error("duplicate nonce");
        error.code = "23505";
        throw error;
      }
      return { rowCount: 0, rows: [] };
    },
    release() { calls.push({ released: true }); }
  };
  return { provider: () => ({ connect: async () => client }), calls };
}

function createAuth(overrides = {}) {
  const pool = poolProvider(overrides);
  const auth = createS2sReceiptAuthenticator({
    poolProvider: pool.provider,
    parseAuthorization: async () => claims,
    buildCanonicalPayload: async ({ claims: parsed }) => `canonical:${parsed.nonce}`,
    verifySignature: async () => true,
    maxClockSkewMs: 120_000,
    now: () => claims.timestamp,
    ...overrides
  });
  return { auth, calls: pool.calls };
}

test("authenticates active key and authorized terminal, then persists nonce", async () => {
  const { auth, calls } = createAuth();
  assert.deepEqual(await auth({ body: "opaque" }), {
    clientId: "skit-client-01",
    keyId: claims.keyId,
    terminalId: claims.terminalId,
    clientType: "POS"
  });
  assert.ok(calls.some(call => call.sql?.includes("INSERT INTO public.t2t_s2s_request_nonces")));
  assert.ok(calls.some(call => call.sql === "COMMIT"));
});

test("rejects replayed nonce and rolls back", async () => {
  const { auth, calls } = createAuth({ replay: true });
  await assert.rejects(auth({}), /nonce replay/);
  assert.ok(calls.some(call => call.sql === "ROLLBACK"));
});

test("rejects unknown client/key and unauthorized terminal", async () => {
  const untrusted = createAuth({ trusted: false });
  await assert.rejects(untrusted.auth({}), /not active/);
  const unauthorized = createAuth({ authorized: false });
  await assert.rejects(unauthorized.auth({}), /not authorized/);
});

test("rejects stale timestamps before database access", async () => {
  const pool = poolProvider();
  const auth = createS2sReceiptAuthenticator({
    poolProvider: pool.provider,
    parseAuthorization: async () => ({ ...claims, timestampMs: 1 }),
    buildCanonicalPayload: async () => "canonical",
    verifySignature: async () => true,
    maxClockSkewMs: 10,
    now: () => 1000
  });
  await assert.rejects(auth({}), /expired/);
  assert.equal(pool.calls.length, 0);
});

test("does not consume nonce when signature verification fails", async () => {
  const { auth, calls } = createAuth({ verifySignature: async () => false });
  await assert.rejects(auth({}), /signature/);
  assert.equal(calls.some(call => call.sql?.includes("INSERT INTO public.t2t_s2s_request_nonces")), false);
});

test("P-256 signature verifier accepts only valid DER-SPKI/base64 ECDSA signatures", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const canonicalPayload = "approved-contract-test-payload";
  const signature = crypto.sign("sha256", Buffer.from(canonicalPayload), privateKey).toString("base64");
  assert.equal(verifyP256EcdsaSha256({ publicKeyBase64, canonicalPayload, signature }), true);
  assert.equal(verifyP256EcdsaSha256({ publicKeyBase64, canonicalPayload: "different", signature }), false);
});
