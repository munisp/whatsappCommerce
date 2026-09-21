/**
 * Pure translation between the HTTP contract rust/ledger-bridge speaks and real TigerBeetle
 * semantics. No I/O and no TigerBeetle import, so it can be unit-tested anywhere.
 *
 * WHY THIS EXISTS: the bridge was written against an invented "TigerBeetle REST API". Its
 * transfer flag values (4 = pending, 8 = post, 16 = void) are NOT TigerBeetle's (2 / 4 / 8).
 * Sent unchanged to a real cluster a bridge "commit" (8) would be executed as a VOID, and a
 * bridge "void" (16) as a balancing_debit. The mapping below is the only thing standing
 * between those two vocabularies, so it is small, explicit and covered by tests that also
 * run against a real TigerBeetle.
 */

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export const U128_MAX = (1n << 128n) - 1n;
export const AMOUNT_MAX = U128_MAX;

// TigerBeetle 0.16 TransferFlags. Asserted against the real client's enum at startup
// (server.mjs) and in the integration test, so a client upgrade cannot silently drift.
export const TB = Object.freeze({ PENDING: 2, POST_PENDING: 4, VOID_PENDING: 8 });

// The bridge's own vocabulary (rust/ledger-bridge/src/main.rs TigerBeetleClient).
export const BRIDGE = Object.freeze({ POSTED: 0, PENDING: 4, POST_PENDING: 8, VOID_PENDING: 16 });

/** Same precedence as the bridge's parse_account_id: decimal u128, then 32-hex / UUID. */
export function parseId(raw, label = "id") {
  const s = String(raw ?? "").trim();
  if (!s) throw new HttpError(422, "invalid_id", `${label} is empty`);
  let v = null;
  if (/^\+?\d+$/.test(s)) {
    v = BigInt(s.replace(/^\+/, ""));
  } else {
    const hex = s.replaceAll("-", "");
    if (/^[0-9a-fA-F]{32}$/.test(hex)) v = BigInt(`0x${hex}`);
  }
  if (v === null) throw new HttpError(422, "invalid_id", `${label}: ${JSON.stringify(s)} is not a decimal u128, 32-hex or UUID`);
  if (v === 0n || v >= U128_MAX) throw new HttpError(422, "invalid_id", `${label} must be non-zero and below u128 max`);
  return v;
}

/** JSON numbers only survive as exact integers up to 2^53; anything else is refused, never rounded. */
export function parseAmount(raw, label = "amount") {
  if (raw === undefined || raw === null) return 0n;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  throw new HttpError(422, "invalid_amount", `${label} must be a non-negative integer number of minor units`);
}

