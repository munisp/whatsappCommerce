/**
 * J608 — BYO own-number chat onboarding (W49 partial-onboarding).
 *
 * A merchant whose OWN WhatsApp number is connected can finish onboarding by
 * chatting on that number instead of the shared global onboarding line. The
 * routing is gated by a POSITIVE marker (settings.onboarding.chatOnboarding),
 * so the existing active-but-not-live tenants' customer bots are NEVER
 * captured, and the flag is masked off once the tenant goes live.
 *
 * Proves:
 *  1. masking      — getOnboardingState drops the flag for a 'live' tenant.
 *  2. positive     — a DRAFT tenant WITH the marker: inbound to its own number
 *                    routes to the onboarding copilot, BOUND to that tenant,
 *                    replying via the tenant's OWN creds, and bypassing the
 *                    W47 "store not open" order-intake gate.
 *  3. neg. control — a DRAFT tenant WITHOUT the marker: the same inbound hits
 *                    the normal intake gate (store-not-open), never the copilot.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import * as payloads from "../payloads";
import type { Journey } from "../runner";
import { onboardingSessionByPhone } from "./helpers";

const BYO_PN = "pn_sim_byo_001";
const PLAIN_PN = "pn_sim_byo_plain_001";

export const journey: Journey = {
  id: "J608",
  name: "BYO own-number chat onboarding",
  feature:
    "W49: a tenant's own number in chat-onboarding mode routes to the copilot (marker-gated), not the store bot",
  async run(world: World) {
    const { createTenant, getOnboardingState, setChatOnboardingEnabled, updateTenantSettings } =
      await import("../../server/services/onboarding");
    const schema = await import("../../drizzle/schema");

    // ── 1. Masking: a live tenant's flag is dropped; a draft tenant keeps it ─
    assert(
      getOnboardingState({ onboarding: { status: "live", chatOnboarding: true } }).chatOnboarding === false,
      "chatOnboarding is masked OFF for a live tenant (its number serves customers)",
    );
    assert(
      getOnboardingState({ onboarding: { status: "draft", chatOnboarding: true } }).chatOnboarding === true,
      "chatOnboarding is true for a draft tenant carrying the marker",
    );

    // ── Seed a DRAFT tenant with its OWN number + creds + the opt-in marker ──
    // decryptSecret passes a plaintext token through unchanged (same as the
    // default sim tenant's WA_ACCESS_TOKEN), so resolveTenantWaCredentials
    // resolves the tenant's own creds for the copilot's replies.
    const merchant = world.newPhone("byo");
    const { tenantId } = await createTenant({ name: "BYO Fabrics", businessType: "retail" });
    await world.db
      .update(schema.tenants)
      .set({ whatsappPhoneNumberId: BYO_PN })
      .where(eq(schema.tenants.id, tenantId));
    await updateTenantSettings(tenantId, (s) => {
      s.whatsapp = { ...(s.whatsapp ?? {}), accessToken: "sim-wa-access-token" };
    });
    await setChatOnboardingEnabled(tenantId, true);

    // ── 2. Positive: inbound to the tenant's OWN number → onboarding copilot ─
    await world.inbound(payloads.inbound.text(BYO_PN, merchant, "hello", { profileName: "Byo Owner" }));
    await world.settle();

    const session = await onboardingSessionByPhone(merchant);
    assert(session, "BYO inbound created an onboarding copilot session");
    assert(session.channel === "whatsapp", `session on the whatsapp channel (got ${session.channel})`);
    assert(
      session.tenantId === tenantId,
      `session BOUND to the existing draft tenant, not a fresh one (got ${session.tenantId})`,
    );

    // The reply went to the merchant, sent FROM the tenant's own number — i.e.
    // through the tenant's own creds, not the global onboarding number.
    const reply = world.outbound.lastTo(merchant);
    assert(reply, "the copilot replied to the merchant");
    assert(
      new URL(reply.url).pathname.includes(BYO_PN),
      `reply sent via the tenant's OWN number (got ${new URL(reply.url).pathname})`,
    );
    // The W47 "store not open" order-intake gate was BYPASSED, not triggered.
    assert(
      world.outbound.findByBody("isn't open for orders yet", merchant).length === 0,
      "the store-not-open intake gate did NOT fire for a BYO onboarding tenant",
    );

    // ── 3. Negative control: a DRAFT tenant WITHOUT the marker ───────────────
    const merchant2 = world.newPhone("plain");
    const { tenantId: plainId } = await createTenant({ name: "Plain Draft Store", businessType: "retail" });
    await world.db
      .update(schema.tenants)
      .set({ whatsappPhoneNumberId: PLAIN_PN })
      .where(eq(schema.tenants.id, plainId));
    await updateTenantSettings(plainId, (s) => {
      s.whatsapp = { ...(s.whatsapp ?? {}), accessToken: "sim-wa-access-token" };
    });
    // NO setChatOnboardingEnabled — the marker is absent.

    await world.inbound(payloads.inbound.text(PLAIN_PN, merchant2, "hello"));
    await world.settle();

    assert(
      (await onboardingSessionByPhone(merchant2)) === null,
      "a draft tenant WITHOUT the marker did NOT route to the onboarding copilot",
    );
    assert(
      world.outbound.findByBody("isn't open for orders yet", merchant2).length > 0,
      "a draft tenant without the marker hits the normal store-not-open intake gate",
    );
  },
};
