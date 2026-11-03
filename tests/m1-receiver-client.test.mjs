import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createM1ReceiverClient } from "../lib/cm/m1-receiver-client.mjs";

const certificatePem = readFileSync("config/certs/m1-receiver.pem", "utf8");
const tronWallet = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const config = {
  apiToken: "test-api-token",
  jwtToken: "test-jwt-token",
  serverId: "M1-RECV-LIVE-05A308CC",
  network: "TRON Mainnet TRC20",
  treasuryWallet: tronWallet,
  endpoint: "https://140.245.233.184/api/v1/settlement/receive",
  certificatePem
};
const instruction = {
  transaction_id: "test-transaction-0001",
  amount: "10.00",
  currency: "USD",
  settlement_currency: "USDT",
  exchange_rate: "1.00",
  settlement_amount: "10.00",
  debtor_name: "Test Debtor",
  debtor_account: "test-debtor-account",
  creditor_name: "Test Creditor",
  creditor_account: "test-creditor-account",
  reference: "test-reference-0001",
  narrative: "Automated connector unit test",
  callback_url: "https://example.invalid/callback",
  tokenization_details: {
    token_type: "USDT",
    network: "TRON Mainnet TRC20",
    wallet_address: tronWallet
  }
};

test("constructs authenticated TRC20 M1 request and treats 202 as accepted only", async () => {
  let captured;
  const client = createM1ReceiverClient({
    ...config,
    transport: async request => {
      captured = request;
      return { statusCode: 202, body: '{"status":"accepted"}' };
    }
  });
  const result = await client.submitSettlement({
    instruction, idempotencyKey: "test-idempotency-0001", requestId: "test-request-0001"
  });
  assert.equal(captured.headers["X-API-TOKEN"], config.apiToken);
  assert.equal(captured.headers.Authorization, `Bearer ${config.jwtToken}`);
  assert.equal(captured.headers["X-Idempotency-Key"], "test-idempotency-0001");
  const sent = JSON.parse(captured.body);
  assert.equal(sent.receiver.server_id, config.serverId);
  assert.equal(sent.receiver.tls_verify, true);
  assert.equal(sent.receiver.jwt_token, undefined);
  assert.equal(sent.tokenization_details.network, "TRON Mainnet TRC20");
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.settled, false);
});

test("adds optional HMAC-SHA256 signature over exact serialized request body", async () => {
  let captured;
  const secret = "unit-test-hmac-secret-with-32-bytes-min";
  const client = createM1ReceiverClient({
    ...config, requestSignatureSecret: secret,
    transport: async request => {
      captured = request;
      return { statusCode: 202, body: "{}" };
    }
  });
  await client.submitSettlement({ instruction, idempotencyKey: "test-hmac-key-0001" });
  const { createHmac } = await import("node:crypto");
  const expected = createHmac("sha256", secret).update(captured.body).digest("base64url");
  assert.equal(captured.headers["X-Request-Signature"], expected);
});

test("adds optional HMAC-SHA256 signature over the exact serialized request body", async () => {
  let captured;
  const secret = "unit-test-hmac-secret-with-32-bytes-min";
  const client = createM1ReceiverClient({
    ...config,
    requestSignatureSecret: secret,
    transport: async request => {
      captured = request;
      return { statusCode: 202, body: "{}" };
    }
  });
  await client.submitSettlement({ instruction, idempotencyKey: "test-hmac-key-0001" });
  const { createHmac } = await import("node:crypto");
  const expected = createHmac("sha256", secret).update(captured.body).digest("base64url");
  assert.equal(captured.headers["X-Request-Signature"], expected);
});

test("rejects an Ethereum wallet address for TRC20 settlement", () => {
  assert.throws(() => createM1ReceiverClient({
    ...config,
    treasuryWallet: "0x3ffC0C113912c17C41086c9ceB74420F2E4e7690"
  }), /TRON network, or treasury wallet/);
});

test("rejects a missing idempotency key before transport", async () => {
  let called = false;
  const client = createM1ReceiverClient({
    ...config,
    transport: async () => {
      called = true;
      return { statusCode: 202, body: "{}" };
    }
  });
  await assert.rejects(client.submitSettlement({ instruction }), /Idempotency key is required/);
  assert.equal(called, false);
});

test("rejects an Ethereum wallet address for TRC20 settlement", () => {
  assert.throws(() => createM1ReceiverClient({
    ...config, treasuryWallet: "0x3ffC0C113912c17C41086c9ceB74420F2E4e7690"
  }), /TRON network, or treasury wallet/);
});

test("rejects an endpoint outside the approved M1 receiver", () => {
  assert.throws(() => createM1ReceiverClient({
    ...config, endpoint: "https://example.com/api/v1/settlement/receive"
  }), /approved receiver endpoint/);
});

test("rejects a malformed certificate before creating the client", () => {
  assert.throws(() => createM1ReceiverClient({
    ...config, certificatePem: "not-a-valid-pem-certificate"
  }));
});

test("maps M1 409 to an explicit idempotency conflict", async () => {
  const client = createM1ReceiverClient({
    ...config, transport: async () => ({ statusCode: 409, body: '{"error":"duplicate"}' })
  });
  await assert.rejects(
    client.submitSettlement({ instruction, idempotencyKey: "test-idempotency-0002" }),
    error => error.code === "M1_CONFLICT"
  );
});

test("does not treat non-202 responses as accepted", async () => {
  const client = createM1ReceiverClient({
    ...config, transport: async () => ({ statusCode: 200, body: "{}" })
  });
  await assert.rejects(
    client.submitSettlement({ instruction, idempotencyKey: "test-idempotency-0003" }),
    error => error.code === "M1_UNEXPECTED_STATUS"
  );
});
