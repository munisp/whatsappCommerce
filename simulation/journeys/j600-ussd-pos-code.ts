// === W59 banking-pos ===
/**
 * J600 — USSD "pay by pos" short-code flow: the merchant (admin phone)
 * creates a session via USSD and reads back the 6-digit code; the payer
 * dials "pay by pos <code6>", their customer wallet is debited claim-first
 * and the merchant settles. Insufficient payer balance fails closed.
 */
import { eq } from "drizzle-orm";
import { assert, type World, assertIncludes } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J600",
  name: "USSD POS short-code: merchant create + payer settle",
  feature: "W59 banking-pos: handleUssdRequest pay by pos",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { handleUssdRequest } = await import("../../server/services/useCases");
    const { tenantId } = await seedUcTenant(world, "600", 6001);
    const admin = world.newPhone("600");
    await world.db.update(schema.tenants).set({
      settings: { ussd: { serviceCode: "*600#" }, adminPhone: admin } as any,
    }).where(eq(schema.tenants.id, tenantId));

    // Merchant creates a ₦300 session.
    const create = await handleUssdRequest({ sessionId: "j600-a", serviceCode: "*600#", phoneNumber: admin, text: "pay by pos 300" });
    assertIncludes(create, "POS session ready", "merchant create reply");
    const code = create.match(/\*(\d{6})\*/)![1];

    // Payer with a funded wallet settles via the code.
    const payer = world.newPhone("600p");
    const { creditWallet } = await import("../../server/services/customerWallet");
    await creditWallet(tenantId, payer, 100_000, "topup", "J600-TOPUP");
    const pay = await handleUssdRequest({ sessionId: "j600-b", serviceCode: "*600#", phoneNumber: payer, text: `pay by pos ${code}` });
    assertIncludes(pay, "Paid", "payer paid via USSD code");
    const [wallet] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, tenantId));
    assert(parseFloat(wallet.availableBalance) === 300, "merchant settled");
    const { customerBalanceCents } = await import("../../server/services/agentBanking");
    assert(await customerBalanceCents(world.db, tenantId, payer) === 70_000, "payer debited exactly 300.00");

    // Unknown code → honest not-found; broke payer → insufficient.
    const miss = await handleUssdRequest({ sessionId: "j600-c", serviceCode: "*600#", phoneNumber: payer, text: "pay by pos 999999" });
    assert(/No pending POS payment/.test(miss), "unknown code not found");
    const create2 = await handleUssdRequest({ sessionId: "j600-d", serviceCode: "*600#", phoneNumber: admin, text: "pay by pos 9999" });
    const code2 = create2.match(/\*(\d{6})\*/)![1];
    const broke = await handleUssdRequest({ sessionId: "j600-e", serviceCode: "*600#", phoneNumber: payer, text: `pay by pos ${code2}` });
    assert(/Insufficient/.test(broke), "insufficient payer balance fails closed");
  },
};