function u32(raw, label) {
  const n = Number(raw ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new HttpError(422, "invalid_field", `${label} must be a u32`);
  return n;
}

/**
 * One bridge transfer event → one TigerBeetle Transfer (plain object; BigInt where TB wants u128/u64).
 * `kind` tells the caller whether missing accounts may be auto-created for it.
 */
export function toTbTransfer(t) {
  if (!t || typeof t !== "object") throw new HttpError(422, "invalid_transfer", "transfer must be an object");
  const bridgeFlags = Number(t.flags ?? 0);
  const id = parseId(t.id, "transfer id");
  const out = {
    id,
    debit_account_id: 0n,
    credit_account_id: 0n,
    amount: 0n,
    pending_id: 0n,
    user_data_128: 0n,
    user_data_64: 0n,
    user_data_32: 0,
    timeout: 0,
    ledger: 0,
    code: 0,
    flags: 0,
    timestamp: 0n,
  };

  if (bridgeFlags === BRIDGE.POSTED || bridgeFlags === BRIDGE.PENDING) {
    out.debit_account_id = parseId(t.debit_account_id, "debit_account_id");
    out.credit_account_id = parseId(t.credit_account_id, "credit_account_id");
    out.amount = parseAmount(t.amount);
    if (out.amount === 0n) throw new HttpError(422, "invalid_amount", "amount must be greater than zero");
    out.ledger = u32(t.ledger, "ledger");
    out.code = u32(t.code, "code");
    if (out.code > 0xffff) throw new HttpError(422, "invalid_field", "code must be a u16");
    if (bridgeFlags === BRIDGE.PENDING) {
      out.flags = TB.PENDING;
      out.timeout = u32(t.timeout, "timeout");
    } else if (u32(t.timeout, "timeout") !== 0) {
      throw new HttpError(422, "invalid_field", "timeout is only valid on a pending transfer");
    }
    return { transfer: out, kind: bridgeFlags === BRIDGE.PENDING ? "pending" : "posted" };
  }

  if (bridgeFlags === BRIDGE.POST_PENDING || bridgeFlags === BRIDGE.VOID_PENDING) {
    out.pending_id = parseId(t.pending_id, "pending_id");
    const amount = parseAmount(t.amount);
    if (bridgeFlags === BRIDGE.POST_PENDING) {
      out.flags = TB.POST_PENDING;
      // The bridge's contract says "amount 0 = post the full pending amount". In TigerBeetle
      // 0.16 that is spelled AMOUNT_MAX; a literal 0 would post nothing and release the hold.
      out.amount = amount === 0n ? AMOUNT_MAX : amount;
    } else {
      out.flags = TB.VOID_PENDING;
      out.amount = amount;
    }
    // debit/credit account, ledger and code stay 0 so they are inherited from the pending transfer.
    return { transfer: out, kind: bridgeFlags === BRIDGE.POST_PENDING ? "post" : "void" };
  }

  throw new HttpError(422, "unsupported_flags", `transfer flags ${bridgeFlags} are not part of the bridge contract (0, 4, 8, 16)`);
}

/** Accounts are created plain: the bridge only ever sends flags 0, and its flag vocabulary is not TigerBeetle's. */
export function toTbAccount(a) {
  if (!a || typeof a !== "object") throw new HttpError(422, "invalid_account", "account must be an object");
  if (Number(a.flags ?? 0) !== 0) throw new HttpError(422, "unsupported_flags", "account flags must be 0");
  for (const f of ["debits_pending", "debits_posted", "credits_pending", "credits_posted"]) {
    if (a[f] !== undefined && Number(a[f]) !== 0) throw new HttpError(422, "invalid_balance", `${f} must be 0 on creation`);
  }
  const ledger = u32(a.ledger, "ledger");
  const code = u32(a.code, "code");
  if (ledger === 0) throw new HttpError(422, "invalid_field", "ledger must be non-zero");
  if (code === 0 || code > 0xffff) throw new HttpError(422, "invalid_field", "code must be 1..65535");
  return {
    id: parseId(a.id, "account id"),
    debits_pending: 0n, debits_posted: 0n, credits_pending: 0n, credits_posted: 0n,
    user_data_128: 0n, user_data_64: 0n, user_data_32: 0,
    reserved: 0, ledger, code, flags: 0, timestamp: 0n,
  };
}

const CONFLICT = /^(exceeds_|overflows_|exists_with_different_|pending_transfer_(?!not_found)|id_already_failed|.*_already_closed)/;

/** Map a TigerBeetle result NAME to how the adapter answers over HTTP. */
export function classifyResult(name) {
  if (name === "ok") return { kind: "ok", status: 200 };
  if (name === "exists") return { kind: "exists", status: 200 }; // idempotent retry of an identical event
  if (name === "debit_account_not_found" || name === "credit_account_not_found") return { kind: "missing_account", status: 404 };
  if (/not_found$/.test(name)) return { kind: "not_found", status: 404 };
  if (CONFLICT.test(name)) return { kind: "conflict", status: 409 };
  return { kind: "invalid", status: 422 };
}

/** A balance is only ever reported exactly — never silently rounded through a JS double. */
export function balanceNumber(v, label) {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(500, "balance_out_of_range", `${label} exceeds 2^53-1 minor units`);
  return Number(v);
}
