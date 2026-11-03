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
| `M1_JWT_TOKEN` | Current M1 receiver JWT. It is checked for a valid JWT `exp` claim before dispatch. |
| `M1_SERVER_ID` | Must be `M1-RECV-LIVE-05A308CC`. |
| `M1_ENDPOINT` | Must be the approved HTTPS settlement receiver URL. |
| `M1_AUTH_ENDPOINT` | Approved receiver-token URL. |
| `M1_TOKEN_NETWORK` | Must be `TRON Mainnet TRC20`; Ethereum ERC-20 is rejected. |
| `M1_TREASURY_WALLET` | Approved TRON Base58Check wallet address, server-side only. |
| `M1_REQUEST_SIGNATURE_SECRET` | Optional HMAC-SHA256 secret if the receiver requires `X-Request-Signature`. |
| `M1_TLS_CA_CERT_PEM` | Server-side PEM trust certificate used with normal TLS verification and the pinned SHA-256 fingerprint. |
| `M1_CALLBACK_URL` | Stable HTTPS callback URL. Callback authentication must be approved before callbacks can update status. |
| `T2T_DATABASE_URL` or existing `DATABASE_URL_UNPOOLED` | Existing PostgreSQL connection. Use server-side Vercel configuration only. |
| `T2T_S2S_AUTHORIZATION_ADMIN_TOKEN` | Existing admin bearer credential protecting outbox read/prepare/dispatch operations. |
| `T2T_S2S_AUTHORIZATION_ADMIN_ID` | Existing audit actor ID for the authorized operator. |

Do not use `VITE_` or other client-exposed variable prefixes for any of these.
Never commit API tokens, JWTs, HMAC secrets, or TLS private keys.

## Network and safety rules

This integration is configured for USDT on TRON Mainnet TRC20 only.
Ethereum ERC-20 wallet addresses and network identifiers are rejected. The
TRON destination wallet is supplied through `M1_TREASURY_WALLET`; no
production wallet address is hard-coded or guessed.

## Current Vercel preview provisioning

For the `s2s-local-work` Preview environment, the sender-authorized
`M1_API_TOKEN` and pinned public receiver certificate
`M1_TLS_CA_CERT_PEM` have been stored as encrypted/sensitive server-side
variables. They are not present in source control. A fresh Preview deployment
is required for Vercel Functions to load newly-added environment variables.

The Bearer JWT, TRON treasury wallet, and callback URL are separate settings;
the dispatch route fails closed if they are not configured. Do not substitute
the T2T customer deposit address for the receiver's treasury wallet unless
the receiver explicitly confirms that mapping.

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
