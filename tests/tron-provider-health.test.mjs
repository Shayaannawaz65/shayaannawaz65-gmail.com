import test from "node:test";
import assert from "node:assert/strict";
import { createProviderHealthHandler } from "../api/tron/provider-health.mjs";

function makeResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

const token = "provider-health-test-token";
const env = {
  T2T_TRON_SYNC_TOKEN: token,
  TRONGRID_API_KEY: "fake-api-key",
  TRONGRID_JWT_PRIVATE_KEY: "fake-private-key",
  TRONGRID_JWT_KEY_ID: "test-key-id"
};

test("provider health requires GET", async () => {
  const res = makeResponse();
  await createProviderHealthHandler({ env })(
    { method: "POST", headers: {} },
    res
  );
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
});

test("provider health rejects unauthorized requests without fetching", async () => {
  let fetched = false;
  const res = makeResponse();
  await createProviderHealthHandler({
    env,
    fetchImpl: async () => {
      fetched = true;
      throw new Error("must not fetch");
    }
  })({ method: "GET", headers: {} }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(fetched, false);
});

test("provider health reports block metadata without database access or scanning", async () => {
  let request;
  const res = makeResponse();

  await createProviderHealthHandler({
    env,
    jwtFactory: ({ privateKey, keyId }) => {
      assert.equal(privateKey, "fake-private-key");
      assert.equal(keyId, "test-key-id");
      return "test-jwt";
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          block_header: { raw_data: { number: 87254732 } }
        })
      };
    }
  })(
    { method: "GET", headers: { authorization: `Bearer ${token}` } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    status: "connected",
    provider_checked: true,
    current_block_number: 87254732,
    database_accessed: false,
    blockchain_scanned: false
  });
  assert.equal(request.url, "https://api.trongrid.io/wallet/getnowblock");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["TRON-PRO-API-KEY"], "fake-api-key");
  assert.equal(request.options.headers.Authorization, "Bearer test-jwt");
  assert.equal(request.options.body, "{}");
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("provider health rejects malformed provider block responses", async () => {
  const res = makeResponse();

  await createProviderHealthHandler({
    env,
    jwtFactory: () => "test-jwt",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ block_header: { raw_data: { number: "not-a-number" } } })
    })
  })(
    { method: "GET", headers: { authorization: `Bearer ${token}` } },
    res
  );

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.status, "invalid_provider_response");
  assert.equal(res.body.database_accessed, false);
  assert.equal(res.body.blockchain_scanned, false);
});

test("provider health does not expose provider errors", async () => {
  const res = makeResponse();

  await createProviderHealthHandler({
    env,
    jwtFactory: () => "test-jwt",
    fetchImpl: async () => {
      throw new Error("sensitive internal provider detail");
    }
  })(
    { method: "GET", headers: { authorization: `Bearer ${token}` } },
    res
  );

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.status, "provider_unavailable");
  assert.equal(JSON.stringify(res.body).includes("sensitive"), false);
});
