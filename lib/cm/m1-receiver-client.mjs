import https from "node:https";
import tls from "node:tls";
import { createHmac, X509Certificate } from "node:crypto";
import { isM1TreasuryWallet, M1_RECEIVER_CONTRACT } from "./m1-contract.mjs";

const EXPECTED_HOST = "140.245.233.184";
const EXPECTED_PATH = "/api/v1/settlement/receive";
const EXPECTED_SERVER_ID = M1_RECEIVER_CONTRACT.serverId;
const EXPECTED_FINGERPRINT =
  "12:D8:0E:78:74:EE:56:1D:2A:6C:7E:61:C2:B8:ED:E6:BB:BE:15:DE:09:40:54:5B:B9:A6:00:80:61:58:A5:DE";

const REQUIRED_FIELDS = [
  "transaction_id", "amount", "currency", "settlement_currency",
  "exchange_rate", "settlement_amount", "debtor_name", "debtor_account",
  "creditor_name", "creditor_account", "reference", "narrative",
  "callback_url"
];

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function validateInstruction(instruction, { network, treasuryWallet }) {
  if (!instruction || typeof instruction !== "object" || Array.isArray(instruction)) {
    throw new TypeError("Settlement instruction object is required");
  }
  for (const field of REQUIRED_FIELDS) requiredString(String(instruction[field] ?? ""), field);

  const callback = new URL(instruction.callback_url);
  if (callback.protocol !== "https:") throw new TypeError("callback_url must use HTTPS");

  const tokenization = instruction.tokenization_details;
  if (!tokenization || typeof tokenization !== "object") throw new TypeError("tokenization_details is required");
  for (const field of ["token_type", "network", "wallet_address"]) {
    requiredString(tokenization[field], `tokenization_details.${field}`);
  }
  if (tokenization.token_type !== M1_RECEIVER_CONTRACT.tokenType) {
    throw new Error("M1 settlement token type does not match the approved receiver contract");
  }
  if (tokenization.network !== network || network !== M1_RECEIVER_CONTRACT.network) {
    throw new Error("M1 settlement network must be TRON Mainnet TRC20");
  }
  if (!isM1TreasuryWallet(treasuryWallet) || !isM1TreasuryWallet(tokenization.wallet_address) ||
      tokenization.wallet_address !== treasuryWallet) {
    throw new Error("M1 settlement wallet must be the configured TRON TRC20 wallet");
  }
}

