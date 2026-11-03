/** Non-secret receiver parameters supplied for T2T → M1 production dispatch. */
export const M1_RECEIVER_CONTRACT = Object.freeze({
  serverId: "M1-RECV-LIVE-05A308CC",
  endpoint: "https://140.245.233.184/api/v1/settlement/receive",
  authEndpoint: "https://140.245.233.184/api/v1/auth/receiver-token",
  method: "POST",
  tokenType: "USDT",
  network: "Ethereum Mainnet ERC-20",
  treasuryWallet: "0x3ffC0C113912c17C41086c9ceB74420F2E4e7690"
});

export function isM1TreasuryWallet(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) &&
    value.toLowerCase() === M1_RECEIVER_CONTRACT.treasuryWallet.toLowerCase();
}
