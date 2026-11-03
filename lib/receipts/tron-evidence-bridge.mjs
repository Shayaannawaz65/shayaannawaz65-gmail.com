const TXID_RE = /^[0-9a-f]{64}$/i;
const RAW_AMOUNT_RE = /^[1-9][0-9]{0,77}$/;

/**
 * Maps a persisted, confirmed row from tron_usdt_deposits into receipt-ledger
 * evidence. Receipt association is injected because the existing loader only
 * matches legacy orders and has no payment-reference mapping for this flow.
 */
export function mapConfirmedTronDeposit({ deposit, receiptId } = {}) {
  if (!deposit || deposit.observation_status !== "OBSERVED_CONFIRMED") {
    throw new Error("Only loader-confirmed blockchain deposits can be mapped");
  }
  const transactionId = String(deposit.transaction_id ?? "");
  const eventIndex = Number(deposit.event_index);
  const tokenAmountRaw = String(deposit.amount_raw ?? "");
  if (!TXID_RE.test(transactionId) || !Number.isSafeInteger(eventIndex) || eventIndex < 0 ||
      !RAW_AMOUNT_RE.test(tokenAmountRaw) || typeof receiptId !== "string" || receiptId.length === 0) {
    throw new TypeError("Confirmed loader deposit or receipt association is invalid");
  }
  return Object.freeze({
    receiptId,
    operationKey: `tron-${transactionId.toLowerCase()}-${eventIndex}`,
    evidence: Object.freeze({
      verified: true,
      transactionId: transactionId.toLowerCase(),
      eventIndex,
      tokenAmountRaw,
      evidenceRef: `tron-usdt/${transactionId.toLowerCase()}/${eventIndex}`
    })
  });
}

/** Explicit bridge from the existing confirmed-deposit loader to the new receipt ledger. */
export function createTronReceiptLedgerBridge({ resolveReceiptId, paymentReceiptService } = {}) {
  if (typeof resolveReceiptId !== "function") throw new TypeError("A trusted receipt association resolver is required");
  if (!paymentReceiptService || typeof paymentReceiptService.verifyBlockchainReceipt !== "function") {
    throw new TypeError("A payment receipt service is required");
  }
  return Object.freeze({
    async recordConfirmedDeposit(deposit) {
      if (!deposit || deposit.observation_status !== "OBSERVED_CONFIRMED") {
        throw new Error("Only loader-confirmed blockchain deposits can be recorded");
      }
      const receiptId = await resolveReceiptId(deposit);
      const mapped = mapConfirmedTronDeposit({ deposit, receiptId });
      return paymentReceiptService.verifyBlockchainReceipt({
        receiptId: mapped.receiptId,
        operationKey: mapped.operationKey,
        evidence: mapped.evidence
      });
    }
  });
}
