/** Non-secret receiver parameters supplied for T2T → M1 production dispatch. */
export const M1_RECEIVER_CONTRACT = Object.freeze({
  serverId: "M1-RECV-LIVE-05A308CC",
  endpoint: "https://140.245.233.184/api/v1/settlement/receive",
  authEndpoint: "https://140.245.233.184/api/v1/auth/receiver-token",
  method: "POST",
  tokenType: "USDT",
  network: "TRON Mainnet TRC20"
});

/** Validate a TRON Base58Check address shape; the exact wallet is supplied server-side. */
export function isM1TreasuryWallet(value) {
  return typeof value === "string" && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
}
