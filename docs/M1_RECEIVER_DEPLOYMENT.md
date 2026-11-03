# M1 settlement receiver deployment configuration

The M1 dispatch route is server-only at `POST /api/console/m1-settlement-admin`
and requires the existing T2T administrative bearer authorization. Supported
actions are `prepare` (records a confirmed order in the durable outbox) and
`dispatch` (only an instruction already in `READY` may reach M1). Preparing an
instruction never sends it. A payment order creation never triggers M1.

## Server-side Vercel environment variables

Configure these in the Vercel project environment. Do not add them to browser
build variables or commit their values.

| Variable | Purpose |
| --- | --- |
| `M1_API_TOKEN` | M1 server API credential. |
| `M1_JWT_TOKEN` | Current M1 receiver JWT. It is checked for a valid JWT `exp` claim before dispatch. |
| `M1_SERVER_ID` | Must be the approved receiver ID. |
| `M1_ENDPOINT` | Must be the approved HTTPS settlement receiver URL. |
| `M1_AUTH_ENDPOINT` | Approved receiver-token URL. Token renewal is not implemented until M1 supplies its request and response schema. |
| `M1_TLS_CA_CERT_PEM` | Server-side PEM trust certificate used with normal TLS verification and the pinned SHA-256 fingerprint. The local-only certificate path is not relied on in Vercel. |
| `M1_CALLBACK_URL` | Stable HTTPS callback URL. Dispatch remains blocked until callback URL and callback-authentication requirements are approved and implemented. |
| `T2T_DATABASE_URL` or existing `DATABASE_URL_UNPOOLED` | Existing PostgreSQL connection. Use server-side Vercel configuration only. |
| `T2T_S2S_AUTHORIZATION_ADMIN_TOKEN` | Existing admin bearer credential protecting outbox read/prepare/dispatch operations. |
| `T2T_S2S_AUTHORIZATION_ADMIN_ID` | Existing audit actor ID for the authorized operator. |

Do not use `VITE_` or other client-exposed variable prefixes for any of these.
The supplied beneficiary accounts are held by the server-only beneficiary
configuration and copied as a one-account snapshot into each outbox row.

## Database

Apply `migrations/023_m1_settlement_outbox.sql` only after the existing payment
order and TRON deposit migrations. It has not been applied by this change. The
outbox stores exact USD cents/decimal text, one beneficiary selection, source
transaction/event, idempotency key, payload hash, status, attempt metadata, HTTP
status, and an allowlisted sanitized response. There is no `SETTLED` status:
M1 HTTP 202 is recorded as `ACCEPTED` only.

## Current deliberate dispatch blockers

The existing confirmed order/deposit records do not contain a debtor's legal
account-holder name or bank account. The existing M1 client requires those
fields, plus settlement currency, exchange rate, settlement amount, a mapped
creditor-account representation, narrative, and callback URL. The supplied
TRON sender address is not a bank account-holder identity. The available M1
client does not define a sender-bank field, so `Marov Group` is not inserted as
the debtor. No request is submitted while required fields are missing.

The project also has no approved receiver-token request/response contract or
callback-authentication contract. The currently configured local JWT is only
used while unexpired; the implementation fails closed after expiry and does
not invent a refresh request. No endpoint has been added to receive callbacks.
