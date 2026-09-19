// === W47 buyer (Coder B) ===
/**
 * J437 — ONB-B-1 / ONB-B-11: the age gate COMPARES the captured digits
 * against requiredAge. A truthful minor ("I am 16") FAILS: the attestedAge
 * recorded is the ACTUAL stated digits, the verdict is underage, and the
 * restricted items are removed (no re-prompt loop). The ratchet still never
 * lowers a higher stored attestation.
 */
import { and, eq } from "drizzle-orm";
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
  id: "J437",
  name: "ONB-B-1 age gate compares stated digits (truthful minor fails)",
  feature: "W47 buyer age attestation digits",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { createChatOrder } = await import("../../server/routers/nlp");
    const ageGate = await import("../../server/services/ageGate");
    const phone = world.newPhone("j437");

    await world.db.insert(schema.products).values({
      id: "p-j437-gin",
      tenantId: TENANT_ID,
      sku: "SIM-GIN-437",
      name: "Gin 70cl",
      price: "100.00",
      currency: "NGN",
      stockQuantity: 10,
      ageRestricted: true,
      minAge: 18,
    }).onConflictDoNothing();

    // 1. Parser: digits captured; explicit denial; ambiguity.
    const p16 = ageGate.parseAgeAttestationReply("I am 16");
    assert(p16?.affirmed === true && p16.statedAge === 16, "parser captures stated age 16");
    const p21 = ageGate.parseAgeAttestationReply("yes 21+");
    assert(p21?.affirmed === true && p21.statedAge === 21, "parser captures 'yes 21+'");
    assert(ageGate.parseAgeAttestationReply("no")?.affirmed === false, "explicit denial parsed");
    assert(ageGate.parseAgeAttestationReply("maybe later") === null, "ambiguous reply → null (no loop)");

    // 2. Truthful minor at checkout: FAILS, records the ACTUAL digits.
    const cart1 = await seedCart(world, "j437-1", phone, "p-j437-gin", "Gin 70cl");
    const minor = await createChatOrder(world.db, {
      tenantId: TENANT_ID,
      waPhoneNumber: phone,
      cartSessionId: cart1,
      fulfillment: "pickup",
      address: null,
      paymentMethod: "cod",
      ageAttested: true,
      ageAttestedAge: 16,
    });
    assert(minor.created === false, "minor checkout blocked");
    assert(minor.ageGate?.underage === true, "verdict flags underage");
    assert(minor.ageGate?.statedAge === 16, "verdict carries stated age");
    const [att16] = await world.db.select().from(schema.ageAttestations)
      .where(and(eq(schema.ageAttestations.tenantId, TENANT_ID), eq(schema.ageAttestations.phone, phone)));
    assert(att16?.attestedAge === 16, `attestedAge records ACTUAL digits 16 (got ${att16?.attestedAge})`);

    // 3. The 16-attestation does NOT unlock a later checkout (gate stays closed).
    const cart2 = await seedCart(world, "j437-2", phone, "p-j437-gin", "Gin 70cl");
    const stillBlocked = await createChatOrder(world.db, {
      tenantId: TENANT_ID,
      waPhoneNumber: phone,
      cartSessionId: cart2,
      fulfillment: "pickup",
      address: null,
      paymentMethod: "cod",
    });
    assert(stillBlocked.created === false && stillBlocked.ageGate?.needsAttestation !== false, "16 attestation never satisfies an 18+ gate");

    // 4. Stated 18 passes and records the stated age.
    const cart3 = await seedCart(world, "j437-3", phone, "p-j437-gin", "Gin 70cl");
    const adult = await createChatOrder(world.db, {
      tenantId: TENANT_ID,
      waPhoneNumber: phone,
      cartSessionId: cart3,
      fulfillment: "pickup",
      address: null,
      paymentMethod: "cod",
      ageAttested: true,
      ageAttestedAge: 18,
    });
    assert(adult.created === true, "18+ attestation creates the order");
    const [att18] = await world.db.select().from(schema.ageAttestations)
      .where(and(eq(schema.ageAttestations.tenantId, TENANT_ID), eq(schema.ageAttestations.phone, phone)));
    assert(att18?.attestedAge === 18, "ratchet raised 16 → 18");

    // 5. Ratchet never lowers: a later "I am 16" cannot drop the stored 18.
    const stored = await ageGate.recordAgeAttestation(world.db, {
      tenantId: TENANT_ID, phone, attestedAge: 16, channel: "whatsapp", source: "chat_reply",
    });
    assert(stored === 18, "ratchet preserved (never lowers)");

    // 6. Underage copy names the removal path; wiring into nlp confirm flow.
    assertIncludes(ageGate.buildAgeGateUnderageReply(18, 16, ["Gin 70cl"]), "removed the restricted items", "underage reply removes items");
    assertIncludes(ageGate.buildAgeGateDenialReply(["Gin 70cl"]), "removed the age-restricted items", "denial reply removes items");
    const { readFile } = await import("node:fs/promises");
    const nlp = await readFile(new URL("../../server/routers/nlp.ts", import.meta.url), "utf8");
    assertIncludes(nlp, "parseAgeAttestationReply", "nlp uses the digits-comparing parser");
    assertIncludes(nlp, "buildAgeGateUnderageReply", "nlp renders the underage block");
    assertIncludes(nlp, "buildAgeGateDenialReply", "nlp renders the denial path (ONB-B-11)");
  },
};
