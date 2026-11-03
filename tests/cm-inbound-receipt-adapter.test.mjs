import test from "node:test";
import assert from "node:assert/strict";
import { createCmInboundReceiptAdapter } from "../lib/cm/inbound-receipt-adapter.mjs";

test("passes opaque inbound input through approved normalizer and receipt service", async () => {
  const inboundRequest = Object.freeze({ opaqueTransportValue: "not interpreted here" });
  const normalizedRelease = Object.freeze({ internalValue: "normalized by injected CM contract" });
  const calls = [];
  const adapter = createCmInboundReceiptAdapter({
    async normalizeInboundRelease(value) {
      calls.push(["normalize", value]);
      return normalizedRelease;
    },
    paymentReceiptService: {
      async recordCmRelease(value) {
        calls.push(["record", value]);
        return { acceptedByInternalService: true };
      }
    }
  });
  const paymentInstruction = Object.freeze({ internal: "approved instruction" });
  const result = await adapter.receive({ inboundRequest, paymentInstruction, operationKey: "idempotency-01" });
  assert.deepEqual(result, { acceptedByInternalService: true });
  assert.equal(calls[0][0], "normalize");
  assert.equal(calls[0][1], inboundRequest);
  assert.equal(calls[1][0], "record");
  assert.equal(calls[1][1].authorizationRequest, inboundRequest);
  assert.equal(calls[1][1].normalizedRelease, normalizedRelease);
  assert.equal(calls[1][1].paymentInstruction, paymentInstruction);
  assert.equal(calls[1][1].operationKey, "idempotency-01");
});

test("requires injected approved normalizer and receipt service", () => {
  assert.throws(() => createCmInboundReceiptAdapter(), /normalizer is required/);
  assert.throws(() => createCmInboundReceiptAdapter({ normalizeInboundRelease() {} }), /receipt service is required/);
});
