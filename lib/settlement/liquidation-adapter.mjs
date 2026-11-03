/**
 * Boundary to an approved exchange/liquidation and wallet settlement
 * workflow. No exchange vendor, endpoint, credentials, or transfer format is
 * defined here. Returned values are opaque requests/results, never proof that
 * conversion or settlement completed; verified evidence must be recorded
 * separately through the payment receipt service.
 */
export function createLiquidationAdapter({ requestExchangeConversion, requestWalletSettlement } = {}) {
  if (typeof requestExchangeConversion !== "function") {
    throw new TypeError("An approved exchange conversion workflow is required");
  }
  if (typeof requestWalletSettlement !== "function") {
    throw new TypeError("An approved wallet settlement workflow is required");
  }

  return Object.freeze({
    async requestConversion(receipt) {
      if (!receipt || receipt.blockchain?.status !== "VERIFIED" || receipt.exchange?.status !== "NOT_STARTED") {
        throw new Error("Conversion requires blockchain-verified funds");
      }
      return requestExchangeConversion(Object.freeze({ receipt }));
    },
    async requestSettlement(receipt) {
      if (!receipt || receipt.exchange?.status !== "CONVERTED" || receipt.walletSettlement?.status !== "NOT_STARTED") {
        throw new Error("Wallet settlement requires verified conversion");
      }
      return requestWalletSettlement(Object.freeze({ receipt }));
    }
  });
}
