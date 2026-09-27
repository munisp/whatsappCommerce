// === W52 SHARE ===
/**
 * J534 — self-share rejected: a sender who taps through their OWN shared
 * link ("DEAL <PROMO> REF <own code>") gets the localized self-referral
 * rejection, no referral event is created, and the promo does NOT stick
 * (the guard fires before the promo is locked).
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J534",
  name: "self-share via DEAL/REF grammar rejected",
  feature: "W52 share: self-referral guard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const before = await world.tenantSettings();
    const phone = world.newPhone("5");
    let codeId: string | null = null;
    try {
      await world.patchTenantSettings({ promos: [{ code: "DEAL34", type: "percent", value: 10 }] });
      await world.grantConsent(phone);
      const { getOrCreateReferralCode } = await import("../../server/services/referrals");
      const ref = await getOrCreateReferralCode(TENANT_ID, phone, world.db);
      codeId = ref.id;

      world.outbound.reset();
      await world.text(phone, `DEAL DEAL34 REF ${ref.code}`);
      const texts = world.outbound.ofType("text", phone)
        .map((c) => String((c.body as any)?.text?.body ?? ""));
      const reply = texts.find((t) => /own referral code/i.test(t));
      assert(reply, `self-referral rejection (got ${JSON.stringify(texts)})`);

      const events = await world.db.select().from(schema.referralEvents)
        .where(and(eq(schema.referralEvents.tenantId, TENANT_ID), eq(schema.referralEvents.refereeCustomerId, phone)));
      assert(events.length === 0, "no referral event for a self-share");

      // Promo did not stick to the session (self-referral guard fired first).
      const [session] = await world.db.select().from(schema.nlpSessions)
        .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone)))
        .limit(1);
      assert((session?.context as any)?.promoCode == null,
        `promo not sticky on self-share (got ${JSON.stringify(session?.context)})`);
    } finally {
      await world.patchTenantSettings({ promos: (before as any)?.promos ?? [] });
      if (codeId) {
        await world.db.delete(schema.referralCodes).where(eq(schema.referralCodes.id, codeId)).catch(() => {});
      }
    }
  },
};
