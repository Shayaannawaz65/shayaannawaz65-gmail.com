import crypto from "node:crypto";

const JWT_LIFETIME_SECONDS = 300;

export function createTronGridJwt({
  privateKey,
  keyId,
  now = Math.floor(Date.now() / 1000)
}) {
  if (
    typeof privateKey !== "string" ||
    !privateKey.includes("PRIVATE KEY") ||
    typeof keyId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(keyId)
  ) {
    throw new Error("TronGrid JWT configuration invalid");
  }

  const encode = value =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  const header = encode({ alg: "RS256", typ: "JWT", kid: keyId });
  const payload = encode({
    aud: "trongrid.io",
    exp: now + JWT_LIFETIME_SECONDS
  });

  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}
