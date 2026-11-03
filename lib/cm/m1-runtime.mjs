import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createM1ReceiverClient } from "./m1-receiver-client.mjs";
import { isM1TreasuryWallet, M1_RECEIVER_CONTRACT } from "./m1-contract.mjs";

const APPROVED_AUTH_ENDPOINT = M1_RECEIVER_CONTRACT.authEndpoint;
const TOKEN_EXPIRY_SKEW_SECONDS = 60;

/** Load the local-only M1 credential file; Vercel must use server env vars. */
export function loadLocalM1Environment({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.VERCEL === "1" || typeof process.loadEnvFile !== "function") return false;
  const envFile = resolve(cwd, ".env.m1.local");
  if (!existsSync(envFile)) return false;
  process.loadEnvFile(envFile);
  return true;
}

export function getJwtExpirySeconds(jwtToken) {
  if (typeof jwtToken !== "string") return null;
  const pieces = jwtToken.split(".");
  if (pieces.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
    return Number.isSafeInteger(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

export function assertM1JwtCurrent(jwtToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  const expiry = getJwtExpirySeconds(jwtToken);
  if (expiry === null || expiry <= nowSeconds + TOKEN_EXPIRY_SKEW_SECONDS) {
    throw new Error("M1 receiver token is missing, malformed, or expired; dispatch was not sent");
  }
  return expiry;
}

function readTlsCertificate(env, cwd) {
  if (typeof env.M1_TLS_CA_CERT_PEM === "string" && env.M1_TLS_CA_CERT_PEM.trim()) {
    return env.M1_TLS_CA_CERT_PEM;
  }
  if (env.VERCEL !== "1") {
    const certPath = resolve(cwd, "config/certs/m1-receiver.pem");
    if (existsSync(certPath)) return readFileSync(certPath, "utf8");
  }
  throw new Error("M1_TLS_CA_CERT_PEM is not configured");
}

export function createConfiguredM1Receiver({ env = process.env, cwd = process.cwd(), nowSeconds } = {}) {
  const endpoint = env.M1_ENDPOINT || M1_RECEIVER_CONTRACT.endpoint;
  const serverId = env.M1_SERVER_ID || M1_RECEIVER_CONTRACT.serverId;
  const authEndpoint = env.M1_AUTH_ENDPOINT || APPROVED_AUTH_ENDPOINT;
  const network = env.M1_TOKEN_NETWORK || M1_RECEIVER_CONTRACT.network;
  const treasuryWallet = env.M1_TREASURY_WALLET || M1_RECEIVER_CONTRACT.treasuryWallet;
  if (endpoint !== M1_RECEIVER_CONTRACT.endpoint || authEndpoint !== APPROVED_AUTH_ENDPOINT ||
      serverId !== M1_RECEIVER_CONTRACT.serverId || network !== M1_RECEIVER_CONTRACT.network ||
      !isM1TreasuryWallet(treasuryWallet)) {
    throw new Error("M1 receiver configuration does not match the approved receiver");
  }

  const apiToken = env.M1_API_TOKEN;
  const jwtToken = env.M1_JWT_TOKEN;
  if (typeof apiToken !== "string" || !apiToken.trim() ||
      typeof jwtToken !== "string" || !jwtToken.trim()) {
    throw new Error("M1 API token configuration is incomplete");
  }
  assertM1JwtCurrent(jwtToken, nowSeconds);

  return Object.freeze({
    client: createM1ReceiverClient({
      apiToken,
      jwtToken,
      serverId,
      endpoint,
      network,
      treasuryWallet,
      certificatePem: readTlsCertificate(env, cwd)
    }),
    callbackUrl: typeof env.M1_CALLBACK_URL === "string" ? env.M1_CALLBACK_URL.trim() : "",
    authEndpoint,
    network,
    treasuryWallet
  });
}
