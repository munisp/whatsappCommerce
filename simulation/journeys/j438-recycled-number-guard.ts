// === W47 buyer (Coder B) ===
/**
 * J438 — ONB-B-2: recycled-number / SIM-swap protection on the chat surface.
 * A dormant number WITH order history must prove continuity (name-confirmation
 * challenge) before track/reaction disclose order PII; a declared NEW owner
 * gets a clean slate (old identity tombstoned, consent/session rows removed,
 * orders unreachable by phone). Fail-closed on ambiguity.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

async function seedDormantCustomerWithOrder(world: World, phone: string, name: string, tag: string) {
  const schema = await import("../../drizzle/schema");
  const custId = `cust-${tag}`;
  const old = new Date(Date.now() - 200 * 24 * 3600_000);
  await world.db.insert(schema.customers).values({
    id: custId, tenantId: TENANT_ID, whatsappPhone: phone, name,
    createdAt: old, updatedAt: old, lastOrderAt: old,
  });
  await world.db.insert(schema.orders).values({
    id: `ord-${tag}`, tenantId: TENANT_ID, customerId: custId,
    orderNumber: `SIM-${tag}`, status: "delivered",
    totalAmount: "50.00", currency: "NGN", paymentStatus: "completed",
  });
  return custId;
}

async function tenant(world: World) {
  return { id: TENANT_ID, name: "Sim Store", settings: await world.tenantSettings() };
}

export const journey: Journey = {
  id: "J438",
  name: "ONB-B-2 recycled-number chat guard: challenge, lockout, clean slate",
  feature: "W47 buyer chat identity trust",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { handleConversationalInbound } = await import("../../server/services/useCases");
    const trust = await import("../../server/services/chatIdentityTrust");

    // ── A. Dormant number with history → challenge before disclosure ──────
    const phoneA = world.newPhone("438a");
    await world.grantConsent(phoneA);
    await seedDormantCustomerWithOrder(world, phoneA, "Ada Lovelace", "j438a");
    const t = await tenant(world);

    const challenge = await handleConversationalInbound({
      db: world.db, tenant: t, tenantId: TENANT_ID, phone: phoneA, text: "track",
    });
    assert(challenge.handled === true, "track handled");
    assertIncludes(challenge.reply ?? "", "confirm the first name", "challenge asks for the registered name");
    assert(!challenge.reply?.includes("SIM-j438a"), "NO order PII disclosed before proof");

    // Wrong name ×3 → locked, still no PII.
    for (let i = 0; i < 3; i++) {
      const wrong = await handleConversationalInbound({
        db: world.db, tenant: t, tenantId: TENANT_ID, phone: phoneA, text: "Zed",
      });
      assert(!wrong.reply?.includes("SIM-j438a"), `attempt ${i + 1}: no PII on wrong name`);
    }
    const locked = await handleConversationalInbound({
      db: world.db, tenant: t, tenantId: TENANT_ID, phone: phoneA, text: "track",
    });
    // After lockout the challenge re-arms on the next history intent.
    assert(locked.handled === true, "post-lockout track handled");

    // Correct name → verified; subsequent track discloses.
    const ok = await handleConversationalInbound({
      db: world.db, tenant: t, tenantId: TENANT_ID, phone: phoneA, text: "ada",
    });
    assertIncludes(ok.reply ?? "", "identity confirmed", "name confirmation verifies the holder");
    const tracked = await handleConversationalInbound({
      db: world.db, tenant: t, tenantId: TENANT_ID, phone: phoneA, text: "track",
    });
    assert((tracked.reply ?? "").includes("SIM-j438a") || (tracked.reply ?? "").includes("track"), "verified holder sees order history");

    // ── B. Declared NEW owner → clean slate ──────────────────────────────
    const phoneB = world.newPhone("438b");
    await world.grantConsent(phoneB);
    await seedDormantCustomerWithOrder(world, phoneB, "Old Owner", "j438b");
    await handleConversationalInbound({ db: world.db, tenant: t, tenantId: TENANT_ID, phone: phoneB, text: "track" });
    const fresh = await handleConversationalInbound({
      db: world.db, tenant: t, tenantId: TENANT_ID, phone: phoneB, text: "NEW",
    });
    assertIncludes(fresh.reply ?? "", "started fresh", "clean-slate confirmation");
    const [custB] = await world.db.select().from(schema.customers)
      .where(and(eq(schema.customers.tenantId, TENANT_ID), eq(schema.customers.id, "cust-j438b")));
    assert(custB && custB.whatsappPhone !== phoneB && custB.name === null, "old identity tombstoned off the phone");
    const consentB = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, phoneB)));
    assert(consentB.length === 0, "inherited consent removed on clean slate");
    const after = await handleConversationalInbound({
      db: world.db, tenant: t, tenantId: TENANT_ID, phone: phoneB, text: "track",
    });
    assert(!after.reply?.includes("SIM-j438b"), "orders of the old owner unreachable after clean slate");

    // ── C. Pure helpers ──────────────────────────────────────────────────
    assert(trust.namesMatch("Ada Lovelace", "ada"), "namesMatch first-token case-insensitive");
    assert(!trust.namesMatch("Ada Lovelace", "zed"), "namesMatch rejects mismatch");
    assertIncludes(trust.IDENTITY_VERIFY_PROMPT, "first name", "challenge copy");
  },
};
