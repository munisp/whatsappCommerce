// === W59 banking-pos ===
/**
 * J594 — onboarding bank-link step: verified add via bankLinkStep is
 * IDEMPOTENT (onboarding retries never duplicate the row) and fail-closed.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J594",
  name: "onboarding bank step idempotent + fail-closed",
  feature: "W59 banking-pos: payoutAccounts.bankLinkStep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { tenantId, caller } = await seedUcTenant(world, "594", 5941);

    let rejected = false;
    try {
      await caller.payoutAccounts.bankLinkStep({ tenantId, bankCode: "044", accountNumber: "0000000000", provider: "paystack" });
    } catch { rejected = true; }
    assert(rejected, "unverifiable account rejected at onboarding");

    const first = await caller.payoutAccounts.bankLinkStep({ tenantId, bankCode: "044", accountNumber: "0123456789", provider: "paystack" });
    assert(first.step === "bank" && !first.duplicate, "first link succeeds");
    const retry = await caller.payoutAccounts.bankLinkStep({ tenantId, bankCode: "044", accountNumber: "0123456789", provider: "paystack" });
    assert(retry.duplicate === true, "onboarding retry is idempotent");
    const rows = await world.db.select().from(schema.merchantPayoutAccounts).where(eq(schema.merchantPayoutAccounts.tenantId, tenantId));
    assert(rows.length === 1 && rows[0].isPrimary, "exactly one primary row after retries");
  },
};
