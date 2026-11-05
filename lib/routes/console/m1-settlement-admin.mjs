import crypto from "node:crypto";
import pg from "pg";
import { getM1Beneficiary } from "../../cm/m1-beneficiaries.mjs";
import { isM1TreasuryWallet, M1_RECEIVER_CONTRACT } from "../../cm/m1-contract.mjs";
import { calculateUsdtRaw } from "../../payment-quote.mjs";
import { formatBigIntToDecimalString } from "../../cm/decimal-format.mjs";
import { createM1ReceiverClient } from "../../cm/m1-receiver-client.mjs";

const { Pool } = pg;
const ACTOR_RE = /^[A-Za-z0-9._-]{1,64}$/;
let pool;

function getPool(env = process.env) {
  if (!pool) {
    const connectionString = env.T2T_DATABASE_URL || env.DATABASE_URL_UNPOOLED ||
      env.POSTGRES_URL_NON_POOLING || env.DATABASE_URL || env.POSTGRES_URL;
    if (!connectionString || connectionString.includes("[SENSITIVE]")) {
      throw new Error("Database configuration unavailable");
    }
    const url = new URL(connectionString);
    if (url.searchParams.get("sslmode") === "require") url.searchParams.set("sslmode", "verify-full");
    pool = new Pool({
      connectionString: url.toString(),
      ssl: { rejectUnauthorized: true },
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000
    });
  }
  return pool;
}

function authorize(req, env) {
  const expected = env.T2T_S2S_AUTHORIZATION_ADMIN_TOKEN;
  const actorId = env.T2T_S2S_AUTHORIZATION_ADMIN_ID;
  const header = String(req.headers?.authorization || "");
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (typeof expected !== "string" || expected.length < 32 ||
      typeof actorId !== "string" || !ACTOR_RE.test(actorId)) return { unavailable: true };
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return {
    ok: actualBytes.length > 0 && actualBytes.length === expectedBytes.length &&
      crypto.timingSafeEqual(actualBytes, expectedBytes),
    actorId
  };
}

function usdFromCents(centsText) {
  const cents = BigInt(centsText);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function fixedDecimal(value, decimals) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,12})?$/.test(value) ||
      !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new Error("Invalid M1 exchange-rate precision or value");
  }
  const [whole, fraction = ""] = value.split(".");
  const scale = 10n ** BigInt(decimals);
  let scaled = BigInt(whole) * scale +
    BigInt((fraction.slice(0, decimals) || "").padEnd(decimals, "0") || "0");
  if (fraction.length > decimals && fraction[decimals] >= "5") scaled += 1n;
  return formatBigIntToDecimalString(scaled, decimals);
}

function calculateUsdtRawFromUsdPerUsdt(amountUsdCents, rateDecimal) {
  const [whole, fraction = ""] = rateDecimal.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const rateScaled = BigInt(whole) * scale + BigInt(fraction || "0");
  if (rateScaled <= 0n) throw new Error("Invalid M1 USD-per-USDT rate");
  const numerator = BigInt(amountUsdCents) * 1_000_000n * scale;
  const denominator = 100n * rateScaled;
  return ((numerator + denominator / 2n) / denominator).toString();
}

