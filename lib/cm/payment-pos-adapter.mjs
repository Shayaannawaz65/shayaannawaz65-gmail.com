const PAYMENT_REFERENCE_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const USD_CENTS_RE = /^[1-9][0-9]{0,77}$/;

/**
 * Validates the internal payment instruction T2T has already received from
 * its approved source. This module does not define a CM wire contract or
 * initiate an authorization/payment request.
 */
export function validatePaymentInstruction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Payment instruction must be an object");
  }

  const { paymentReference, currency, expectedAmountUsdCents } = value;
  if (typeof paymentReference !== "string" || !PAYMENT_REFERENCE_RE.test(paymentReference)) {
    throw new TypeError("Payment reference is invalid");
  }
  if (currency !== "USD") {
    throw new TypeError("Payment instruction currency must be USD");
  }
  if (typeof expectedAmountUsdCents !== "string" || !USD_CENTS_RE.test(expectedAmountUsdCents)) {
    throw new TypeError("Expected USD amount must be positive integer cents");
  }

  return Object.freeze({
    paymentReference,
    currency: "USD",
    expectedAmountUsdCents
  });
}
