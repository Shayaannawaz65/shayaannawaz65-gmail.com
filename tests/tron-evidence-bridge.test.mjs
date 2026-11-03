import test from "node:test";
import assert from "node:assert/strict";
import { createTronReceiptLedgerBridge, mapConfirmedTronDeposit } from "../lib/receipts/tron-evidence-bridge.mjs";

const deposit = {
  transaction_id: "ab".repeat(32),
  event_index: 4,
  amount_raw: "1234500",
  observation_status: "OBSERVED_CONFIRMED"
};

test("maps only the existing confirmed deposit columns to receipt evidence", () => {
  const mapped = mapConfirmedTronDeposit({ deposit, receiptId: "receipt-01" });
  assert.equal(mapped.receiptId, "receipt-01");
  assert.equal(mapped.operationKey, `tron-${deposit.transaction_id}-4`);
  assert.deepEqual(mapped.evidence, {
    verified: true,
    transactionId: deposit.transaction_id,
    eventIndex: 4,
    tokenAmountRaw: "1234500",
    evidenceRef: `tron-usdt/${deposit.transaction_id}/4`
  });
});

test("rejects pending or malformed loader rows", () => {
  assert.throws(() => mapConfirmedTronDeposit({ deposit: { ...deposit, observation_status: "PENDING" }, receiptId: "r" }), /confirmed/);
  assert.throws(() => mapConfirmedTronDeposit({ deposit: { ...deposit, amount_raw: "0" }, receiptId: "r" }), /invalid/);
  assert.throws(() => mapConfirmedTronDeposit({ deposit, receiptId: "" }), /invalid/);
});

test("resolves receipt association and calls ledger verifier without coupling to legacy orders", async () => {
  let seenDeposit;
  let ledgerInput;
  const bridge = createTronReceiptLedgerBridge({
    async resolveReceiptId(row) { seenDeposit = row; return "receipt-02"; },
    paymentReceiptService: {
      async verifyBlockchainReceipt(input) { ledgerInput = input; return { receipt: "updated" }; }
    }
  });
  assert.deepEqual(await bridge.recordConfirmedDeposit(deposit), { receipt: "updated" });
  assert.equal(seenDeposit, deposit);
  assert.equal(ledgerInput.receiptId, "receipt-02");
  assert.equal(ledgerInput.evidence.transactionId, deposit.transaction_id);
});
