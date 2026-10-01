// === W52 SHARE ===
/**
 * J533 — recipient redeems the DEAL/REF grammar: the prefilled inbound
 * message "DEAL <PROMO> REF <CODE>" sticks the promo to the session
 * (ctx.promoCode) AND attributes the referral via the W44 rail.
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J533",
  name: "recipient redeems DEAL/REF grammar → promo sticky + referral attributed",
  feature: "W52 share: inbound grammar",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const before = await world.tenantSettings();
    const sharer = world.newPhone("3");
    const recipient = world.newPhone("4");
    let codeId: string | null = null;
    try {
      await world.patchTenantSettings({ promos: [{ code: "DEAL33", type: "percent", value: 15 }] });
      await world.grantConsent(sharer);
      await world.grantConsent(recipient);

      const { getOrCreateReferralCode } = await import("../../server/services/referrals");
      const ref = await getOrCreateReferralCode(TENANT_ID, sharer, world.db);
      codeId = ref.id;

      world.outbound.reset();
      await world.text(recipient, `DEAL DEAL33 REF ${ref.code}`);
      const texts = world.outbound.ofType("text", recipient)
        .map((c) => String((c.body as any)?.text?.body ?? ""));
      const reply = texts.find((t) => t.includes("DEAL33"));
      assert(reply, `localized redemption reply (got ${JSON.stringify(texts)})`);
      // Locale-agnostic substance checks below (ctx.promoCode + referral
      // event) — the reply copy is localized, so no English literal here.

      // Promo awareness: sticky session promo code.
      const [session] = await world.db.select().from(schema.nlpSessions)
        .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, recipient)))
        .limit(1);
      assert((session?.context as any)?.promoCode === "DEAL33",
        `ctx.promoCode sticky (got ${JSON.stringify(session?.context)})`);

      // Referral attributed via the W44 rail.
      const events = await world.db.select().from(schema.referralEvents)
        .where(and(eq(schema.referralEvents.tenantId, TENANT_ID), eq(schema.referralEvents.refereeCustomerId, recipient)));
      assert(events.length === 1 && events[0].status === "attributed",
        `referral event attributed (got ${JSON.stringify(events.map((e: any) => e.status))})`);
      assert(events[0].codeId === codeId, "event linked to the sharer's code");
    } finally {
      await world.patchTenantSettings({ promos: (before as any)?.promos ?? [] });
      if (codeId) {
        await world.db.delete(schema.referralEvents).where(eq(schema.referralEvents.codeId, codeId)).catch(() => {});
        await world.db.delete(schema.referralCodes).where(eq(schema.referralCodes.id, codeId)).catch(() => {});
      }
    }
  },
};
