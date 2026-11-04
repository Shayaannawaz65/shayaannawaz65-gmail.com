# NOWPayments direct USDT TRC20 flow

This branch changes only the existing S2S payment-order provider leg. It keeps
the existing signed S2S authentication, quote verification, nonce replay
protection, merchant IP allowlist, rate limit and t2t_payment_orders ledger.

## Flow

1. The authorized S2S client signs the existing V2 payment-order request.
2. T2T validates the client/key/terminal, source IP, timestamp, nonce and signed
   T2T exchange quote.
3. T2T converts the quote's USDT raw units (6 decimals) to an exact decimal
   pay_amount and sends NOWPayments POST /v1/payment with the USD price, exact
   USDT pay_amount, usdttrc20 network, order_id and configured IPN callback.
4. T2T validates the returned payment ID, order ID, fiat amount, crypto amount
   and TRON address, then persists provider identifiers and deposit details in
   the existing order row.
5. The S2S response includes the NOWPayments TRON deposit address/amount and a
   token-protected payment status URL.
6. NOWPayments IPN signature verification remains in place. IPN reconciliation
   matches the internal order ID, provider payment ID, USD amount and currency
   pair before changing the order status.

## Boundaries

- This does not create or forward an M1 settlement instruction.
- The existing M1 receiver administration and legacy TRON scanner are
  unchanged. Direct-provider orders have no scanner-confirmed TRON evidence
  and cannot enter the legacy scanner-driven M1 dispatch path.
- Hosted-invoice fields and migration 024 remain for historical compatibility.
- Migration 025 is additive and must be applied to a non-production Neon branch
  for validation before any production rollout.
- No outbound merchant webhook is introduced. The signed S2S request receives
  the initial result synchronously and can poll the returned status URL. A
  push callback requires an approved merchant callback URL and agreed
  authentication/signature contract; neither is invented here.
