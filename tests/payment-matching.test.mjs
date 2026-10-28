import test from "node:test";
import assert from "node:assert/strict";
import { classifyPaymentMatch } from "../api/tron/payment-matching.mjs";

const contract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const receiver = "TExAW9464LvbWmAsbcmNhvHQwawUn8rmN2";
const txid = "a".repeat(64);

const deposit = {
  observationStatus: "OBSERVED_CONFIRMED",
  tokenContract: contract,
  receiverAddress: receiver,
  amountRaw: "12500000",
  transactionId: txid,
  eventIndex: 0,
  blockTimestamp: "2026-10-28T18:00:00Z"
};

const order = (overrides = {}) => ({
  orderId: "order-1",
  status: "PENDING",
  tokenContract: contract,
  receiverAddress: receiver,
  amountUsdtRaw: "12500000",
  createdAt: "2026-10-28T17:00:00Z",
  expiresAt: "2026-10-28T19:00:00Z",
  ...overrides
});

test("returns a unique match for one exact eligible order", () => {
  assert.deepEqual(
    classifyPaymentMatch({ deposit, orders: [order()] }),
    {
      status: "unique_match",
      orderId: "order-1",
      transactionId: txid,
      eventIndex: 0
    }
  );
});

test("does not match an unconfirmed deposit", () => {
  assert.equal(
    classifyPaymentMatch({
      deposit: { ...deposit, observationStatus: "PENDING_VERIFICATION" },
      orders: [order()]
    }).status,
    "invalid_deposit"
  );
});

test("does not match a different receiver, contract, or amount", () => {
  assert.equal(
    classifyPaymentMatch({
      deposit: { ...deposit, receiverAddress: "different" },
      orders: [order()]
    }).status,
    "no_match"
  );
  assert.equal(
    classifyPaymentMatch({
      deposit: { ...deposit, tokenContract: "different" },
      orders: [order()]
    }).status,
    "invalid_deposit"
  );
  assert.equal(
    classifyPaymentMatch({
      deposit: { ...deposit, amountRaw: "12500001" },
      orders: [order()]
    }).status,
    "no_match"
  );
});

test("does not match orders that are not pending", () => {
  assert.equal(
    classifyPaymentMatch({
      deposit,
      orders: [order({ status: "CONFIRMED" })]
    }).status,
    "no_match"
  );
});

test("uses on-chain time and rejects transfers before creation or at expiry", () => {
  assert.equal(
    classifyPaymentMatch({
      deposit: { ...deposit, blockTimestamp: "2026-10-28T16:59:59Z" },
      orders: [order()]
    }).status,
    "no_match"
  );
  assert.equal(
    classifyPaymentMatch({
      deposit: { ...deposit, blockTimestamp: "2026-10-28T19:00:00Z" },
      orders: [order()]
    }).status,
    "no_match"
  );
});

test("returns ambiguous instead of choosing between duplicate eligible orders", () => {
  const result = classifyPaymentMatch({
    deposit,
    orders: [order(), order({ orderId: "order-2" })]
  });
  assert.deepEqual(result, { status: "ambiguous", candidateCount: 2 });
});

test("ignores an otherwise matching order with an invalid date", () => {
  assert.equal(
    classifyPaymentMatch({
      deposit,
      orders: [order({ expiresAt: "not-a-date" })]
    }).status,
    "no_match"
  );
});

test("rejects malformed transaction identifiers and non-positive amounts", () => {
  assert.equal(
    classifyPaymentMatch({
      deposit: { ...deposit, transactionId: "bad" },
      orders: [order()]
    }).status,
    "invalid_deposit"
  );
  assert.equal(
    classifyPaymentMatch({
      deposit: { ...deposit, amountRaw: "0" },
      orders: [order()]
    }).status,
    "invalid_deposit"
  );
});
