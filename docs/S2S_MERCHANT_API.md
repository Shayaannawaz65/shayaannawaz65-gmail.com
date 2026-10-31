# T2T Merchant S2S API

This integration uses direct TRON USDT TRC20 payments. Invoice amounts are sent in USD cents; T2T validates a short-lived signed exchange-rate quote and computes the exact USDT raw amount. No payment gateway is involved.

## Merchant key identity

- `keyId` is a cryptographic key identifier, not a merchant ID.
- Generate a P-256 / prime256v1 key pair on the merchant server.
- Keep the PKCS#8 private key only in the merchant server's secret manager.
- Register the DER/SPKI public key (Base64) in `t2t_s2s_client_keys`.
- Revoke a compromised key by setting its status to `REVOKED`.
- Requests use ECDSA-SHA256 signatures, a 2-minute timestamp window and a unique 32-byte hex nonce. Replayed nonces are rejected.

Example key registration (run through the secured database console after migration 010):

```sql
INSERT INTO public.t2t_s2s_client_keys (key_id, public_key_base64)
VALUES ('merchant-prod-key-2026-01', '<BASE64_DER_SPKI_PUBLIC_KEY>');
```

## Create payment order

`POST /api/console/payment-orders`

JSON body fields:
- `terminalId`: registered active T2T terminal identity
- `timestamp`: Unix milliseconds
- `nonce`: unique 32-64 character hex string
- `invoiceReference`: merchant invoice reference
- `amountUsdCents`: positive integer USD cents
- `amountUsdtRaw`: exact USDT base units (6 decimals)
- `expiresInSeconds`: 60-86400
- `quote`: signed quote returned by `POST /api/console/payment-quote`

Required headers:
- `X-T2T-Key-Id`
- `X-T2T-Signature`: Base64 DER ECDSA signature

The merchant signature is over the UTF-8 canonical string below, joined with a single LF and no trailing LF:

```text
T2T_S2S_PAYMENT_ORDER_V1
{keyId}
{terminalId}
{timestamp}
{nonce}
{invoiceReference}
{amountUsdCents}
{amountUsdtRaw}
{expiresInSeconds}
{quote.quoteId}
{quote.rateNumerator}
{quote.rateDenominator}
{quote.expiresAt}
{quote.signature}
{sha256(JSON.stringify(quote.rateMetadata ?? null))}
```

The quote itself must also pass T2T's independent signature, freshness and amount validation. A successful response contains the payment URL and exact receiver/amount. Treat `PENDING` as unpaid.

## Payment status

Use the customer `paymentUrl` token with the existing `GET /api/console/payment-status` endpoint. Never expose merchant private keys or dashboard tokens to customers.

## Read-only dashboard

The internal dashboard uses:
- `T2T_MERCHANT_DASHBOARD_TOKEN`: high-entropy read-only access token
- `T2T_DASHBOARD_S2S_KEY_ID`: the exact S2S key ID whose orders this dashboard may display

The API filters every order-list query by `s2s_key_id`; it does not return other S2S clients' orders. Configure a separate dashboard token and key scope per deployment. Do not put the merchant signing private key in the browser.

## Final receiving address

Set `T2T_TRON_RECEIVER_ADDRESS` to the confirmed Binance USDT TRC20 deposit address. Both payment-order creation and the confirmed-event scanner use this same address. Customers pay directly to Binance; T2T verifies the transfer and records the result. There is no intermediate T2T wallet and no forwarding transaction.

Never hardcode the deposit address in source code. Configure it as a protected deployment environment variable and verify the network is TRON (TRC20) before enabling payment links.

## Payment channels

- **S2S:** an authenticated merchant server creates a USD invoice through the signed S2S API.
- **IP-to-IP POS:** a trusted POS device initiates a payment request directly to another trusted POS device over the T2T device transport. The device exchange must preserve authenticated device identity, request signatures, replay protection and the same server-issued USD-to-USDT quote. This cloud S2S API alone does not implement the POS-to-POS transport.

## Important current boundary

The scanner records and matches confirmed USDT transfers idempotently. It does not create forwarding jobs, sign transactions or broadcast funds. A payment is marked `CONFIRMED` only after the confirmed on-chain transfer matches its invoice.
