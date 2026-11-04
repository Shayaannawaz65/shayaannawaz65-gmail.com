import heartbeat from "../lib/routes/console/heartbeat.mjs";
import paymentOrderList from "../lib/routes/console/payment-order-list.mjs";
import paymentOrders from "../lib/routes/console/payment-orders.mjs";
import paymentQuote from "../lib/routes/console/payment-quote-issuer.mjs";
import paymentStatus from "../lib/routes/console/payment-status.mjs";
import s2sClientAdmin from "../lib/routes/console/s2s-client-admin.mjs";
import s2sClientIpAllowlist from "../lib/routes/console/s2s-client-ip-allowlist.mjs";
import s2sTerminalAccess from "../lib/routes/console/s2s-terminal-access.mjs";
import s2sTerminalAudit from "../lib/routes/console/s2s-terminal-audit.mjs";
import terminalAdmin from "../lib/routes/console/terminal-admin.mjs";
import m1SettlementAdmin from "../lib/routes/console/m1-settlement-admin.mjs";
import m1SkitCallback from "../lib/routes/console/m1-skit-callback.mjs";
import consoleStatus from "../lib/routes/console/status.mjs";
import transactions from "../lib/routes/console/transactions.mjs";
import tronDbHealth from "../lib/routes/tron/db-health.mjs";
import tronHealth from "../lib/routes/tron/health.mjs";
import tronProviderHealth from "../lib/routes/tron/provider-health.mjs";
import tronSync from "../lib/routes/tron/sync.mjs";
import nowpaymentsIpn from "../lib/routes/nowpayments/ipn.mjs";
import paymentReceipts from "../lib/routes/console/payment-receipts.mjs";

const routes = new Map([
  ["console/heartbeat", heartbeat],
  ["console/payment-order-list", paymentOrderList],
  ["console/payment-orders", paymentOrders],
  ["console/payment-quote", paymentQuote],
  ["console/payment-quote-issuer", paymentQuote],
  ["console/payment-status", paymentStatus],
  ["console/payment-receipts", paymentReceipts],
  ["console/s2s-client-admin", s2sClientAdmin],
  ["console/s2s-client-ip-allowlist", s2sClientIpAllowlist],
  ["console/s2s-terminal-access", s2sTerminalAccess],
  ["console/s2s-terminal-audit", s2sTerminalAudit],
  ["console/terminal-admin", terminalAdmin],
  ["console/m1-settlement-admin", m1SettlementAdmin],
  ["m1/skit-callback", m1SkitCallback],
  ["console/status", consoleStatus],
  ["console/transactions", transactions],
  ["tron/db-health", tronDbHealth],
  ["tron/health", tronHealth],
  ["tron/provider-health", tronProviderHealth],
  ["tron/sync", tronSync],
  ["nowpayments/ipn", nowpaymentsIpn]
]);

export const API_ROUTE_PATHS = Object.freeze([...routes.keys()]);

export default async function handler(req, res) {
  const raw = req.query?.route ?? req.params?.splat;
  const parts = Array.isArray(raw) ? raw :
    typeof raw === "string" ? raw.split("/") :
    String(req.originalUrl || req.url || "").split("?")[0].replace(/^\/api\//, "").split("/");
  const path = parts.map(String).join("/");
  const route = routes.get(path);

  if (!route) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).json({ error: "API route not found" });
  }
  return route(req, res);
}
