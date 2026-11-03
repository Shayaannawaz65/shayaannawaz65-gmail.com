import test from "node:test";
import assert from "node:assert/strict";
import { validatePaymentInstruction } from "../lib/cm/payment-pos-adapter.mjs";

const validInstruction = Object.freeze({
  paymentReference: "PAY-2026/0042",
  currency: "USD",
  expectedAmountUsdCents: "2500"
});

test("validates and freezes an authoritative USD payment instruction", () => {
  const instruction = validatePaymentInstruction(validInstruction);
  assert.deepEqual(instruction, validInstruction);
  assert.equal(Object.isFrozen(instruction), true);
  assert.equal(instruction.expectedAmountUsdCents, "2500");
});

test("keeps large USD cent values exact and ignores unrelated fields", () => {
  const instruction = validatePaymentInstruction({
    ...validInstruction,
    expectedAmountUsdCents: "90071992547409931234567890",
    unrelatedField: "discarded"
  });
  assert.equal(instruction.expectedAmountUsdCents, "90071992547409931234567890");
  assert.equal("unrelatedField" in instruction, false);
});

test("rejects malformed references, non-USD denominations and invalid cents", () => {
  const invalid = [
    null,
    [],
    { ...validInstruction, paymentReference: "" },
    { ...validInstruction, paymentReference: "bad reference" },
    { ...validInstruction, paymentReference: "x".repeat(121) },
    { ...validInstruction, currency: "EUR" },
    { ...validInstruction, expectedAmountUsdCents: 0 },
    { ...validInstruction, expectedAmountUsdCents: "0" },
    { ...validInstruction, expectedAmountUsdCents: "02500" },
    { ...validInstruction, expectedAmountUsdCents: "25.00" },
    { ...validInstruction, expectedAmountUsdCents: "9".repeat(79) }
  ];
  for (const value of invalid) assert.throws(() => validatePaymentInstruction(value), TypeError);
});
