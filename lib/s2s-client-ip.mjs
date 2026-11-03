import net from "node:net";

function canonicalIp(value) {
  if (typeof value !== "string") return null;
  let ip = value.trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

export function requestClientIp(req, env = process.env) {
  if (env.VERCEL === "1") {
    // Vercel overwrites X-Forwarded-For with the public client IP. Reject
    // ambiguous chains; do not trust caller-supplied proxy headers elsewhere.
    const forwarded = req.headers?.["x-forwarded-for"];
    if (typeof forwarded !== "string" || forwarded.includes(",")) return null;
    return canonicalIp(forwarded);
  }

  return canonicalIp(req.socket?.remoteAddress);
}

export function normalizeIpNetwork(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  const parts = value.trim().split("/");
  if (parts.length > 2) return null;
  const ip = canonicalIp(parts[0]);
  if (!ip) return null;

  const version = net.isIP(ip);
  const maxPrefix = version === 4 ? 32 : 128;
  const prefix = parts.length === 1 ? maxPrefix : Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return null;
  return `${ip}/${prefix}`;
}

export async function isMerchantIpAllowed(
  client,
  principal,
  req,
  { env = process.env, lock = false } = {}
) {
  if (principal.client_type !== "MERCHANT") return true;

  const ip = requestClientIp(req, env);
  if (!ip) return false;

  const result = await client.query(
    `SELECT allowlist_id
       FROM public.t2t_s2s_client_ip_allowlist
      WHERE client_id = $1
        AND status = 'ACTIVE'
        AND $2::inet <<= network
      LIMIT 1
      ${lock ? "FOR SHARE" : ""}`,
    [principal.client_id, ip]
  );
  return result.rowCount === 1;
}
