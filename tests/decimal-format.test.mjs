import test from "node:test";
import assert from "node:assert/strict";
import { formatBigIntToDecimalString } from "../lib/cm/decimal-format.mjs";

test("formats fixed-scale integers without floating point", () => {
  assert.equal(formatBigIntToDecimalString(100500000n, 6), "100.500000");
  assert.equal(formatBigIntToDecimalString(1500000n, 6), "1.500000");
  assert.equal(formatBigIntToDecimalString(5n, 6), "0.000005");
  assert.equal(formatBigIntToDecimalString(-5n, 6), "-0.000005");
  assert.equal(formatBigIntToDecimalString(123n, 0), "123");
});

test("rejects invalid values and precision", () => {
  assert.throws(() => formatBigIntToDecimalString(1, 6), /BigInt/);
  assert.throws(() => formatBigIntToDecimalString(1n, -1), /decimals/);
  assert.throws(() => formatBigIntToDecimalString(1n, 1.5), /decimals/);
});
