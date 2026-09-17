/**
 * === W41 (Coder B, UC-2) ===
 * J293 — Customer wallet credit: a merchant goodwill grant lands in the
 * wallet, the append-only ledger records it with a running balance, and a
 * retry with the SAME idempotency reference moves NO money twice.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J293",
  name: "wallet credit (goodwill) + append-only ledger + idempotent retry",
  feature: "W41 UC-2 customer_wallets / customer_wallet_entries",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const wallet = await import("../../server/services/customerWallet");
    const phone = world.newPhone("w41a");

    const before = await wallet.walletBalance(TENANT_ID, phone);
    assert(before === 0, `no wallet yet → 0 balance, got ${before}`);

    // Audited merchant goodwill grant (actor + note in ledger metadata).
    const grant = await wallet.merchantGoodwillCredit(TENANT_ID, phone, 25000, "admin:sim", "J293 apology credit");
    assert(grant.ok === true, `goodwill credit ok: ${grant.error}`);
    assert(grant.balanceCents === 25000, `balance 25000, got ${grant.balanceCents}`);
    assert((await wallet.walletBalance(TENANT_ID, phone)) === 25000, "read-side balance agrees");

    // Ledger: exactly one append-only row with the running balance + audit metadata.
    const entries = await world.db.select().from(schema.customerWalletEntries)
      .where(eq(schema.customerWalletEntries.customerPhone, phone));
    assert(entries.length === 1, `one ledger row, got ${entries.length}`);
    assert(entries[0].direction === "credit" && entries[0].amountCents === 25000, "credit row shape");
    assert(entries[0].balanceAfterCents === 25000, "running balance recorded");
    assert(entries[0].reason === "merchant_goodwill", `goodwill reason, got ${entries[0].reason}`);
    assert((entries[0].metadata as any)?.actor === "admin:sim", "audit actor recorded");

    // Idempotent retry: same refId moves NO money twice.
    const refId = entries[0].refId;
    const retry = await wallet.creditWallet(TENANT_ID, phone, 25000, "merchant_goodwill", refId);
    assert(retry.ok === true && retry.duplicate === true, `retry flagged duplicate: ${JSON.stringify(retry)}`);
    assert((await wallet.walletBalance(TENANT_ID, phone)) === 25000, "balance unchanged after retry");
    const entriesAfter = await world.db.select().from(schema.customerWalletEntries)
      .where(eq(schema.customerWalletEntries.customerPhone, phone));
    assert(entriesAfter.length === 1, "ledger still append-only single row after retry");

    // Rejects non-positive / fractional amounts (fail-closed on money ambiguity).
    const bad = await wallet.creditWallet(TENANT_ID, phone, -100, "merchant_goodwill", "goodwill:j293-bad");
    assert(bad.ok === false, "negative credit rejected");
  },
};
