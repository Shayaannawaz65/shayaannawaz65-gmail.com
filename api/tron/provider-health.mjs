import { createTronGridJwt } from "./jwt.mjs";
import crypto from "node:crypto";

function authorized(req, expected) {
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createProviderHealthHandler({
  env = process.env,
  fetchImpl = fetch,
  jwtFactory = createTronGridJwt
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const expectedToken = env.T2T_TRON_SYNC_TOKEN;
    if (!expectedToken) {
      return res.status(503).json({ error: "Provider check unavailable" });
    }

    if (!authorized(req, expectedToken)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const apiKey = env.TRONGRID_API_KEY;
    const privateKey = env.TRONGRID_JWT_PRIVATE_KEY?.replace(/\\n/g, "\n");
    const keyId = env.TRONGRID_JWT_KEY_ID;

    if (!apiKey || !privateKey || !keyId) {
      return res.status(503).json({
        status: "configuration_incomplete",
        provider_checked: false,
        database_accessed: false,
        blockchain_scanned: false
      });
    }

    try {
      const response = await fetchImpl(
        "https://api.trongrid.io/wallet/getnowblock",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "TRON-PRO-API-KEY": apiKey,
            Authorization: `Bearer ${jwtFactory({
              privateKey,
              keyId
            })}`
          },
          body: "{}",
          signal: AbortSignal.timeout(10000)
        }
      );

      if (!response.ok) {
        return res.status(502).json({
          status: "provider_unavailable",
          provider_checked: true,
          database_accessed: false,
          blockchain_scanned: false
        });
      }

      const body = await response.json();
      const blockNumber = body?.block_header?.raw_data?.number;

      if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
        return res.status(502).json({
          status: "invalid_provider_response",
          provider_checked: true,
          database_accessed: false,
          blockchain_scanned: false
        });
      }

      return res.status(200).json({
        status: "connected",
        provider_checked: true,
        current_block_number: blockNumber,
        database_accessed: false,
        blockchain_scanned: false
      });
    } catch {
      return res.status(502).json({
        status: "provider_unavailable",
        provider_checked: true,
        database_accessed: false,
        blockchain_scanned: false
      });
    }
  };
}

export default createProviderHealthHandler();
