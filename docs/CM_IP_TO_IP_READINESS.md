# CM Payment POS IP-to-IP readiness

Reviewed on 2026-11-01 on branch `s2s-local-work`.

This is an implementation-readiness record for the existing T2T project. It is
not a CM API contract. No CM host, port, path, transport, or message format is
assumed here.

## Existing T2T identity and endpoint

- The Android terminal identity is `OFFLINE-201.3-001`. Its P-256
  (`secp256r1`) key is generated and held by Android Keystore. The Android app
  can sign requests and expose its public key for trust registration. The
  terminal ID must remain unchanged.
- The Android heartbeat hardcodes the T2T Vercel HTTPS origin
  `https://t2t-tron-usdt-aili.vercel.app` and posts to the existing
  `/api/console/heartbeat` route. The backend also routes its existing quote,
  order, and status handlers. This origin is not a CM endpoint, and its live
  deployment/TLS state was not checked during this local-only review.
- The current Android payment base URL is blank. The Android payment UI is
  therefore disabled until configured. The existing payment client implements
  a quote plus payment-link flow; it is not a CM POS client.

## Existing P-256 S2S support

- The backend quote and order handlers authenticate requests using a
  registered S2S `keyId`, a P-256 ECDSA-SHA256 signature, timestamp, and nonce.
  POS clients must also be active and authorized for the submitted terminal
  ID.
- The backend has an admin route for creating S2S clients and registering or
  revoking public keys. The terminal-access route manages key-to-terminal
  authorization. This review did not invoke either route or inspect deployed
  authorization records.
- A local T2T internal S2S key helper exists. Its private key must remain
  private on its host. That internal client identity is distinct from CM's
  client identity and from the Android Keystore terminal key.
- The existing helper targets a deployment-specific Vercel origin and calls
  the current quote/payment-order flow. It is not a CM client or a stable CM
  endpoint configuration and was not run.
- A local registration payload record exists, but it is not proof of the
  deployed database state. No deployed client/key or terminal authorization
  status was queried.
- No CM client/key has been confirmed as registered or authorized. Required
  registration must use public keys only, through the approved admin process.

## Android/backend V2 alignment

- `TerminalIdentity.kt` already generates a P-256 key under Android Keystore,
  uses SHA-256 ECDSA, and exports the public key as DER/SPKI Base64. Its
  terminal ID remains `OFFLINE-201.3-001`.
- The Android heartbeat already matches the separate backend heartbeat
  contract: canonical `terminalId`, timestamp, nonce joined by LF, with the
  Base64 signature in the JSON body. It correctly has no S2S key/client headers.
- The Android payment-quote request previously used a V1 canonical string and
  put its signature in the JSON body. It now uses the backend V2 canonical
  order and `X-T2T-Key-Id` / `X-T2T-Signature` headers. USD cents are sent as a
  decimal string; timestamps remain Unix milliseconds and nonces are 32
  lowercase hex characters. A process-local guard rejects accidental nonce
  reuse before signing.
- Android now verifies the backend's V3 quote signature bound to the S2S client
  ID and validates the current quote metadata fields. This is the quote
  response-signature protocol, distinct from the V2 request-auth protocol.
- Android client/key IDs remain blank until an approved POS client/key is
  provisioned and authorized. No key was registered in this task.
- The existing dirty order handler still contains its legacy WhatsApp/payment
  URL behavior, but its public route registration is disabled. It is not part
  of the CM receiving flow.

## Internal payment instruction validation

- `lib/cm/payment-pos-adapter.mjs` validates an internally supplied payment
  reference, `USD`, and authoritative expected amount in exact integer cents.
  It performs no CM request, defines no external fields, and creates or looks
  up no invoice.
- `tests/cm-payment-pos-adapter.test.mjs` covers canonical payment-reference
  validation, USD-only denomination, exact large-cent preservation, and
  rejection of malformed values.
- `lib/cm/inbound-receipt-adapter.mjs` remains the opaque inbound seam. There
  is no public CM transport or route until CM's approved contract is available.

## Stable outbound IP

- Vercel Functions use changing outbound IPs by default. Vercel Static IPs can
  provide a stable, shared egress pair for selected regions on Pro/Enterprise;
  Secure Compute provides dedicated private-network addresses on Enterprise.
- The Vercel account's plan, selected region, Static IP/Secure Compute status,
  and assigned addresses are not represented in this checkout and were not
  inspected. No allowlist values can be supplied until the account owner
  enables the chosen option and Vercel displays the assigned addresses.
- If T2T runs directly on an Android POS instead of calling CM from a Vercel
  Function, the egress address depends on the POS network, router/NAT, carrier,
  or VPN. CM must specify whether it allowlists a fixed WAN/VPN address or
  accepts traffic over a private route.

## USD order and blockchain confirmation

