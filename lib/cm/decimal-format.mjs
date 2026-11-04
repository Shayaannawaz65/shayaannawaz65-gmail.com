/**
 * Exact BigInt decimal formatter for fixed-scale ledger values.
 * Never converts through Number or floating-point arithmetic.
 */
export function formatBigIntToDecimalString(value, decimals = 6) {
  if (typeof value !== "bigint") throw new TypeError("value must be a BigInt");
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError("decimals must be an integer from 0 to 36");
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  if (decimals === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(decimals + 1, "0");
  const split = padded.length - decimals;
  return `${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}`;
}
