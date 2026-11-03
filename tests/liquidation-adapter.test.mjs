import test from "node:test";
import assert from "node:assert/strict";
import { createLiquidationAdapter } from "../lib/settlement/liquidation-adapter.mjs";

const baseReceipt = {
  blockchain: { status: "VERIFIED" },
  exchange: { status: "NOT_STARTED" },
  walletSettlement: { status: "NOT_STARTED" }
};

test("separates conversion and settlement requests behind injected workflow", async () => {
  const calls = [];
  const adapter = createLiquidationAdapter({
    async requestExchangeConversion(input) { calls.push(["conversion", input]); return { opaque: "conversion response" }; },
    async requestWalletSettlement(input) { calls.push(["settlement", input]); return { opaque: "settlement response" }; }
  });
  assert.deepEqual(await adapter.requestConversion(baseReceipt), { opaque: "conversion response" });
  const converted = { ...baseReceipt, exchange: { status: "CONVERTED" } };
  assert.deepEqual(await adapter.requestSettlement(converted), { opaque: "settlement response" });
  assert.equal(calls[0][0], "conversion");
  assert.equal(calls[0][1].receipt, baseReceipt);
  assert.equal(calls[1][0], "settlement");
});

test("does not request conversion or settlement before prior verified state", async () => {
  const adapter = createLiquidationAdapter({ requestExchangeConversion() {}, requestWalletSettlement() {} });
  await assert.rejects(adapter.requestConversion({ ...baseReceipt, blockchain: { status: "UNVERIFIED" } }), /blockchain-verified/);
  await assert.rejects(adapter.requestSettlement(baseReceipt), /verified conversion/);
});

test("requires both approved workflow functions", () => {
  assert.throws(() => createLiquidationAdapter(), /exchange conversion workflow/);
  assert.throws(() => createLiquidationAdapter({ requestExchangeConversion() {} }), /wallet settlement workflow/);
});
