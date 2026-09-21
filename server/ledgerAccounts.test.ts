/**
 * QA-033: what a ledger account IS, decided in one place.
 *
 * The server derives every ledger account id and stamps the account's KIND into it; the tb-adapter
 * reads the kind when it creates the account and gives accounts that must never go negative
 * TigerBeetle's `debits_must_not_exceed_credits`. The two sides live in different Docker build
 * contexts and carry the same table, so the first thing this pins is that they agree.
 *
 * Before this, ids for loan funding / pay-over-time / fee legs were opaque strings
 * ("credit-facility:…") that the bridge rejects with HTTP 400 — which the callers then swallowed as
 * "already posted" — and no account had any overdraft protection.
 */
import { describe, it, expect } from "vitest";
import {
  LEDGER_ACCOUNT_KINDS, LEDGER_ACCOUNT_MAGIC, LedgerAccountError, isLedgerAccountKind, ledgerAccountId, ledgerAccountIdFromRef,
  type LedgerAccountKind,
} from "./services/ledgerAccounts";
import {
  ACCOUNT_KINDS, ACCOUNT_MAGIC, DEFAULT_ACCOUNT_CODE, TB_ACCOUNT, accountPolicyForId, parseId,
} from "../services/tb-adapter/translate.mjs";

const kinds = Object.keys(LEDGER_ACCOUNT_KINDS) as LedgerAccountKind[];

describe("server and tb-adapter agree on account kinds", () => {
  it("use the same magic byte", () => {
    expect(ACCOUNT_MAGIC).toBe(LEDGER_ACCOUNT_MAGIC);
  });

  it("have exactly the same kinds, tags and overdraft policy — a drift here silently changes which accounts are protected", () => {
    const server = kinds.map((k) => ({ tag: LEDGER_ACCOUNT_KINDS[k].tag, name: k, mustNotOverdraw: LEDGER_ACCOUNT_KINDS[k].mustNotOverdraw }));
    const adapter = Object.entries(ACCOUNT_KINDS).map(([tag, v]) => ({ tag: Number(tag), name: v.name, mustNotOverdraw: v.mustNotOverdraw }));
    expect(adapter.sort((a, b) => a.tag - b.tag)).toEqual(server.sort((a, b) => a.tag - b.tag));
  });

  it("never reuses a tag", () => {
    const tags = kinds.map((k) => LEDGER_ACCOUNT_KINDS[k].tag);
    expect(new Set(tags).size).toBe(tags.length);
    for (const t of tags) expect(t).toBeGreaterThan(0);
  });

  it("gives every kind the policy the adapter will apply when it creates the account", () => {
    for (const k of kinds) {
      const p = accountPolicyForId(parseId(ledgerAccountId(k, "some-id")));
      expect(p.kind).toBe(k);
      expect(p.flags).toBe(LEDGER_ACCOUNT_KINDS[k].mustNotOverdraw ? TB_ACCOUNT.DEBITS_MUST_NOT_EXCEED_CREDITS : 0);
      expect(p.code).toBe(DEFAULT_ACCOUNT_CODE + LEDGER_ACCOUNT_KINDS[k].tag);
    }
  });
});

describe("overdraft policy (a product decision, pinned so changing it is deliberate)", () => {
  it("protects exactly the accounts whose funds exist only once received: escrow, merchant, merchant-wallet", () => {
    expect(kinds.filter((k) => LEDGER_ACCOUNT_KINDS[k].mustNotOverdraw).sort()).toEqual(["escrow", "merchant", "merchant-wallet"]);
  });

  it("leaves the customer account unconstrained: its money arrives from outside, so it is debited before it is ever credited", () => {
    expect(LEDGER_ACCOUNT_KINDS.customer.mustNotOverdraw).toBe(false);
    expect(accountPolicyForId(parseId(ledgerAccountId("customer", "+2348000000000"))).flags).toBe(0);
  });
});

