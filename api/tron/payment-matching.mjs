const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TXID_RE = /^[0-9a-f]{64}$/i;
const RAW_AMOUNT_RE = /^\d{1,78}$/;

function validDate(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function classifyPaymentMatch({ deposit, orders }) {
  if (
    !deposit ||
    deposit.observationStatus !== "OBSERVED_CONFIRMED" ||
    deposit.tokenContract !== USDT_CONTRACT ||
    typeof deposit.receiverAddress !== "string" ||
    !RAW_AMOUNT_RE.test(String(deposit.amountRaw ?? "")) ||
    BigInt(String(deposit.amountRaw)) <= 0n ||
    !TXID_RE.test(String(deposit.transactionId ?? "")) ||
    !Number.isInteger(deposit.eventIndex) ||
    deposit.eventIndex < 0 ||
    validDate(deposit.blockTimestamp) === null
  ) {
    return { status: "invalid_deposit" };
  }

  const blockTime = validDate(deposit.blockTimestamp);
  const eligible = (Array.isArray(orders) ? orders : []).filter(order => {
    if (
      !order ||
      order.status !== "PENDING" ||
      order.tokenContract !== USDT_CONTRACT ||
      order.receiverAddress !== deposit.receiverAddress ||
      !RAW_AMOUNT_RE.test(String(order.amountUsdtRaw ?? "")) ||
      String(order.amountUsdtRaw) !== String(deposit.amountRaw)
    ) {
      return false;
    }

    const createdAt = validDate(order.createdAt);
    const expiresAt = validDate(order.expiresAt);

    return createdAt !== null &&
      expiresAt !== null &&
      blockTime >= createdAt &&
      blockTime < expiresAt;
  });

  if (eligible.length === 0) {
    return { status: "no_match" };
  }

  if (eligible.length > 1) {
    return { status: "ambiguous", candidateCount: eligible.length };
  }

  return {
    status: "unique_match",
    orderId: eligible[0].orderId,
    transactionId: deposit.transactionId,
    eventIndex: deposit.eventIndex
  };
}
