/**
 * Ledger account ids and account-kind policy — the single place the server decides what a ledger
 * account IS.
 *
 * Every id sent to the ledger-bridge is a deterministic UUID derived from (kind, identifier), so the
 * same customer/tenant/facility always maps to the same TigerBeetle account. The kind is stamped into
 * the id's first two bytes:
 *
 *     byte 0  LEDGER_ACCOUNT_MAGIC (0xa7)   "this id carries a kind"
 *     byte 1  the kind's tag
 *
 * services/tb-adapter reads those bytes when it creates the account on first use and applies the
 * kind's policy: accounts that must never be overdrawn get TigerBeetle's
 * `debits_must_not_exceed_credits`, so the LEDGER itself refuses an overdraft rather than trusting
 * every caller to check first. There is no separate provisioning call to forget.
 *
 * services/tb-adapter/translate.mjs carries the same table (its Docker context cannot import from
 * here); ledgerAccounts.test.ts fails if the two ever disagree.
 *
 * Why these policies:
 *  - customer: money arrives from OUTSIDE the platform (a card charge), so this account is
 *    legitimately debited before it has ever been credited. Unconstrained.
 *  - escrow / merchant / merchant-wallet: funds that exist only once credited. A settlement,
 *    refund or withdrawal beyond what was received is a bug or fraud. Constrained.
 *  - credit-facility, vendor-bill, mandate-clearing, platform-fees: system/clearing accounts whose
 *    balance is a running position, not a spendable amount. Unconstrained.
 */
import { createHash } from "node:crypto";

export const LEDGER_ACCOUNT_MAGIC = 0xa7;

export const LEDGER_ACCOUNT_KINDS = {
  customer: { tag: 0x01, mustNotOverdraw: false },
  escrow: { tag: 0x02, mustNotOverdraw: true },
  merchant: { tag: 0x03, mustNotOverdraw: true },
  "merchant-wallet": { tag: 0x04, mustNotOverdraw: true },
  "credit-facility": { tag: 0x05, mustNotOverdraw: false },
  "vendor-bill": { tag: 0x06, mustNotOverdraw: false },
  "mandate-clearing": { tag: 0x07, mustNotOverdraw: false },
  "platform-fees": { tag: 0x08, mustNotOverdraw: false },
} as const;

export type LedgerAccountKind = keyof typeof LEDGER_ACCOUNT_KINDS;

export class LedgerAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerAccountError";
  }
}

export function isLedgerAccountKind(v: string): v is LedgerAccountKind {
  return Object.prototype.hasOwnProperty.call(LEDGER_ACCOUNT_KINDS, v);
}

/** Deterministic canonical-UUID account id for (kind, identifier). */
export function ledgerAccountId(kind: LedgerAccountKind, identifier: string): string {
  if (!isLedgerAccountKind(kind)) throw new LedgerAccountError(`unknown ledger account kind: ${String(kind)}`);
  // An empty identifier would collapse every tenant/customer onto ONE account.
  if (typeof identifier !== "string" || identifier.trim() === "") {
    throw new LedgerAccountError(`ledger account identifier for kind "${kind}" must be non-empty`);
  }
  const digest = createHash("sha256").update(`wacommerce:ledger:${kind}:${identifier}`).digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[0] = LEDGER_ACCOUNT_MAGIC;
  b[1] = LEDGER_ACCOUNT_KINDS[kind].tag;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Domain-level account references look like `credit-facility:<id>` or `platform-fees:USD` — they are
 * stored in outbox payloads and read by humans. This turns one into the ledger's UUID id. An unknown
 * kind THROWS: a ledger leg must never be sent, or silently dropped, because of a typo.
 */
export function ledgerAccountIdFromRef(ref: string): string {
  const i = ref.indexOf(":");
  if (i <= 0) throw new LedgerAccountError(`not a ledger account reference (want "<kind>:<id>"): ${JSON.stringify(ref)}`);
  const kind = ref.slice(0, i);
  if (!isLedgerAccountKind(kind)) throw new LedgerAccountError(`unknown ledger account kind "${kind}" in ${JSON.stringify(ref)}`);
  return ledgerAccountId(kind, ref.slice(i + 1));
}
