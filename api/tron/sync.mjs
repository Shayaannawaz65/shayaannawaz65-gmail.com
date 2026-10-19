import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const TXID_RE = /^[0-9a-f]{64}$/i;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

let pool;

export function normalizeTronAddress(value) {
  const input = String(value || "");

  if (ADDRESS_RE.test(input)) {
    let n = 0n;
    for (const char of input) {
      const digit = BASE58.indexOf(char);
      if (digit < 0) return "";
      n = n * 58n + BigInt(digit);
    }

    let hexValue = n.toString(16);
    if (hexValue.length % 2) hexValue = "0" + hexValue;
    const decoded = n === 0n ? Buffer.alloc(0) : Buffer.from(hexValue, "hex");
    let leadingZeros = 0;
    while (leadingZeros < input.length && input[leadingZeros] === "1") {
      leadingZeros++;
    }
    const bytes = Buffer.concat([Buffer.alloc(leadingZeros), decoded]);

    if (bytes.length !== 25) return "";
    const payload = bytes.subarray(0, 21);
    const checksum = bytes.subarray(21);
    if (payload[0] !== 0x41) return "";

    const sha = b => crypto.createHash("sha256").update(b).digest();
    if (!sha(sha(payload)).subarray(0, 4).equals(checksum)) return "";
    return input;
  }

  let hex = input.replace(/^0x/i, "");
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{2})?$/i.test(hex)) return "";
  if (hex.length === 40) {
    hex = "41" + hex;
  } else if (!hex.toLowerCase().startsWith("41")) {
    return "";
  }

  const payload = Buffer.from(hex, "hex");
  const sha = b => crypto.createHash("sha256").update(b).digest();
  const bytes = Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]);

  let n = BigInt("0x" + bytes.toString("hex"));
  let encoded = "";
  while (n > 0n) {
    encoded = BASE58[Number(n % 58n)] + encoded;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded;
}

