import crypto from "node:crypto";

const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function normalizeTronAddress(value) {
  const input = String(value || "");

  if (ADDRESS_RE.test(input)) {
    let n = 0n;
    for (const char of input) {
      const digit = BASE58.indexOf(char);
      if (digit < 0) return "";
      n = n * 58n + BigInt(digit);
    }

    let hexValue = n.toString(16);
    if (hexValue.length % 2) hexValue = "0" + hexValue;
    const decoded = n === 0n ? Buffer.alloc(0) : Buffer.from(hexValue, "hex");
    let leadingZeros = 0;
    while (leadingZeros < input.length && input[leadingZeros] === "1") {
      leadingZeros++;
    }
    const bytes = Buffer.concat([Buffer.alloc(leadingZeros), decoded]);

    if (bytes.length !== 25) return "";
    const payload = bytes.subarray(0, 21);
    const checksum = bytes.subarray(21);
    if (payload[0] !== 0x41) return "";

    const sha = b => crypto.createHash("sha256").update(b).digest();
    if (!sha(sha(payload)).subarray(0, 4).equals(checksum)) return "";
    return input;
  }

  let hex = input.replace(/^0x/i, "");
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{2})?$/i.test(hex)) return "";
  if (hex.length === 40) {
    hex = "41" + hex;
  } else if (!hex.toLowerCase().startsWith("41")) {
    return "";
  }

  const payload = Buffer.from(hex, "hex");
  const sha = b => crypto.createHash("sha256").update(b).digest();
  const bytes = Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]);

  let n = BigInt("0x" + bytes.toString("hex"));
  let encoded = "";
  while (n > 0n) {
    encoded = BASE58[Number(n % 58n)] + encoded;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded;
}
