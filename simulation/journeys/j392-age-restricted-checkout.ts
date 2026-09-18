// === W46 privacy-consent (Coder B) ===
/**
 * J392 — TEN-15 age-restricted checkout gate: createChatOrder (the single
 * chat/agent order seam shared by the WhatsApp, Telegram and LLM
 * confirm_order paths) blocks age-restricted carts without an attestation,
 * persists in-turn attestations durably (age_attestations), and covers
 * returning buyers without re-prompting. Unrestricted carts untouched.
 */
import { eq, and } from "drizzle-orm";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

async function seedCart(world: World, tag: string, phone: string, productId: string, name: string) {
  const schema = await import("../../drizzle/schema");
  const sessionId = `cart-${tag}`;
  await world.db.insert(schema.cartSessions).values({
    id: sessionId,
    tenantId: TENANT_ID,
    waPhoneNumber: phone,
    currentStep: "checkout_confirm",
  });
  await world.db.insert(schema.cartItems).values({
    cartSessionId: sessionId,
    productId,
    productName: name,
    quantity: 1,
    unitPrice: "100.00",
    currency: "NGN",
  });
  return sessionId;
}

export const journey: Journey = {
  id: "J392",
  name: "age-restricted checkout attestation gate",
  feature: "TEN-15 age gate on chat/agent order seam",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { createChatOrder } = await import("../../server/routers/nlp");
    const ageGate = await import("../../server/services/ageGate");
    const phone = world.newPhone("j392");
    await world.grantConsent(phone);

    await world.db.insert(schema.products).values({
      id: "p-j392-vodka",
      tenantId: TENANT_ID,
      sku: "SIM-VODKA-392",
      name: "Vodka 75cl",
      price: "100.00",
      currency: "NGN",
      stockQuantity: 10,
      ageRestricted: true,
      minAge: 18,
    }).onConflictDoNothing();

    // 1. No attestation → blocked, structured verdict, NO order created.
    const cart1 = await seedCart(world, "j392-1", phone, "p-j392-vodka", "Vodka 75cl");
    const blocked = await createChatOrder(world.db, {
      tenantId: TENANT_ID,
      waPhoneNumber: phone,
      cartSessionId: cart1,
      fulfillment: "pickup",
      address: null,
      paymentMethod: "cod",
    });
    assert(blocked.created === false, "restricted cart blocked without attestation");
    assert(blocked.ageGate?.requiredAge === 18, `requiredAge=18 (got ${blocked.ageGate?.requiredAge})`);
    assert(blocked.ageGate?.restrictedProductIds?.includes("p-j392-vodka"), "verdict names the restricted product");
    const [noAtt] = await world.db.select().from(schema.ageAttestations)
      .where(and(eq(schema.ageAttestations.tenantId, TENANT_ID), eq(schema.ageAttestations.phone, phone)));
    assert(!noAtt, "no attestation persisted for a blocked checkout");

    // 2. In-turn attestation → persisted as evidence, order proceeds (COD).
    const cart2 = await seedCart(world, "j392-2", phone, "p-j392-vodka", "Vodka 75cl");
    const attested = await createChatOrder(world.db, {
      tenantId: TENANT_ID,
      waPhoneNumber: phone,
      cartSessionId: cart2,
      fulfillment: "pickup",
      address: null,
      paymentMethod: "cod",
      ageAttested: true,
    });
    assert(attested.created === true, "attested restricted checkout creates the order");
    assert(!attested.ageGate, "no gate verdict on an attested checkout");
    const [att] = await world.db.select().from(schema.ageAttestations)
      .where(and(eq(schema.ageAttestations.tenantId, TENANT_ID), eq(schema.ageAttestations.phone, phone)));
    assert(att && att.attestedAge === 18, "durable attestation row persisted (age 18)");

    // 3. Returning buyer: durable attestation covers the next checkout.
    const cart3 = await seedCart(world, "j392-3", phone, "p-j392-vodka", "Vodka 75cl");
    const returning = await createChatOrder(world.db, {
      tenantId: TENANT_ID,
      waPhoneNumber: phone,
      cartSessionId: cart3,
      fulfillment: "pickup",
      address: null,
      paymentMethod: "cod",
    });
    assert(returning.created === true, "durable attestation covers returning buyer");

    // 4. Unrestricted cart never sees the gate.
    const phoneB = world.newPhone("j392b");
    const cart4 = await seedCart(world, "j392-4", phoneB, "p-jollof", "Jollof Rice");
    const plain = await createChatOrder(world.db, {
      tenantId: TENANT_ID,
      waPhoneNumber: phoneB,
      cartSessionId: cart4,
      fulfillment: "pickup",
      address: null,
      paymentMethod: "cod",
    });
    assert(!plain.ageGate, "unrestricted cart bypasses the gate");

    // 5. Pure helpers: prompt copy + affirmation parser.
    assertIncludes(ageGate.buildAgeAttestationPrompt(18, ["Vodka 75cl"]), "18 years or older", "prompt names the age");
    assert(ageGate.AGE_AFFIRM_RE.test("yes 18+"), "affirmation regex matches 'yes 18+'");
    assert(ageGate.AGE_AFFIRM_RE.test("I am 21"), "affirmation regex matches 'I am 21'");
    assert(!ageGate.AGE_AFFIRM_RE.test("maybe later"), "non-affirmation rejected");

    // 6. Wiring contracts: nlp prompt flow + channel parity category.
    const { readFile } = await import("node:fs/promises");
    const nlp = await readFile(new URL("../../server/routers/nlp.ts", import.meta.url), "utf8");
    assertIncludes(nlp, "awaitingAgeAttestation", "nlp prompts + awaits the attestation");
    assertIncludes(nlp, "ageAttested", "nlp passes the in-turn attestation into the seam");
    const { getParityCategory } = await import("../../server/services/channelParity");
    const cat = getParityCategory("age_attestation");
    assert(!!cat && cat.telegram === "full", "age_attestation registered with telegram parity (J246 subset)");
  },
};