function getM1Quote(order, env) {
  const missing = [];
  const metadata = order.exchange_rate_metadata;
  let settlementAmount = null;
  let exchangeRate = null;

  try {
    if (!metadata || metadata.method !== "kraken_coingecko_midpoint_v1" ||
        metadata.quoteCurrency !== "USD" || metadata.baseCurrency !== "USDT" ||
        typeof metadata.referencePriceUsdPerUsdt !== "string" ||
        !order.exchange_rate_numerator || !order.exchange_rate_denominator ||
        !order.amount_usdt_raw) {
      throw new Error("Locked payment quote is incomplete");
    }
    const calculatedRaw = calculateUsdtRaw(
      order.amount_usd_cents,
      order.exchange_rate_numerator,
      order.exchange_rate_denominator
    );
    if (calculatedRaw !== BigInt(order.amount_usdt_raw).toString()) {
      throw new Error("Stored USDT amount does not match the locked quote");
    }
    settlementAmount = formatBigIntToDecimalString(BigInt(calculatedRaw), 6);
  } catch {
    missing.push("verified_locked_usd_usdt_quote");
  }

  if (env.M1_EXCHANGE_RATE_DIRECTION !== "USD_PER_USDT") {
    missing.push("m1_exchange_rate_direction_confirmation");
  }
  const precisionText = String(env.M1_EXCHANGE_RATE_DECIMALS || "");
  if (!/^(?:0|[1-9]|1[0-2])$/.test(precisionText)) {
    missing.push("m1_exchange_rate_precision_confirmation");
  } else if (metadata?.referencePriceUsdPerUsdt) {
    try {
      exchangeRate = fixedDecimal(metadata.referencePriceUsdPerUsdt, Number(precisionText));
      if (settlementAmount && order.amount_usdt_raw &&
          calculateUsdtRawFromUsdPerUsdt(order.amount_usd_cents, exchangeRate) !==
            BigInt(order.amount_usdt_raw).toString()) {
        exchangeRate = null;
        missing.push("m1_exchange_rate_precision_must_preserve_locked_settlement_amount");
      }
    } catch {
      exchangeRate = null;
      missing.push("valid_m1_exchange_rate_precision");
    }
  }
  return { exchangeRate, settlementAmount, missing };
}

function hashPayload(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deriveOpaqueId(secret, purpose, value) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
    throw new Error("M1_ID_DERIVATION_SECRET must be at least 32 bytes");
  }
  const digest = crypto.createHmac("sha256", secret)
    .update(`m1:v1:${purpose}:${value}`, "utf8")
    .digest("hex");
  return `M1-${digest}`;
}

