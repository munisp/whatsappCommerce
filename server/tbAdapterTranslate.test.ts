/**
 * The TigerBeetle HTTP adapter (services/tb-adapter) sits between rust/ledger-bridge — which was
 * written against an invented TigerBeetle REST API — and a real TigerBeetle cluster. These pin
 * the translation layer with no TigerBeetle needed, so they run in CI. The same mapping is
 * exercised against a real server by tbAdapter.integration.test.ts.
 *
 * The rows that matter most are the ones where the two vocabularies COLLIDE: the bridge's
 * "post" flag (8) is TigerBeetle's "void", and the bridge's "pending" flag (4) is TigerBeetle's
 * "post_pending_transfer". Forwarding flags unchanged would turn every commit into a void.
 */
import { describe, it, expect } from "vitest";
import {
  HttpError, AMOUNT_MAX, U128_MAX, TB, BRIDGE, parseId, parseAmount, toTbTransfer, toTbAccount, classifyResult, balanceNumber,
} from "../services/tb-adapter/translate.mjs";

const uuid = "11111111-2222-3333-4444-555555555555";
const uuidDec = BigInt("0x11111111222233334444555555555555");
const expectErr = (fn: () => unknown, status: number, code?: string) => {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as InstanceType<typeof HttpError>).status).toBe(status);
    if (code) expect((e as InstanceType<typeof HttpError>).code).toBe(code);
    return;
  }
  throw new Error("expected HttpError");
};

describe("parseId — same precedence as the bridge's parse_account_id", () => {
  it("accepts decimal, 32-hex and canonical UUID, all to the same u128", () => {
    expect(parseId(uuidDec.toString())).toBe(uuidDec);
    expect(parseId("1111111122223333444455555555555a")).toBe(BigInt("0x1111111122223333444455555555555a")); // has a hex letter, so not decimal
    expect(parseId(uuid)).toBe(uuidDec);
    expect(parseId(uuid.toUpperCase())).toBe(uuidDec);
    expect(parseId(` ${uuid} `)).toBe(uuidDec);
  });
  it("a digits-only 32-char string is DECIMAL first (as in the bridge), not hex", () => {
    expect(parseId("12345678901234567890123456789012")).toBe(12345678901234567890123456789012n);
  });
  it.each(["", "  ", "0", "-5", "1.5", "0xabc", "not-an-id", "n123", "12345678-1234-1234-1234-12345678901g", U128_MAX.toString()])(
    "rejects %j", (bad) => expectErr(() => parseId(bad), 422, "invalid_id"),
  );
  it("rejects the u128 max (reserved by TigerBeetle) and values beyond it", () => {
    expectErr(() => parseId((U128_MAX + 1n).toString()), 422);
  });
});

describe("parseAmount — exact integers only, never rounded", () => {
  it("accepts non-negative safe integers and digit strings", () => {
    expect(parseAmount(5000)).toBe(5000n);
    expect(parseAmount("9007199254740993")).toBe(9007199254740993n);
    expect(parseAmount(undefined)).toBe(0n);
  });
  it.each([-1, 1.5, NaN, Infinity, 2 ** 53, "1.5", "-3", "abc", {}, true])("rejects %j", (bad) => {
    expectErr(() => parseAmount(bad), 422, "invalid_amount");
  });
});