describe("ledgerAccountId", () => {
  it("is stable: these vectors must never change (a different derivation orphans every existing ledger account)", () => {
    expect(ledgerAccountId("escrow", "tenant-1")).toBe("a702ecc6-bdde-5cbd-f3a5-66d2a0667c12");
    expect(ledgerAccountId("customer", "+2348012345678")).toBe("a701da0f-b057-89ab-b598-6c5a874bb9da");
    expect(ledgerAccountId("credit-facility", "fac-1")).toBe("a7050b59-7d87-3110-673f-d2cfea61ff0e");
  });

  it("is a canonical UUID the bridge and the adapter both accept, carrying the magic byte and the kind tag", () => {
    for (const k of kinds) {
      const id = ledgerAccountId(k, "x");
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const n = parseId(id);
      expect(Number(n >> 120n)).toBe(LEDGER_ACCOUNT_MAGIC);
      expect(Number((n >> 112n) & 0xffn)).toBe(LEDGER_ACCOUNT_KINDS[k].tag);
    }
  });

  it("separates kinds and identifiers", () => {
    expect(ledgerAccountId("escrow", "t1")).not.toBe(ledgerAccountId("merchant", "t1"));
    expect(ledgerAccountId("escrow", "t1")).not.toBe(ledgerAccountId("escrow", "t2"));
    expect(ledgerAccountId("escrow", "t1")).toBe(ledgerAccountId("escrow", "t1"));
  });

  it("refuses an empty identifier (it would put every tenant on ONE account) and an unknown kind", () => {
    for (const bad of ["", "   "]) expect(() => ledgerAccountId("escrow", bad)).toThrow(LedgerAccountError);
    expect(() => ledgerAccountId("nonsense" as LedgerAccountKind, "x")).toThrow(LedgerAccountError);
    expect(() => ledgerAccountId("escrow", undefined as unknown as string)).toThrow(LedgerAccountError);
  });

  it("isLedgerAccountKind does not trust prototype keys", () => {
    expect(isLedgerAccountKind("escrow")).toBe(true);
    for (const bad of ["toString", "constructor", "__proto__", "hasOwnProperty", ""]) expect(isLedgerAccountKind(bad)).toBe(false);
  });
});

describe("ledgerAccountIdFromRef — domain refs in outbox payloads", () => {
  it("maps the refs the ledger legs actually use", () => {
    expect(ledgerAccountIdFromRef("credit-facility:fac-1")).toBe(ledgerAccountId("credit-facility", "fac-1"));
    expect(ledgerAccountIdFromRef("merchant-wallet:w9")).toBe(ledgerAccountId("merchant-wallet", "w9"));
    expect(ledgerAccountIdFromRef("vendor-bill:b1")).toBe(ledgerAccountId("vendor-bill", "b1"));
    expect(ledgerAccountIdFromRef("mandate-clearing:tenant-7")).toBe(ledgerAccountId("mandate-clearing", "tenant-7"));
    expect(ledgerAccountIdFromRef("platform-fees:USD")).toBe(ledgerAccountId("platform-fees", "USD"));
  });

  it("only splits on the FIRST colon, so an identifier may contain one", () => {
    expect(ledgerAccountIdFromRef("platform-fees:USD:extra")).toBe(ledgerAccountId("platform-fees", "USD:extra"));
  });

  it("THROWS on anything it cannot map — a leg must never be sent, or dropped, because of a typo", () => {
    for (const bad of ["", "nocolon", ":x", "unknown-kind:x", "escrow:", "escrow:   ", "toString:x"]) {
      expect(() => ledgerAccountIdFromRef(bad), JSON.stringify(bad)).toThrow(LedgerAccountError);
    }
  });
});

describe("accountPolicyForId — ids the server did not derive", () => {
  it("creates untagged ids (e.g. random provisioned accounts) plain, with the default code", () => {
    for (const id of ["11111111-2222-3333-4444-555555555555", "874c15d7a9d343bab5590afaed1f8394", "12345"]) {
      expect(accountPolicyForId(parseId(id))).toEqual({ kind: "untagged", flags: 0, code: DEFAULT_ACCOUNT_CODE });
    }
  });

  it("does not treat the magic byte with an unknown tag as a kind", () => {
    const unknown = (BigInt(LEDGER_ACCOUNT_MAGIC) << 120n) | (0x63n << 112n) | 1n;
    expect(accountPolicyForId(unknown).kind).toBe("untagged");
  });
});