export function authorized(req, expected) {
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function amountUsdt(raw) {
  const n = BigInt(raw);
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, "0")}`;
}

function getPool() {
  if (!pool) {
    // Prefer the pooled connection for serverless execution.
    const connectionString =
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.DATABASE_URL_UNPOOLED ||
      process.env.POSTGRES_URL_NON_POOLING;

    if (!connectionString || connectionString.includes("[SENSITIVE]")) {
      throw new Error("Database configuration missing");
    }

    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: true },
      max: 2,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000
    });
  }
  return pool;
}

export function createHandler({
  poolProvider = getPool,
  fetchImpl = (...args) => fetch(...args)
} = {}) {
  return async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.T2T_TRON_SYNC_TOKEN;
  const receiver = process.env.T2T_TRON_RECEIVER_ADDRESS;
  const apiKey = process.env.TRONGRID_API_KEY;

  if (!token || !ADDRESS_RE.test(receiver || "") || normalizeTronAddress(receiver) !== receiver || !apiKey) {
    return res.status(503).json({ error: "Server configuration incomplete" });
  }
  if (!authorized(req, token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let client;
  let leaseToken;

  try {
    client = await poolProvider().connect();

    const now = Date.now();
    const overlapMs = 10 * 60 * 1000;
    const initialLookbackMs = 24 * 60 * 60 * 1000;
    const windowMs = 15 * 60 * 1000;
    const maxWindows = 4;
    const leaseDurationMs = 180000;
    const requestBudget = { used: 0, max: 40 };

    await client.query(
      `INSERT INTO public.tron_usdt_sync_state
         (receiver_address, last_completed_timestamp)
       VALUES ($1, $2)
       ON CONFLICT (receiver_address) DO NOTHING`,
      [receiver, new Date(now - initialLookbackMs).toISOString()]
    );

    leaseToken = crypto.randomUUID();
    const lease = await client.query(
      `UPDATE public.tron_usdt_sync_state
       SET lease_token = $2::uuid,
           lease_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE receiver_address = $1
         AND (lease_until IS NULL OR lease_until <= NOW())
       RETURNING receiver_address`,
      [receiver, leaseToken, leaseDurationMs]
    );

    if (lease.rowCount !== 1) {
      return res.status(409).json({
        error: "Sync already in progress",
        retry_required: true,
        auto_approval: false
      });
    }

    async function renewLease() {
      const renewed = await client.query(
        `UPDATE public.tron_usdt_sync_state
         SET lease_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
             updated_at = NOW()
         WHERE receiver_address = $1
           AND lease_token = $2::uuid
           AND lease_until > NOW()
         RETURNING receiver_address`,
        [receiver, leaseToken, leaseDurationMs]
      );

      if (renewed.rowCount !== 1) {
        const error = new Error("Sync lease lost");
        error.code = "SYNC_LEASE_LOST";
        throw error;
      }
    }

    const state = await client.query(
      `SELECT last_completed_timestamp
       FROM public.tron_usdt_sync_state
       WHERE receiver_address = $1`,
      [receiver]
    );

    let cursorMs = new Date(
      state.rows[0].last_completed_timestamp
    ).getTime();

    let pagesRead = 0;
    let eventsSeen = 0;
    let invalidEvents = 0;
    let newEvents = 0;
    let completedWindows = 0;

    const eventCache = new Map();

    async function fetchJson(url) {
      if (requestBudget.used >= requestBudget.max) {
        const error = new Error("Blockchain request budget exhausted");
        error.budgetExhausted = true;
        throw error;
      }

      await renewLease();
      requestBudget.used++;
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "TRON-PRO-API-KEY": apiKey
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        const error = new Error("Blockchain provider unavailable");
        error.providerFailure = true;
        throw error;
      }

      const body = await response.json();
      if (!Array.isArray(body.data)) {
        const error = new Error("Invalid blockchain response");
        error.providerFailure = true;
        throw error;
      }
      return body;
    }

    async function getTransactionEvents(txid) {
      if (eventCache.has(txid)) return eventCache.get(txid);

      const all = [];
      let fingerprint = null;
      let complete = false;

      for (let page = 0; page < 20; page++) {
        const url = new URL(
          `https://api.trongrid.io/v1/transactions/${txid}/events`
        );
        url.searchParams.set("only_confirmed", "true");
        url.searchParams.set("limit", "200");
        if (fingerprint) url.searchParams.set("fingerprint", fingerprint);

        const body = await fetchJson(url);
        all.push(...body.data);
        fingerprint = body.meta?.fingerprint || null;

        if (!fingerprint) {
          complete = true;
          break;
        }
      }

      if (!complete) {
        const error = new Error("Transaction event pagination incomplete");
        error.budgetExhausted = requestBudget.used >= requestBudget.max;
        throw error;
      }

      eventCache.set(txid, all);
      return all;
    }

    async function scanWindow(startMs, endMs, depth = 0) {
      let fingerprint = null;
      let complete = false;
      const accepted = [];
      let pages = 0;
      let events = 0;
      let invalid = 0;

      try {
        for (let page = 0; page < 20; page++) {
          const url = new URL(
            `https://api.trongrid.io/v1/accounts/${receiver}/transactions/trc20`
          );
          url.searchParams.set("only_confirmed", "true");
          url.searchParams.set("only_to", "true");
          url.searchParams.set("contract_address", USDT_CONTRACT);
          url.searchParams.set("limit", "200");
          url.searchParams.set("order_by", "block_timestamp,desc");
          url.searchParams.set("min_timestamp", String(startMs));
          url.searchParams.set("max_timestamp", String(endMs));
          if (fingerprint) url.searchParams.set("fingerprint", fingerprint);

          const body = await fetchJson(url);
          pages++;
          events += body.data.length;

          for (const row of body.data) {
            const txid = String(row.transaction_id || "").toLowerCase();
            const sender = normalizeTronAddress(row.from);
            const recipient = normalizeTronAddress(row.to);
            const tokenContract = normalizeTronAddress(row.token_info?.address);
            const raw = String(row.value ?? "");
            const timestamp = Number(row.block_timestamp);

            if (
              !TXID_RE.test(txid) ||
              !ADDRESS_RE.test(sender) ||
              recipient !== receiver ||
              tokenContract !== USDT_CONTRACT ||
              !/^[1-9][0-9]*$/.test(raw) ||
              !Number.isSafeInteger(timestamp) ||
              timestamp < startMs ||
              timestamp > endMs
            ) {
              invalid++;
              continue;
            }

            const txEvents = await getTransactionEvents(txid);

            for (const event of txEvents) {
              const eventTxid = String(event.transaction_id || "").toLowerCase();
              const contract = normalizeTronAddress(event.contract_address);
              const eventSender = normalizeTronAddress(event.result?.from);
              const eventRecipient = normalizeTronAddress(event.result?.to);
              const eventRaw = String(event.result?.value ?? "");
              const eventIndex = Number(event.event_index);
              const eventTimestamp = Number(event.block_timestamp);

              if (
                eventTxid !== txid ||
                contract !== USDT_CONTRACT ||
                event.event_name !== "Transfer" ||
                eventSender !== sender ||
                eventRecipient !== recipient ||
                eventRaw !== raw
              ) continue;

              if (
                !Number.isSafeInteger(eventIndex) ||
                eventIndex < 0 ||
                !Number.isSafeInteger(eventTimestamp) ||
                eventTimestamp < startMs ||
                eventTimestamp > endMs ||
                event._unconfirmed === true ||
                event.success === false
              ) {
                invalid++;
                continue;
              }

              accepted.push({
                txid,
                eventIndex,
                sender,
                recipient,
                raw,
                timestamp: eventTimestamp,
                event
              });
            }
          }

          fingerprint = body.meta?.fingerprint || null;
          if (!fingerprint) {
            complete = true;
            break;
          }
        }
      } catch (error) {
        if (error.providerFailure) throw error;
        if (!error.budgetExhausted && requestBudget.used < requestBudget.max) {
          throw error;
        }
      }

      if (complete) {
        return { complete: true, accepted, pages, events, invalid };
      }

      if (
        depth >= 5 ||
        endMs - startMs <= 1000 ||
        requestBudget.used >= requestBudget.max
      ) {
        return { complete: false, accepted: [], pages, events, invalid };
      }

      const middle = Math.floor((startMs + endMs) / 2);
      const left = await scanWindow(startMs, middle, depth + 1);
      if (!left.complete) {
        return {
          complete: false,
          accepted: [],
          pages: pages + left.pages,
          events: events + left.events,
          invalid: invalid + left.invalid
        };
      }

      const right = await scanWindow(middle + 1, endMs, depth + 1);
      if (!right.complete) {
        return {
          complete: false,
          accepted: [],
          pages: pages + left.pages + right.pages,
          events: events + left.events + right.events,
          invalid: invalid + left.invalid + right.invalid
        };
      }

      return {
        complete: true,
        accepted: [...left.accepted, ...right.accepted],
        pages: pages + left.pages + right.pages,
        events: events + left.events + right.events,
        invalid: invalid + left.invalid + right.invalid
      };
    }

    while (cursorMs < now && completedWindows < maxWindows) {
      const windowEnd = Math.min(cursorMs + windowMs, now);
      const windowStart = Math.max(0, cursorMs - overlapMs);
      const scan = await scanWindow(windowStart, windowEnd);

      pagesRead += scan.pages;
      eventsSeen += scan.events;
      invalidEvents += scan.invalid;

      if (!scan.complete) {
        const currentState = await client.query(
          `SELECT last_completed_timestamp
           FROM public.tron_usdt_sync_state
           WHERE receiver_address = $1`,
          [receiver]
        );

        return res.status(503).json({
          ok: false,
          status: "SCAN_INCOMPLETE",
          pages_read: pagesRead,
          events_seen: eventsSeen,
          completed_windows: completedWindows,
          database_writes: newEvents,
          cursor_timestamp: currentState.rows[0].last_completed_timestamp,
          retry_required: true,
          auto_approval: false
        });
      }

      await client.query("BEGIN");

      try {
        const leaseCheck = await client.query(
          `UPDATE public.tron_usdt_sync_state
           SET lease_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
               updated_at = NOW()
           WHERE receiver_address = $1
             AND lease_token = $2::uuid
             AND lease_until > NOW()
           RETURNING receiver_address`,
          [receiver, leaseToken, leaseDurationMs]
        );

        if (leaseCheck.rowCount !== 1) {
          const error = new Error("Sync lease lost before commit");
          error.code = "SYNC_LEASE_LOST";
          throw error;
        }

        for (const item of scan.accepted) {
          const inserted = await client.query(
            `INSERT INTO public.tron_usdt_deposits
             (transaction_id, event_index, sender_address, receiver_address,
              token_contract, amount_raw, amount_usdt, block_timestamp,
              observation_status, raw_event_json)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OBSERVED_CONFIRMED',$9::jsonb)
             ON CONFLICT (transaction_id, event_index) DO NOTHING
             RETURNING transaction_id`,
            [
              item.txid,
              item.eventIndex,
              item.sender,
              item.recipient,
              USDT_CONTRACT,
              item.raw,
              amountUsdt(item.raw),
              new Date(item.timestamp).toISOString(),
              JSON.stringify(item.event)
            ]
          );

          if (inserted.rowCount === 1) {
            newEvents++;
          } else {
            await client.query(
              `UPDATE public.tron_usdt_deposits
               SET last_seen_at = NOW()
               WHERE transaction_id = $1 AND event_index = $2`,
              [item.txid, item.eventIndex]
            );
          }
        }

        await client.query(
          `INSERT INTO public.tron_usdt_sync_state
             (receiver_address, last_completed_timestamp, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (receiver_address) DO UPDATE
           SET last_completed_timestamp = GREATEST(
                 public.tron_usdt_sync_state.last_completed_timestamp,
                 EXCLUDED.last_completed_timestamp
               ),
               updated_at = NOW()`,
          [receiver, new Date(windowEnd).toISOString()]
        );

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      cursorMs = windowEnd;
      completedWindows++;
    }

    const finalState = await client.query(
      `SELECT last_completed_timestamp
       FROM public.tron_usdt_sync_state
       WHERE receiver_address = $1`,
      [receiver]
    );

    const finalCursorMs = new Date(
      finalState.rows[0].last_completed_timestamp
    ).getTime();

    return res.status(200).json({
      ok: true,
      status: "OBSERVED_CONFIRMED",
      scan_complete: finalCursorMs >= now,
      retry_required: finalCursorMs < now,
      completed_windows: completedWindows,
      pages_read: pagesRead,
      events_seen: eventsSeen,
      new_events: newEvents,
      invalid_events_skipped: invalidEvents,
      cursor_timestamp: finalState.rows[0].last_completed_timestamp,
      auto_approval: false
    });
  } catch (error) {
    if (error?.code === "SYNC_LEASE_LOST") {
      return res.status(409).json({
        error: "Sync lease lost; retry required",
        retry_required: true,
        auto_approval: false
      });
    }

    console.error(
      "TRON sync failed:",
      error?.providerFailure ? "ProviderFailure" : error?.code || error?.name || "Error"
    );
    return res.status(502).json({ error: "Sync failed; check server logs" });
  } finally {
    if (client) {
      try {
        if (leaseToken) {
          await client.query(
            `UPDATE public.tron_usdt_sync_state
             SET lease_token = NULL, lease_until = NULL, updated_at = NOW()
             WHERE receiver_address = $1 AND lease_token = $2::uuid`,
            [receiver, leaseToken]
          );
        }
      } catch {
        // Expiry allows another request to recover if release fails.
      }
      client.release();
    }
    };
  };
}

const handler = createHandler();
export default handler;
