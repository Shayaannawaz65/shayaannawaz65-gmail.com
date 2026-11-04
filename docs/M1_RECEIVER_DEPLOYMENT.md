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
| `M1_REQUEST_SIGNATURE_SECRET` | Optional separate secret; if configured, use at least 32 random bytes and HMAC-SHA256 signs the exact settlement request body. SKIT confirms `X-Request-Signature` is optional. |
| `M1_TLS_CA_CERT_PEM` | Server-side PEM trust certificate used with normal TLS verification and the pinned SHA-256 fingerprint. |
| `M1_CALLBACK_URL` | Stable HTTPS callback URL; use `https://<production-host>/api/m1/skit-callback`. |
| `M1_DEBTOR_NAME` | Legal account-holder name of the actual sending bank account; never populate from a TRON wallet or beneficiary record. |
| `M1_DEBTOR_ACCOUNT` | Actual sending bank account identifier, server-side only. |
| `M1_DEBTOR_VERIFICATION_REF` | Internal reference to the verified sender bank record / mandate supporting the debtor fields. |
| `M1_BARCLAYS_ACCOUNT_NAME` | Verified beneficiary account-holder name, server-side only. |
| `M1_BARCLAYS_ACCOUNT_NUMBER` | Barclays local account number, server-side only. |
| `M1_BARCLAYS_SORT_CODE` | Barclays local sort code, server-side only. |
| `M1_BARCLAYS_BANK_ADDRESS` | Verified Barclays beneficiary bank address. |
| `M1_BARCLAYS_LEI` | Verified beneficiary legal entity identifier. |
| `M1_WISE_ACCOUNT_NAME`, `M1_WISE_ACCOUNT_NUMBER`, `M1_WISE_IBAN`, `M1_WISE_BIC_SWIFT` | Optional Wise beneficiary metadata, server-side only. |
| `M1_EXCHANGE_RATE_DIRECTION` | Must be explicitly confirmed as `USD_PER_USDT` before dispatch. |
| `M1_EXCHANGE_RATE_DECIMALS` | SKIT-confirmed rate precision, integer 0–12. |
| `M1_CALLBACK_HMAC_SECRET` | Separate callback HMAC-SHA256 secret, at least 32 bytes; provision only after SKIT confirms the callback signing contract. |
| `M1_CALLBACK_SIGNATURE_HEADER` | Exact SKIT callback signature header name, e.g. only if confirmed by SKIT. |
| `M1_CALLBACK_EVENT_ID_HEADER` | Exact unique callback event-ID header name, confirmed by SKIT. |
| `M1_CALLBACK_SIGNATURE_ENCODING` | SKIT-confirmed signature encoding: `hex` or `base64url`. |
| `M1_CALLBACK_STATUS_MAP` | JSON object mapping exact SKIT statuses to `ACCEPTED`, `PROCESSING`, `SETTLED`, `REJECTED`, or `UNKNOWN`; only map a final status after SKIT confirms its meaning. |
| `T2T_DATABASE_URL` or existing `DATABASE_URL_UNPOOLED` | Existing PostgreSQL connection. Use server-side Vercel configuration only. |
| `T2T_S2S_AUTHORIZATION_ADMIN_TOKEN` | Existing admin bearer credential protecting outbox read/prepare/dispatch operations. |
| `T2T_S2S_AUTHORIZATION_ADMIN_ID` | Existing audit actor ID for the authorized operator. |

Do not use `VITE_` or other client-exposed variable prefixes for any of these.
Never commit API tokens, JWTs, HMAC secrets, TLS private keys, bank account numbers, sort codes, IBANs, BIC/SWIFT identifiers, or beneficiary verification data. Beneficiary details are loaded only from server-side environment variables.

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
order and TRON deposit migrations. The outbox stores exact USD cents/decimal text, one beneficiary selection,
source transaction/event, debtor verification reference, idempotency key,
payload hash, submission attempt metadata, HTTP status, and an allowlisted
sanitized response. Apply `migrations/025_m1_callback_processing.sql` after
migration 023. The `submission_status` records HTTP delivery (so HTTP 202 is
`ACCEPTED` only); the separate `settlement_status` is changed only by an
authenticated callback whose exact external status is explicitly mapped.

## Current deliberate dispatch blockers

The existing confirmed order/deposit records do not contain a debtor's legal
account-holder name or bank account. The M1 client requires those fields, plus
settlement currency, exchange rate, settlement amount, a mapped creditor
account, narrative, and callback URL. The supplied TRON sender address is not
a bank account-holder identity. No request is submitted while required fields
are missing.

The receiver JWT is fetched from SKIT's token endpoint using the configured
client ID, cached only until its JWT `exp` with a safety margin, and checked
for the expected subject, receiver server ID, and token purpose. The optional
outbound `X-Request-Signature` uses the separate `M1_REQUEST_SIGNATURE_SECRET`.

The callback handler is `POST /api/m1/skit-callback`. On Vercel it is served by a dedicated function with JSON body parsing disabled so the original request stream remains available; local Express captures `req.rawBody` before parsing. It verifies the HMAC
against the original raw request bytes, requires a unique provider event ID,
and uses a PostgreSQL row lock on the matching outbox instruction. Callback
headers, signature encoding, and status mappings are deliberately not assumed:
the handler stays disabled (503) until the exact SKIT callback contract is
configured. It records callback events under unique event-ID and payload-hash
constraints and keeps the submission status separate from the settlement
status. A callback can map to `SETTLED` only when the configured SKIT status
map explicitly says that the provider status means final settlement.

The prepare path reuses the payment order's locked Kraken/CoinGecko quote and
BigInt-derived USDT raw amount. It formats USD to two decimals and TRC20 USDT
to six decimals without floating-point conversion. It also verifies that the
configured, precision-rounded USD-per-USDT rate reproduces the exact locked
USDT amount; if rounding changes that amount, the instruction stays blocked.
It remains blocked until
the exchange-rate direction/precision, sender bank details and their
verification reference, callback contract, callback URL, and approved TRON
treasury wallet are configured.