function nativeHttpsTransport({ url, headers, body, certificatePem, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(target, {
      method: "POST",
      headers,
      ca: certificatePem,
      rejectUnauthorized: true,
      timeout: timeoutMs,
      checkServerIdentity(host, certificate) {
        const standardError = tls.checkServerIdentity(host, certificate);
        if (standardError) return standardError;
        const actual = new X509Certificate(certificate.raw).fingerprint256;
        if (actual !== EXPECTED_FINGERPRINT) return new Error("M1 TLS certificate fingerprint mismatch");
      }
    }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 65536) {
          request.destroy(new Error("M1 response exceeded size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("timeout", () => request.destroy(new Error("M1 request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function jwtExpirySeconds(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return Number.isSafeInteger(claims.exp) ? claims.exp : null;
  } catch {
    return null;
  }
}

export function createM1ReceiverClient({
  apiToken, serverId, endpoint, authEndpoint = M1_RECEIVER_CONTRACT.authEndpoint,
  network, treasuryWallet, certificatePem, requestSignatureSecret = "",
  transport = nativeHttpsTransport, timeoutMs = 15000,
  nowSeconds = () => Math.floor(Date.now() / 1000)
} = {}) {
  apiToken = requiredString(apiToken, "M1 API token");
  serverId = requiredString(serverId, "M1 server ID");
  endpoint = requiredString(endpoint, "M1 endpoint");
  authEndpoint = requiredString(authEndpoint, "M1 auth endpoint");
  network = requiredString(network, "M1 token network");
  treasuryWallet = requiredString(treasuryWallet, "M1 treasury wallet");
  certificatePem = requiredString(certificatePem, "M1 certificate");
  if (serverId !== EXPECTED_SERVER_ID || network !== M1_RECEIVER_CONTRACT.network ||
      !isM1TreasuryWallet(treasuryWallet)) {
    throw new Error("M1 server, TRON network, or treasury wallet does not match the approved receiver contract");
  }
  if (requestSignatureSecret !== "" &&
      (typeof requestSignatureSecret !== "string" || requestSignatureSecret.length < 32)) {
    throw new Error("M1 HMAC request-signature secret must be at least 32 characters");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("M1 timeout must be a positive integer in milliseconds");
  }

  const url = new URL(endpoint);
  const authUrl = new URL(authEndpoint);
  if (url.protocol !== "https:" || url.hostname !== EXPECTED_HOST ||
      url.pathname !== EXPECTED_PATH || url.search || url.hash ||
      authUrl.toString() !== M1_RECEIVER_CONTRACT.authEndpoint) {
    throw new Error("M1 endpoint or token endpoint does not match the approved receiver contract");
  }
  const cert = new X509Certificate(certificatePem);
  if (cert.fingerprint256 !== EXPECTED_FINGERPRINT || !cert.checkHost(EXPECTED_HOST)) {
    throw new Error("Configured M1 certificate does not match the approved pin");
  }

  let cachedToken = null;
  let cachedExpiry = 0;
  let tokenRequest = null;

  async function getReceiverToken() {
    const now = nowSeconds();
    if (cachedToken && cachedExpiry > now + 60) return cachedToken;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const body = JSON.stringify({ sub: serverId });
      const response = await transport({
        url: authEndpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-API-TOKEN": apiToken,
          "Content-Length": Buffer.byteLength(body)
        },
        body,
        certificatePem,
        timeoutMs
      });
      if (response.statusCode !== 200) {
        throw new Error("M1 receiver-token endpoint rejected authentication");
      }
      let tokenResponse;
      try {
        tokenResponse = JSON.parse(response.body || "");
      } catch {
        throw new Error("M1 receiver-token endpoint returned invalid JSON");
      }
      if (!tokenResponse || typeof tokenResponse !== "object" ||
          Array.isArray(tokenResponse) ||
          typeof tokenResponse.access_token !== "string" ||
          tokenResponse.server_id !== serverId ||
          tokenResponse.endpoint !== endpoint) {
        throw new Error("M1 receiver-token identity or endpoint did not match the approved receiver");
      }
      const expiry = jwtExpirySeconds(tokenResponse.access_token);
      if (expiry === null || expiry <= nowSeconds() + 60) {
        throw new Error("M1 receiver-token response contained an expired or invalid JWT");
      }
      cachedToken = tokenResponse.access_token;
      cachedExpiry = expiry;
      return cachedToken;
    })();
    try {
      return await tokenRequest;
    } finally {
      tokenRequest = null;
    }
  }

  return Object.freeze({
    async submitSettlement({ instruction, idempotencyKey, requestId } = {}) {
      validateInstruction(instruction, { network, treasuryWallet });
      idempotencyKey = requiredString(idempotencyKey, "Idempotency key");
      const jwtToken = await getReceiverToken();
      if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
        throw new TypeError("Idempotency key format is invalid");
      }

      const bodyObject = {
        ...instruction,
        receiver: {
          server_id: serverId,
          endpoint,
          jwt_token: jwtToken,
          tls_verify: true
        },
        tokenization_details: {
          token_type: instruction.tokenization_details.token_type,
          network: instruction.tokenization_details.network,
          wallet_address: instruction.tokenization_details.wallet_address
        }
      };
      const body = JSON.stringify(bodyObject);
      const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-API-TOKEN": apiToken,
        "Authorization": `Bearer ${jwtToken}`,
        "X-Idempotency-Key": idempotencyKey,
        "Content-Length": Buffer.byteLength(body)
      };
      if (requestSignatureSecret) {
        headers["X-Request-Signature"] = createHmac("sha256", requestSignatureSecret)
          .update(body).digest("base64url");
      }
      if (requestId !== undefined) headers["X-Request-Id"] = requiredString(requestId, "Request ID");

      const response = await transport({ url: endpoint, method: "POST", headers, body, certificatePem, timeoutMs });
      if (response.statusCode === 409) {
        const error = new Error("M1 reported an idempotency or transaction conflict");
        error.code = "M1_CONFLICT";
        throw error;
      }
      if (response.statusCode !== 202) {
        const error = new Error(`M1 returned unexpected HTTP status ${response.statusCode}`);
        error.code = "M1_UNEXPECTED_STATUS";
        error.statusCode = response.statusCode;
        throw error;
      }
      let responseBody = null;
      try {
        responseBody = response.body ? JSON.parse(response.body) : null;
      } catch {
        throw new Error("M1 returned an invalid JSON response");
      }
      if (responseBody !== null && (typeof responseBody !== "object" || Array.isArray(responseBody))) {
        throw new Error("M1 returned an invalid JSON response shape");
      }
      return Object.freeze({ status: "ACCEPTED", settled: false, httpStatus: 202, response: responseBody });
    }
  });
}
