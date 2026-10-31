import { authorized } from "./sync.mjs";

export function createHealthHandler() {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const expectedToken = process.env.T2T_TRON_SYNC_TOKEN;
    if (!expectedToken) {
      return res.status(503).json({ error: "Health check unavailable" });
    }

    if (!authorized(req, expectedToken)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const configured = Boolean(
      process.env.T2T_TRON_RECEIVER_ADDRESS &&
      process.env.TRONGRID_API_KEY &&
      (
        process.env.T2T_DATABASE_URL ||
        process.env.DATABASE_URL ||
        process.env.POSTGRES_URL ||
        process.env.DATABASE_URL_UNPOOLED ||
        process.env.POSTGRES_URL_NON_POOLING
      )
    );

    return res.status(configured ? 200 : 503).json({
      status: configured ? "ready" : "configuration_incomplete",
      scanner_started: false,
      database_accessed: false,
      blockchain_scanned: false
    });
  };
}

export default createHealthHandler();
