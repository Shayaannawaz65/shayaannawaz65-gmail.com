# M1 settlement receiver deployment configuration

The M1 dispatch route is server-only at `POST /api/console/m1-settlement-admin`
and requires the existing T2T administrative bearer authorization. Supported
actions are `prepare` (records a confirmed order in the durable outbox) and
`dispatch` (only an instruction already in `READY` may reach M1). Preparing
an instruction never sends it. A payment order creation never triggers M1.

## Server-side Vercel environment variables

Configure these in the Vercel project environment. Do not add them to browser
build variables or commit their values.

| Variable | Purpose |
| --- | --- |
| `M1_API_TOKEN` | Rotated M1 X-API-TOKEN credential. |
| `M1_CLIENT_ID` | CM-issued client ID sent as `sub` to the receiver-token endpoint. |
| `M1_SERVER_ID` | Must be `M1-RECV-LIVE-05A308CC`. |
| `M1_ENDPOINT` | Must be the approved HTTPS settlement receiver URL. |
| `M1_AUTH_ENDPOINT` | Approved receiver-token URL. |
| `M1_TOKEN_NETWORK` | Must be `TRON Mainnet TRC20`. |
| `M1_TREASURY_WALLET` | Approved TRON Base58Check wallet address, server-side only. |
| `M1_ID_DERIVATION_SECRET` | At least 32 random bytes; HMAC-SHA256 derives stable opaque transaction and idempotency IDs. |
| `M1_REQUEST_SIGNATURE_SECRET` | Separate secret of at least 32 random bytes; HMAC-SHA256 signs every exact settlement request body. |
| `M1_TLS_CA_CERT_PEM` | Server-side PEM trust certificate used with normal TLS verification and the pinned SHA-256 fingerprint. |
| `M1_CALLBACK_URL` | Stable HTTPS callback URL. Callback authentication must be approved before callbacks can update status. |
| `T2T_DATABASE_URL` or existing `DATABASE_URL_UNPOOLED` | Existing PostgreSQL connection. Use server-side Vercel configuration only. |
| `T2T_S2S_AUTHORIZATION_ADMIN_TOKEN` | Existing admin bearer credential protecting outbox read/prepare/dispatch operations. |
| `T2T_S2S_AUTHORIZATION_ADMIN_ID` | Existing audit actor ID for the authorized operator. |

Do not use `VITE_` or other client-exposed variable prefixes for any of these.
Never commit API tokens, JWTs, HMAC secrets, or TLS private keys.

## Network and safety rules

This integration is configured for USDT on TRON Mainnet TRC20 only.
The destination wallet is supplied only through `M1_TREASURY_WALLET`;
no wallet address is hard-coded or guessed.

## Current deployment status

No production deployment is confirmed by this document. Do not assume that
credentials, a live JWT, treasury wallet, callback URL, or required bank
mapping are provisioned in Vercel merely because variable names are listed
here. Verify each production environment variable in the actual target Vercel
project before enabling dispatch. The previously inspected project was a
legacy T2T deployment and is not confirmed as the correct CM Sender project.

## Database

Apply `migrations/023_m1_settlement_outbox.sql` only after the existing payment
order and TRON deposit migrations. The outbox stores exact USD cents/decimal
text, one beneficiary selection, source transaction/event, idempotency key,
payload hash, status, attempt metadata, HTTP status, and an allowlisted
sanitized response. There is no `SETTLED` status: M1 HTTP 202 is recorded as
`ACCEPTED` only.

## Current deliberate dispatch blockers

The existing confirmed order/deposit records do not contain a debtor's legal
account-holder name or bank account. The M1 client requires those fields, plus
settlement currency, exchange rate, settlement amount, a mapped creditor
account, narrative, and callback URL. The supplied TRON sender address is not
a bank account-holder identity. No request is submitted while required fields
are missing.

The receiver JWT is supplied through protected `M1_JWT_TOKEN` and checked for
expiry before dispatch. The optional HMAC header is generated only when its
separate server-side secret is configured. Callback authentication remains a
separate requirement; no callback is marked complete without its authenticated
contract.
