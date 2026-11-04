# M1 instruction-registration integration

The SKIT endpoint at `https://140.245.233.184/api/v1/settlement/receive`
registers and acknowledges instructions only. It does not calculate FX, move
funds, initiate a GBP payment, or call `callback_url`. HTTP 202 / `ACCEPTED`
is not settlement confirmation.

## Confirmed receiver contract

- Token endpoint: `POST https://140.245.233.184/api/v1/auth/receiver-token`
- Token request header: `X-API-TOKEN`
- Token request body: `{"sub":"gab-gfs-skit-20261029"}`
- Receiver server ID: `M1-RECV-LIVE-05A308CC`
- Settlement endpoint: `https://140.245.233.184/api/v1/settlement/receive`
- Use the returned JWT in both Bearer authorization and `receiver.jwt_token`.
- `receiver.tls_verify` must be `true`.
- `X-Idempotency-Key` is required. Same key and same body replays the
  original acknowledgement; same key and different body returns HTTP 409.
- `X-Request-Signature` is optional. If enabled, it is HMAC-SHA256 over the
  exact serialized JSON request body, Base64URL encoded.
- `callback_url` is required in the request schema but is stored only.
  SKIT emits no callbacks, event IDs, callback signatures, or callback
  source-IP ranges. The integration uses
  `https://example.invalid/no-outbound-callback` as a non-routable placeholder.

SKIT does not define exchange-rate direction, decimal precision, rounding, or
fees. The sender must supply commercially agreed and internally consistent
`exchange_rate` and `settlement_amount` values. The receiver stores them
without recalculation or validation. Fees are not represented by this API.

## TLS and secrets

Configure secrets only in the verified CM Sender Vercel project or an approved
non-production environment. Never put secret values in source control,
client-side variables, chat, or build output.

| Variable | Purpose |
| --- | --- |
| `M1_API_TOKEN` | Newly rotated SKIT API token. |
| `M1_CLIENT_ID` | Agreed client ID: `gab-gfs-skit-20261029`. |
| `M1_SERVER_ID` | `M1-RECV-LIVE-05A308CC`. |
| `M1_ENDPOINT` | Approved settlement receiver URL above. |
| `M1_AUTH_ENDPOINT` | Approved receiver-token URL above. |
| `M1_TLS_CA_CERT_PEM` | SKIT's self-signed public certificate PEM. |
| `M1_REQUEST_SIGNATURE_SECRET` | Optional separate HMAC-SHA256 secret, minimum 32 bytes. |
| `M1_ID_DERIVATION_SECRET` | At least 32 random bytes for deterministic opaque IDs. |
| `M1_TREASURY_WALLET` | Existing application configuration only; not proof of a payout rail. |
| `T2T_DATABASE_URL` or existing database URL | Existing server-side Neon connection. |
| `T2T_S2S_AUTHORIZATION_ADMIN_TOKEN` | Existing admin bearer credential. |
| `T2T_S2S_AUTHORIZATION_ADMIN_ID` | Existing audit actor identifier. |

The SKIT certificate fingerprint is pinned in the receiver client:
`12:D8:0E:78:74:EE:56:1D:2A:6C:7E:61:C2:B8:ED:E6:BB:BE:15:DE:09:40:54:5B:B9:A6:00:80:61:58:A5:DE`.
TLS certificate validation, hostname validation and pin checking must all
remain enabled. Do not disable TLS verification.

## Outbox semantics and dispatch lock

The outbox tracks registration workflow only:
`BLOCKED_MISSING_REQUIRED_FIELDS` / `READY` → `SUBMITTING` →
`ACCEPTED`, with `REJECTED`, `CONFLICT`, or `UNKNOWN` for other
registration outcomes. `ACCEPTED` means the receiver registered the
instruction. It must never be promoted to `CONFIRMED`, `SETTLED`, or
financial-ledger finality by this API.

The application currently blocks all outbound instruction submissions from
the admin route. The receiver client remains unit-testable with mocked
transport, but no real SKIT request is enabled through the application.
This is stricter than a production-only guard: a real customer payment order
cannot accidentally be submitted from staging or development either.

A transport timeout or failure to persist a remote response is ambiguous.
Never automatically return such an instruction to `READY`; reconcile using
the same transaction and idempotency identity before any operator-approved
retry. The API's same-key/same-body replay returns the original acknowledgement.

## Production and financial controls

No production dispatch, payout, GBP payment leg, funds transfer, or settlement
confirmation is authorised by this receiver specification. A separate signed
payout agreement and a separately verified payment rail are required before
any production financial workflow can be designed.

Non-production connectivity testing, if separately enabled in a future change,
must use synthetic identities and non-financial fixtures only. It must not use
real customer deposits, payment orders, beneficiary details, or real capital.

## Database migrations

Migration 023 creates the instruction-registration outbox. Migration 025 was
introduced during the earlier callback design. Migration 026 removes only the
callback event table. Settlement status columns remain preserved for a future,
separately contracted payout/reconciliation process. Preserve migration
history and apply migration 026 through the normal controlled migration
process in every environment where migration 025 was applied.