describe("toTbTransfer — the flag vocabularies do not match and must be translated", () => {
  const base = { id: "9", debit_account_id: uuid, credit_account_id: "22222222-3333-4444-5555-666666666666", amount: 5000, ledger: 1, code: 1 };

  it("pins TigerBeetle's real values (asserted against the real client at adapter startup)", () => {
    expect(TB).toEqual({ PENDING: 2, POST_PENDING: 4, VOID_PENDING: 8 });
    expect(BRIDGE).toEqual({ POSTED: 0, PENDING: 4, POST_PENDING: 8, VOID_PENDING: 16 });
  });

  it("bridge 0 (single-phase) → plain posted transfer", () => {
    const { transfer, kind } = toTbTransfer({ ...base, flags: 0, timeout: 0 });
    expect(kind).toBe("posted");
    expect(transfer.flags).toBe(0);
    expect(transfer.amount).toBe(5000n);
    expect(transfer.timeout).toBe(0);
  });

  it("bridge 4 (reserve) → TigerBeetle PENDING (2), keeps the timeout so orphaned holds auto-void", () => {
    const { transfer, kind } = toTbTransfer({ ...base, flags: 4, timeout: 900 });
    expect(kind).toBe("pending");
    expect(transfer.flags).toBe(TB.PENDING);
    expect(transfer.timeout).toBe(900);
    expect(transfer.debit_account_id).toBe(uuidDec);
  });

  it("bridge 8 (commit) → TigerBeetle POST_PENDING (4), NOT void; amount 0 becomes AMOUNT_MAX so the whole hold is posted", () => {
    const { transfer, kind } = toTbTransfer({ id: "10", pending_id: "9", flags: 8, amount: 0 });
    expect(kind).toBe("post");
    expect(transfer.flags).toBe(TB.POST_PENDING);
    expect(transfer.flags).not.toBe(TB.VOID_PENDING);
    expect(transfer.amount).toBe(AMOUNT_MAX);
    expect(transfer.pending_id).toBe(9n);
    // accounts, ledger and code are inherited from the pending transfer
    expect([transfer.debit_account_id, transfer.credit_account_id, transfer.ledger, transfer.code]).toEqual([0n, 0n, 0, 0]);
  });

  it("bridge 8 with an explicit amount posts exactly that amount (partial capture)", () => {
    expect(toTbTransfer({ id: "10", pending_id: "9", flags: 8, amount: 300 }).transfer.amount).toBe(300n);
  });

  it("bridge 16 (void) → TigerBeetle VOID_PENDING (8), NOT balancing_debit (16)", () => {
    const { transfer, kind } = toTbTransfer({ id: "11", pending_id: "9", flags: 16, amount: 0 });
    expect(kind).toBe("void");
    expect(transfer.flags).toBe(TB.VOID_PENDING);
    expect(transfer.flags).not.toBe(16);
    expect(transfer.amount).toBe(0n);
  });

  it.each([1, 2, 3, 5, 12, 32, 64, 256])("refuses bridge flags %d — including every TigerBeetle-native value the bridge does not use", (f) => {
    expectErr(() => toTbTransfer({ ...base, flags: f }), 422, "unsupported_flags");
  });

  it("refuses malformed events instead of guessing", () => {
    expectErr(() => toTbTransfer({ ...base, flags: 4, amount: 0 }), 422, "invalid_amount");   // a reserve of nothing
    expectErr(() => toTbTransfer({ ...base, flags: 0, timeout: 60 }), 422, "invalid_field");   // timeout only on pending
    expectErr(() => toTbTransfer({ ...base, flags: 4, ledger: -1 }), 422, "invalid_field");
    expectErr(() => toTbTransfer({ ...base, flags: 4, code: 70000 }), 422, "invalid_field");
    expectErr(() => toTbTransfer({ id: "10", flags: 8 }), 422, "invalid_id");                  // commit without pending_id
    expectErr(() => toTbTransfer(null), 422);
    expectErr(() => toTbTransfer({ ...base, id: "0", flags: 4 }), 422, "invalid_id");
  });
});

describe("toTbAccount", () => {
  it("creates plain accounts with zero balances", () => {
    const a = toTbAccount({ id: uuid, ledger: 1, code: 1000, flags: 0, debits_pending: 0, credits_posted: 0 });
    expect(a.flags).toBe(0);
    expect(a.id).toBe(uuidDec);
  });
  it("refuses non-zero flags (the bridge's flag vocabulary is not TigerBeetle's) and opening balances", () => {
    expectErr(() => toTbAccount({ id: uuid, ledger: 1, code: 1, flags: 2 }), 422, "unsupported_flags");
    expectErr(() => toTbAccount({ id: uuid, ledger: 1, code: 1, credits_posted: 100 }), 422, "invalid_balance");
    expectErr(() => toTbAccount({ id: uuid, ledger: 0, code: 1 }), 422);
    expectErr(() => toTbAccount({ id: uuid, ledger: 1, code: 0 }), 422);
  });
});

describe("classifyResult — how TigerBeetle result names become HTTP answers", () => {
  it.each([
    ["ok", "ok", 200],
    ["exists", "exists", 200], // a retried, identical event is success, not an error
    ["debit_account_not_found", "missing_account", 404],
    ["credit_account_not_found", "missing_account", 404],
    ["pending_transfer_not_found", "not_found", 404],
    ["pending_transfer_already_posted", "conflict", 409],
    ["pending_transfer_already_voided", "conflict", 409],
    ["pending_transfer_expired", "conflict", 409],
    ["exceeds_credits", "conflict", 409],
    ["exceeds_debits", "conflict", 409],
    ["exists_with_different_amount", "conflict", 409],
    ["id_already_failed", "conflict", 409],
    ["accounts_must_have_the_same_ledger", "invalid", 422],
    ["ledger_must_not_be_zero", "invalid", 422],
  ])("%s → %s (%d)", (name, kind, status) => {
    expect(classifyResult(name as string)).toEqual({ kind, status });
  });
  it("an unrecognised result is never treated as success", () => {
    expect(classifyResult("some_future_result").kind).toBe("invalid");
    expect(classifyResult("").status).toBeGreaterThanOrEqual(400);
  });
});

describe("balanceNumber", () => {
  it("returns exact numbers and refuses to silently round anything past 2^53-1", () => {
    expect(balanceNumber(123456n, "x")).toBe(123456);
    expect(balanceNumber(BigInt(Number.MAX_SAFE_INTEGER), "x")).toBe(Number.MAX_SAFE_INTEGER);
    expectErr(() => balanceNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "x"), 500, "balance_out_of_range");
  });
});