function publicRecord(row) {
  return {
    instructionId: row.instruction_id,
    transactionId: row.transaction_id,
    idempotencyKey: row.idempotency_key,
    paymentOrderReference: row.payment_order_reference,
    beneficiary: row.beneficiary_code,
    currency: row.currency,
    amountUsd: row.amount_usd_decimal,
    debtorVerificationRef: row.debtor_verification_ref,
    submissionStatus: row.submission_status,
    missingRequiredFields: row.missing_required_fields,
    httpResponseStatus: row.http_response_status,
    sanitizedResponse: row.sanitized_response,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const SELECTED_FIELDS = `instruction_id, transaction_id, idempotency_key,
  payment_order_reference, beneficiary_code, currency, amount_usd_decimal,
  debtor_verification_ref,
  submission_status, missing_required_fields, http_response_status,
  sanitized_response, attempt_count, last_attempt_at, last_error_code,
  created_at, updated_at`;

function sanitizeM1Response(response) {
  let parsed;
  try {
    parsed = response?.response;
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    return { parseStatus: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { parseStatus: "empty_or_non_object" };
  }
  const output = {};
  for (const [key, value] of Object.entries(parsed)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "accepted" && typeof value === "boolean") {
      output.accepted = value;
      continue;
    }
    if ((normalizedKey === "status" || normalizedKey === "state") && typeof value === "string") {
      const normalizedValue = value.toUpperCase();
      if (["ACCEPTED", "PENDING", "PROCESSING", "COMPLETED", "SETTLED", "REJECTED", "FAILED"].includes(normalizedValue)) {
        output[normalizedKey] = normalizedValue;
      }
    }
  }
  return output;
}

async function findVerifiedOrder(client, orderId) {
  return client.query(
    `SELECT o.order_id, o.invoice_reference, o.currency,
            o.amount_usd_cents::text AS amount_usd_cents,
            o.amount_usdt_raw::text AS amount_usdt_raw,
            o.exchange_rate_numerator::text AS exchange_rate_numerator,
            o.exchange_rate_denominator::text AS exchange_rate_denominator,
            o.exchange_rate_metadata,
            o.status AS order_status, o.matched_transaction_id,
            o.matched_event_index, o.receiver_address,
            d.transaction_id, d.event_index, d.sender_address,
            d.receiver_address AS deposit_receiver_address,
            d.token_contract, d.amount_raw::text AS amount_raw,
            d.amount_usdt::text AS amount_usdt, d.block_timestamp,
            d.observation_status
       FROM public.t2t_payment_orders o
       JOIN public.tron_usdt_deposits d
         ON d.transaction_id = o.matched_transaction_id
        AND d.event_index = o.matched_event_index
      WHERE o.order_id = $1::uuid
        AND o.status = 'CONFIRMED'
        AND d.observation_status = 'OBSERVED_CONFIRMED'
      FOR UPDATE OF o`,
    [orderId]
  );
}

async function prepareInstruction({ poolProvider, actorId, orderId, beneficiaryCode, env }) {
  const beneficiary = getM1Beneficiary(beneficiaryCode, env);
  if (!beneficiary) return { status: 400, body: { error: "Select exactly one configured beneficiary" } };

  const client = await poolProvider().connect();
  try {
    await client.query("BEGIN");
    const orderResult = await findVerifiedOrder(client, orderId);
    if (orderResult.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { status: 404, body: { error: "Confirmed payment order and matching TRON evidence not found" } };
    }
    const order = orderResult.rows[0];
    const sourceTransactionId = String(order.transaction_id).trim().toLowerCase();
    const identityMaterial = `${order.order_id}:${sourceTransactionId}:${order.event_index}`;
    const idSecret = env.M1_ID_DERIVATION_SECRET;
    if (typeof idSecret !== "string" || Buffer.byteLength(idSecret) < 32) {
      await client.query("ROLLBACK");
      return { status: 503, body: { error: "Cryptographic ID derivation is not configured; no instruction was created" } };
    }
    const transactionId = deriveOpaqueId(idSecret, "transaction", identityMaterial);
    const idempotencyKey = deriveOpaqueId(idSecret, "idempotency", identityMaterial);
    const amountUsd = usdFromCents(order.amount_usd_cents);
    // SKIT stores this required field but never calls it. Do not configure a webhook route.
    const callbackUrl = "https://example.invalid/no-outbound-callback";
    const tokenNetwork = env.M1_TOKEN_NETWORK || M1_RECEIVER_CONTRACT.network;
    const treasuryWallet = env.M1_TREASURY_WALLET || "";
    const quote = getM1Quote(order, env);
    const debtorName = typeof env.M1_DEBTOR_NAME === "string" ? env.M1_DEBTOR_NAME.trim() : "";
    const debtorAccount = typeof env.M1_DEBTOR_ACCOUNT === "string"
      ? env.M1_DEBTOR_ACCOUNT.replace(/\s+/g, "").toUpperCase() : "";
    const debtorVerificationRef = typeof env.M1_DEBTOR_VERIFICATION_REF === "string"
      ? env.M1_DEBTOR_VERIFICATION_REF.trim() : "";
    const debtorNameValid = debtorName.length >= 2 && debtorName.length <= 140;
    const debtorAccountValid = /^[A-Z0-9]{2,34}$/.test(debtorAccount);
    const instruction = {
      transaction_id: transactionId,
      amount: amountUsd,
      currency: "USD",
      settlement_currency: "USDT",
      exchange_rate: quote.exchangeRate,
      settlement_amount: quote.settlementAmount,
      debtor_name: debtorNameValid ? debtorName : null,
      debtor_account: debtorAccountValid ? debtorAccount : null,
      creditor_name: beneficiary.account_name,
      creditor_account: beneficiary.account_number || null,
      ...(beneficiary.bank ? { creditor_bank_name: beneficiary.bank } : {}),
      ...(beneficiary.bank_address ? { creditor_bank_address: beneficiary.bank_address } : {}),
      ...(beneficiary.sort_code ? { creditor_sort_code: beneficiary.sort_code } : {}),
      ...(beneficiary.lei ? { creditor_lei: beneficiary.lei } : {}),
      ...(beneficiary.iban ? { creditor_iban: beneficiary.iban } : {}),
      ...(beneficiary.bic_swift ? { creditor_swift: beneficiary.bic_swift } : {}),
      reference: order.invoice_reference,
      narrative: `Payment settlement for invoice ${order.invoice_reference}`,
      callback_url: callbackUrl,
      tokenization_details: {
        token_type: M1_RECEIVER_CONTRACT.tokenType,
        network: tokenNetwork,
        wallet_address: treasuryWallet
      }
    };
    const missing = [
      ...quote.missing,
      ...(!beneficiary.account_name ? ["creditor_name_beneficiary_configuration"] : []),
      ...(!beneficiary.account_number ? ["creditor_account_beneficiary_configuration"] : []),
      ...(!debtorNameValid ? ["debtor_name_from_verified_sender_bank_record"] : []),
      ...(!debtorAccountValid ? ["debtor_account_from_verified_sender_bank_record"] : []),
      ...(!debtorVerificationRef ? ["debtor_data_provenance_reference"] : []),
    ];
    if (tokenNetwork !== M1_RECEIVER_CONTRACT.network) missing.push("approved_tron_mainnet_trc20_network_configuration");
    if (!isM1TreasuryWallet(treasuryWallet)) missing.push("approved_m1_treasury_wallet_configuration");
    const beneficiarySnapshot = { ...beneficiary };
    const requestPayloadHash = hashPayload({ instruction, beneficiary: beneficiarySnapshot });
    const inserted = await client.query(
      `INSERT INTO public.t2t_m1_settlement_outbox
         (transaction_id, idempotency_key, payment_order_id,
          payment_order_reference, blockchain_transaction_id,
          blockchain_event_index, beneficiary_code, beneficiary_snapshot,
          currency, amount_usd_cents, amount_usd_decimal,
          settlement_currency, exchange_rate_decimal, settlement_amount_decimal,
          debtor_verification_ref, instruction_payload, request_payload_hash,
          missing_required_fields, submission_status, created_by)
       VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8::jsonb,'USD',$9::numeric,$10,
               'USDT',$11,$12,$13,$14::jsonb,$15,$16,
               CASE WHEN cardinality($16::text[]) = 0 THEN 'READY'
                    ELSE 'BLOCKED_MISSING_REQUIRED_FIELDS' END,$17)
       ON CONFLICT DO NOTHING
       RETURNING ${SELECTED_FIELDS}`,
      [transactionId, idempotencyKey, order.order_id, order.invoice_reference,
        order.transaction_id, order.event_index, beneficiary.code,
        JSON.stringify(beneficiarySnapshot), order.amount_usd_cents, amountUsd,
        quote.exchangeRate, quote.settlementAmount, debtorVerificationRef || null,
        JSON.stringify(instruction), requestPayloadHash, missing, actorId]
    );

    if (inserted.rowCount === 1) {
      await client.query("COMMIT");
      return { status: 201, body: { duplicate: false, instruction: publicRecord(inserted.rows[0]) } };
    }

    const existing = await client.query(
      `SELECT ${SELECTED_FIELDS}, payment_order_id::text AS existing_order_id,
              blockchain_transaction_id, blockchain_event_index
         FROM public.t2t_m1_settlement_outbox
        WHERE transaction_id = $1 OR idempotency_key = $2
        FOR UPDATE`,
      [transactionId, idempotencyKey]
    );
    if (existing.rowCount !== 1 || existing.rows[0].beneficiary_code !== beneficiary.code ||
        existing.rows[0].existing_order_id !== order.order_id ||
        existing.rows[0].blockchain_transaction_id !== order.transaction_id ||
        existing.rows[0].blockchain_event_index !== order.event_index) {
      await client.query("ROLLBACK");
      return { status: 409, body: { error: "Conflicting M1 instruction already exists for this transaction" } };
    }
    await client.query("COMMIT");
    return { status: 200, body: { duplicate: true, instruction: publicRecord(existing.rows[0]) } };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    if (error?.code === "23505") {
      return { status: 409, body: { error: "M1 transaction or idempotency reference already exists" } };
    }
    throw error;
  } finally {
    client.release();
  }
}

export function createHandler({
  env = process.env,
  poolProvider = () => getPool(env),
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    if (!["GET", "POST"].includes(req.method)) {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const auth = authorize(req, env);
    if (auth.unavailable) return res.status(503).json({ error: "M1 settlement administration is not configured" });
    if (!auth.ok) return res.status(401).json({ error: "Unauthorized" });

    try {
      if (req.method === "GET") {
        const result = await poolProvider().query(
          `SELECT ${SELECTED_FIELDS}
             FROM public.t2t_m1_settlement_outbox
            ORDER BY created_at DESC
            LIMIT 100`
        );
        return res.status(200).json({ records: result.rows.map(publicRecord) });
      }

      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ error: "Invalid request" });
      }
      if (req.body.action === "authenticate") {
        const result = await requestM1ReceiverToken(env);
        if (result.configurationMissing) {
          return res.status(503).json({
            error: "M1 receiver authentication configuration unavailable",
            requiredEnvironment: ["M1_API_TOKEN", "CM_CLIENT_ID", "M1_TLS_CA_CERT_PEM"]
          });
        }
        if (result.httpStatus === 200 && result.accessTokenReceived) {
          return res.status(200).json({
            authenticated: true,
            receiverServerId: "M1-RECV-LIVE-05A308CC",
            receiverHttpStatus: 200,
            accessTokenReceived: true,
            accessTokenReturned: false,
            tlsVerification: "verified",
            tlsPinVerification: "verified"
          });
        }
        return res.status(502).json({
          error: "M1 receiver authentication was not confirmed",
          receiverHttpStatus: result.httpStatus,
          accessTokenReceived: result.accessTokenReceived
        });
      }

      if (req.body.action === "authenticate") {
        const missing = ["M1_API_TOKEN", "CM_CLIENT_ID", "M1_TLS_CA_CERT_PEM"]
          .filter(key => typeof env[key] !== "string" || !env[key].trim());
        if (missing.length) {
          return res.status(503).json({
            error: "M1 receiver authentication configuration unavailable",
            missingEnvironment: missing
          });
        }
        try {
          const receiver = createM1ReceiverClient({
            apiToken: env.M1_API_TOKEN,
            clientId: env.CM_CLIENT_ID,
            serverId: M1_RECEIVER_CONTRACT.serverId,
            endpoint: M1_RECEIVER_CONTRACT.endpoint,
            authEndpoint: M1_RECEIVER_CONTRACT.authEndpoint,
            certificatePem: env.M1_TLS_CA_CERT_PEM,
            timeoutMs: 30000
          });
          const result = await receiver.authenticate();
          return res.status(200).json({
            authenticated: true,
            receiverServerId: M1_RECEIVER_CONTRACT.serverId,
            receiverHttpStatus: 200,
            tokenExpiresAt: result.tokenExpiresAt,
            accessTokenReturned: false,
            tlsVerification: "verified",
            tlsPinVerification: "verified"
          });
        } catch (error) {
          return res.status(error?.m1Stage === "http" ? 504 : 502).json({
            error: "M1 receiver authentication failed",
            stage: error?.m1Stage || "unknown",
            code: String(error?.code || "M1_AUTH_FAILED").slice(0, 64)
          });
        }
      }

      if (req.body.action === "prepare") {
        const orderId = String(req.body.orderId || "").trim();
        const beneficiaryCode = String(req.body.beneficiary || "").trim();
        if (!/^[0-9a-f-]{36}$/i.test(orderId) || !getM1Beneficiary(beneficiaryCode, env)) {
          return res.status(400).json({ error: "A valid confirmed order ID and exactly one beneficiary are required" });
        }
        const prepared = await prepareInstruction({
          poolProvider, actorId: auth.actorId, orderId, beneficiaryCode, env
        });
        return res.status(prepared.status).json(prepared.body);
      }
      if (req.body.action === "dispatch") {
        const instructionId = String(req.body.instructionId || "").trim();
        if (!/^[0-9a-f-]{36}$/i.test(instructionId)) {
          return res.status(400).json({ error: "Valid instruction ID required" });
        }
        // The local credential file is loaded only on self-hosted/local Node.
        // Vercel must provide all secrets as server-side environment variables.
        // This endpoint only registers instructions; SKIT does not move funds.
        // Production dispatch remains disabled pending a separately signed payout agreement.
        if (env.NODE_ENV === "production") {
          return res.status(403).json({
            error: "M1 production instruction submission is disabled; this receiver does not execute payouts"
          });
        }
        // No application route may submit instructions yet. SKIT is registration-only;
        // keep real order/deposit records out of this endpoint until a separately
        // reviewed synthetic-fixture harness and signed payout framework exist.
        return res.status(403).json({
          error: "M1 outbound submission is disabled; no production or customer instruction may be registered"
        });
      }
      return res.status(400).json({ error: "Unsupported M1 admin action" });
    } catch {
      return res.status(503).json({ error: "M1 settlement operation unavailable" });
    }
  };
}

export default createHandler();
