import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createM1ReceiverClient, classifyM1SubmissionError } from "../lib/cm/m1-receiver-client.mjs";

const certificatePem = readFileSync("config/certs/m1-receiver.pem", "utf8");
const tronWallet = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const config = {
  apiToken: "test-api-token",
  clientId: "pt-test-client",
  serverId: "M1-RECV-LIVE-05A308CC",
  network: "TRON Mainnet TRC20",
  treasuryWallet: tronWallet,
  endpoint: "https://140.245.233.184/api/v1/settlement/receive",
  authEndpoint: "https://140.245.233.184/api/v1/auth/receiver-token",
  requestSignatureSecret: "unit-test-hmac-secret-with-at-least-32-bytes",
  certificatePem
};
const instruction = {
  transaction_id: "M1-test-transaction",
  amount: "10.00",
  currency: "USD",
  settlement_currency: "USDT",
  exchange_rate: "1.00",
  settlement_amount: "10.000000",
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

function makeJwt(claimOverrides = {}) {
  const claims = {
    sub: config.clientId,
    server_id: config.serverId,
    token_use: "settlement_receive",
    exp: 2000000000,
    ...claimOverrides
  };
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test-signature`;
}

function transportFor(settlementResponse, onSettlement = () => {}) {
  return async request => {
    if (request.url === config.authEndpoint) {
      assert.deepEqual(JSON.parse(request.body), { sub: config.clientId });
      return {
        statusCode: 200,
        body: JSON.stringify({
          access_token: makeJwt(),
          server_id: config.serverId,
          endpoint: config.endpoint
        })
      };
    }
    onSettlement(request);
    return settlementResponse;
  };
}

test("sends TRC20 settlement with token fetched using client ID and treats 202 as accepted only", async () => {
  let captured;
  const client = createM1ReceiverClient({
    ...config,
    transport: transportFor(
      { statusCode: 202, body: '{"status":"ACCEPTED"}' },
      request => { captured = request; }
    )
  });
  const result = await client.submitSettlement({
    instruction, idempotencyKey: "test-idempotency-0001", requestId: "test-request-0001"
  });
  assert.equal(captured.headers["X-API-TOKEN"], config.apiToken);
  assert.equal(captured.headers.Authorization, `Bearer ${makeJwt()}`);
  assert.equal(captured.headers["X-Idempotency-Key"], "test-idempotency-0001");
  assert.equal(captured.headers["X-Request-Id"], "test-request-0001");
  assert.ok(captured.headers["X-Request-Signature"]);
  const sent = JSON.parse(captured.body);
  assert.equal(sent.receiver.server_id, config.serverId);
  assert.equal(sent.receiver.tls_verify, true);
  assert.equal(sent.receiver.jwt_token, makeJwt());
  assert.equal(sent.tokenization_details.network, "TRON Mainnet TRC20");
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.settled, false);
});

test("signs the exact serialized settlement body with mandatory HMAC-SHA256", async () => {
  let captured;
  const client = createM1ReceiverClient({
    ...config,
    transport: transportFor({ statusCode: 202, body: "{}" }, request => { captured = request; })
  });
  await client.submitSettlement({ instruction, idempotencyKey: "test-hmac-key-0001" });
  const expected = createHmac("sha256", config.requestSignatureSecret)
    .update(captured.body).digest("base64url");
  assert.equal(captured.headers["X-Request-Signature"], expected);
});

test("rejects wrong JWT subject, server, or token purpose before settlement POST", async () => {
  for (const claims of [
    { sub: "some-other-client" },
    { server_id: "wrong-server" },
    { token_use: "other-purpose" }
  ]) {
    let settlementCalled = false;
    const client = createM1ReceiverClient({
      ...config,
      transport: async request => request.url === config.authEndpoint
        ? { statusCode: 200, body: JSON.stringify({
            access_token: makeJwt(claims), server_id: config.serverId, endpoint: config.endpoint
          }) }
        : (settlementCalled = true, { statusCode: 202, body: "{}" })
    });
    await assert.rejects(client.submitSettlement({ instruction, idempotencyKey: "test-idempotency-0001" }));
    assert.equal(settlementCalled, false);
  }
});

test("rejects non-fixed-scale settlement decimals before making any network request", async () => {
  let called = false;
  const client = createM1ReceiverClient({
    ...config,
    transport: async () => { called = true; return { statusCode: 202, body: "{}" }; }
  });
  await assert.rejects(
    client.submitSettlement({
      instruction: { ...instruction, settlement_amount: "10.00" },
      idempotencyKey: "test-invalid-scale-0001"
    }),
    /settlement_amount has an invalid decimal representation/
  );
  assert.equal(called, false);
});

test("rejects missing idempotency before making any network request", async () => {
  let called = false;
  const client = createM1ReceiverClient({
    ...config, transport: async () => { called = true; return { statusCode: 202, body: "{}" }; }
  });
  await assert.rejects(client.submitSettlement({ instruction }), /Idempotency key is required/);
  assert.equal(called, false);
});

test("rejects weak HMAC secrets and malformed certificates", () => {
  assert.throws(() => createM1ReceiverClient({
    ...config, requestSignatureSecret: "short"
  }), /at least 32 bytes/);
  assert.throws(() => createM1ReceiverClient({
    ...config, certificatePem: "not-a-valid-pem-certificate"
  }));
});

test("maps M1 409 to an explicit idempotency conflict", async () => {
  const client = createM1ReceiverClient({
    ...config, transport: transportFor({ statusCode: 409, body: '{"error":"duplicate"}' })
  });
  await assert.rejects(
    client.submitSettlement({ instruction, idempotencyKey: "test-idempotency-0002" }),
    error => error.code === "M1_CONFLICT"
  );
});

test("does not treat non-202 responses as accepted", async () => {
  const client = createM1ReceiverClient({
    ...config, transport: transportFor({ statusCode: 200, body: "{}" })
  });
  await assert.rejects(
    client.submitSettlement({ instruction, idempotencyKey: "test-idempotency-0003" }),
    error => error.code === "M1_UNEXPECTED_STATUS"
  );
});


test("does not send optional HMAC header when SKIT signing secret is not configured", async () => {
  let captured;
  const client = createM1ReceiverClient({
    ...config,
    requestSignatureSecret: "",
    transport: transportFor({ statusCode: 202, body: "{}" }, request => { captured = request; })
  });
  const result = await client.submitSettlement({
    instruction, idempotencyKey: "test-optional-signature-0001"
  });
  assert.equal(captured.headers["X-Request-Signature"], undefined);
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.settled, false);
});


test("classifies ambiguous transport timeouts as UNKNOWN without retrying", async () => {
  for (const code of ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET"]) {
    let settlementCalls = 0;
    const client = createM1ReceiverClient({
      ...config,
      transport: async request => {
        if (request.url === config.authEndpoint) {
          return {
            statusCode: 200,
            body: JSON.stringify({
              access_token: makeJwt(),
              server_id: config.serverId,
              endpoint: config.endpoint
            })
          };
        }
        settlementCalls += 1;
        const error = new Error("socket timeout");
        error.code = code;
        throw error;
      }
    });
    await assert.rejects(
      client.submitSettlement({ instruction, idempotencyKey: "test-unknown-timeout-0001" }),
      error => error.code === "M1_UNKNOWN" &&
        error.transportCode === code &&
        classifyM1SubmissionError(error) === "UNKNOWN"
    );
    assert.equal(settlementCalls, 1, "ambiguous submission must not be retried automatically");
  }
});

test("classifies HTTP 409 as CONFLICT and never as ACCEPTED", async () => {
  const client = createM1ReceiverClient({
    ...config,
    transport: transportFor({ statusCode: 409, body: '{"error":"conflict"}' })
  });
  await assert.rejects(
    client.submitSettlement({ instruction, idempotencyKey: "test-conflict-map-0001" }),
    error => error.code === "M1_CONFLICT" &&
      classifyM1SubmissionError(error) === "CONFLICT"
  );
});

test("classifies 5xx and malformed 202 acknowledgements as UNKNOWN", async () => {
  for (const response of [
    { statusCode: 503, body: '{"error":"unavailable"}' },
    { statusCode: 202, body: '{"status":"PENDING"}' },
    { statusCode: 202, body: '{"status":"accepted"}' },
    { statusCode: 202, body: "not-json" }
  ]) {
    const client = createM1ReceiverClient({
      ...config,
      transport: transportFor(response)
    });
    await assert.rejects(
      client.submitSettlement({ instruction, idempotencyKey: "test-unknown-ack-0001" }),
      error => error.code === "M1_UNKNOWN" &&
        classifyM1SubmissionError(error) === "UNKNOWN"
    );
  }
});

test("maps definitive 4xx rejection to REJECTED using the existing outbox enum", async () => {
  const client = createM1ReceiverClient({
    ...config,
    transport: transportFor({ statusCode: 400, body: '{"error":"invalid"}' })
  });
  await assert.rejects(
    client.submitSettlement({ instruction, idempotencyKey: "test-rejected-map-0001" }),
    error => error.code === "M1_REJECTED" &&
      classifyM1SubmissionError(error) === "REJECTED"
  );
});