- The backend accepts USD cents, issues a short-lived signed USD/USDT quote,
  computes exact USDT base units, and has an on-chain scanner/matcher that
  confirms a unique matching USDT transfer by contract, receiver, amount, and
  order time window.
- The legacy payment-order handler remains in the worktree, but its public
  route registration was removed locally so the CM work cannot invoke its
  customer payment-link or WhatsApp behavior.
- CM's response semantics and any CM transaction/reference fields are unknown.
  The integration must not mark a payment confirmed solely from an
  unverified request or response. CM must specify which event is authoritative
  and how it maps to the internal payment reference and, if applicable, the confirmed
  blockchain transfer.

## CM information required before transport implementation

1. Connection direction and network topology: which POS initiates/listens,
   reachable host/IP for both sides, routing/VPN/NAT, and firewall allowlists.
2. CM payment API port, path, method, transport, TLS certificate/trust rules,
   and environment (test vs production). Port 22 is not presumed to be an API
   port.
3. Request/response JSON schema, USD amount and invoice-reference semantics,
   error codes, timeouts, retries, idempotency, and duplicate handling.
4. P-256 curve, signing input/canonicalization, signature encoding, timestamp
   and nonce rules, CM client/key IDs, CM public key, and how CM will register
   and verify T2T's existing public key.
5. Payment lifecycle: what CM's response means (accepted, authorized, captured,
   or settled), what status callback/polling is supported, and what on-chain
   transaction evidence is expected for blockchain confirmation.

Until those details are supplied, only the existing T2T components above are
ready. The CM transport and CM-specific payment lifecycle are not implemented.

## Inbound receipt preparation

- `lib/cm/inbound-receipt-adapter.mjs` is the CM inbound seam. It accepts an
  opaque inbound request and delegates parsing to an injected normalizer; it
  defines no endpoint, wire fields, or authentication rules.
- `lib/receipts/payment-receipt-service.mjs` defines a normalized internal
  receipt ledger. It accepts an approved payment instruction containing the
  internal payment reference and authoritative expected USD cents; it does not
  create or look up invoices. Its durable PostgreSQL repository and migration
  `020_payment_receipts.sql` store expected USD cents, the
  separately reported CM release amount, actual loader-received USD cents,
  blockchain transaction evidence, exchange evidence, and wallet settlement
  evidence as separate statuses.
- `recordCmRelease` requires an injected S2S authenticator and verified payment
  instruction from the approved source. A release creates only `RELEASE_REPORTED`;
  loader remains `AWAITING`, blockchain `UNVERIFIED`, exchange
  `NOT_STARTED`, and wallet settlement `NOT_STARTED`. Duplicate normalized
  receipt references are idempotent; different data under the same reference
  is rejected.
- Later stages require injected evidence verifiers and enforce the order
  loader receipt → blockchain verification → exchange conversion → wallet
  settlement. An actual USD receipt that differs from the expected instruction
  amount remains auditable but cannot advance to blockchain verification or
  settlement. DB operation keys and state transitions commit transactionally.
- The in-memory repository exists for local unit tests only. Production code
  must use the PostgreSQL repository plus CM-approved S2S and evidence
  verifiers. No inbound route is wired yet. Current quote/order signatures are
  operation-specific; their canonical payload cannot be reused for a CM
  release event without an approved CM contract. The authenticator injection
  must verify active client/key ownership, active terminal authorization,
  existing P-256 ECDSA behavior, timestamp window, and persistent nonce replay
  protection before returning a principal.
- Existing TRON loader code persists confirmed USDT transfers in
  `tron_usdt_deposits` and matches them to the legacy payment-order model. It
  also has an injectable `receiptLedgerBridge` hook. The bridge maps only
  confirmed deposit rows to blockchain evidence and requires an injected
  resolver to associate a transfer with an internal payment reference. It does
  not use legacy order/link matching. A production resolver and a verified USD
  Payment Loader receipt source are still needed.
- `lib/cm/payment-pos-adapter.mjs` validates only the authoritative internal
  payment instruction. It does not initiate authorization or model a CM wire
  message. No CM endpoint, payload, or auth scheme was added.
- Exchange/liquidation is represented only by a verified evidence transition.
  `lib/settlement/liquidation-adapter.mjs` separately gates injected conversion
  and wallet-settlement workflows on verified prior states. It does not mark
  either state complete from a workflow response. No exchange vendor, API
  endpoint, credentials, wallet destination, or transfer execution is
  implemented.

## Change boundary

The local changes add no CM wire behavior or public CM endpoint. They add the
internal receipt ledger/repository and optional post-commit loader bridge. The
receipt migration was exercised against an isolated local PostgreSQL database.
No keys were registered, CM was not contacted, and no deployment or payment
was initiated. Existing unrelated working-tree changes remain preserved.
