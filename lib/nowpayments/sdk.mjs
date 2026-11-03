import { NowPaymentsSDK } from "@nowpaymentsio/nowpayments-sdk-nodejs";

export function getNowPaymentsSdk(env = process.env) {
  const apiKey = String(env.NOWPAYMENTS_API_KEY || "");
  const ipnSecret = String(env.NOWPAYMENTS_IPN_SECRET || "");
  const callbackUrl = String(
    env.NOWPAYMENTS_IPN_CALLBACK_URL ||
    `${String(env.T2T_PAYMENT_BASE_URL || "").replace(/\/+$/, "")}/api/nowpayments/ipn`
  );

  if (!apiKey || !ipnSecret) {
    throw new Error("NOWPayments API key or IPN secret is not configured");
  }

  const callback = new URL(callbackUrl);
  if (callback.protocol !== "https:") {
    throw new Error("NOWPayments IPN callback must use HTTPS");
  }

  return new NowPaymentsSDK({
    apiKey,
    ipnSecret,
    ipnCallbackUrl: callback.toString(),
    successUrl: env.NOWPAYMENTS_SUCCESS_URL || undefined,
    cancelUrl: env.NOWPAYMENTS_CANCEL_URL || undefined
  });
}
