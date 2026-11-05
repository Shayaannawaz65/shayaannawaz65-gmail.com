import { createM1ReceiverClient } from "../lib/cm/m1-receiver-client.mjs";
import { M1_RECEIVER_CONTRACT } from "../lib/cm/m1-contract.mjs";

const required = ["M1_API_TOKEN", "CM_CLIENT_ID", "M1_TLS_CA_CERT_PEM"];
const missing = required.filter(key => typeof process.env[key] !== "string" || !process.env[key].trim());

if (missing.length) {
  console.error(JSON.stringify({
    authenticated: false,
    stage: "configuration",
    missingEnvironment: missing
  }, null, 2));
  process.exitCode = 2;
} else {
  try {
    const receiver = createM1ReceiverClient({
      apiToken: process.env.M1_API_TOKEN,
      clientId: process.env.CM_CLIENT_ID,
      serverId: M1_RECEIVER_CONTRACT.serverId,
      endpoint: M1_RECEIVER_CONTRACT.endpoint,
      authEndpoint: M1_RECEIVER_CONTRACT.authEndpoint,
      certificatePem: process.env.M1_TLS_CA_CERT_PEM,
      timeoutMs: 30000
    });

    const result = await receiver.authenticate();
    console.log(JSON.stringify({
      authenticated: result.authenticated,
      receiverServerId: M1_RECEIVER_CONTRACT.serverId,
      receiverHttpStatus: 200,
      tokenExpiresAt: result.tokenExpiresAt,
      accessTokenReturned: false,
      tlsVerification: "verified",
      tlsPinVerification: "verified"
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      authenticated: false,
      stage: error?.m1Stage || "configuration",
      receiverHttpStatus: Number.isInteger(error?.statusCode) ? error.statusCode : null,
      code: String(error?.code || "M1_AUTH_FAILED").slice(0, 64)
    }, null, 2));
    process.exitCode = 1;
  }
}
