/**
 * J127 — W27 catalog-ai: merchant voice note → AI listing draft → button
 * confirm → product live in the catalog.
 *
 * A tenant staff member (seeded users row) voice-notes the business number:
 * "Peak Milk 400g … ₦1,850". Whisper is scripted (world.openai.transcripts),
 * the extraction LLM is scripted (world.llm.when) — no live API calls. The
 * merchant gets an interactive draft card, taps ✅ Publish, and the product
 * appears in the tenant catalog with the stated price (integer cents →
 * decimal products.price). A non-staff sender falls through to the buyer
 * voice pipeline untouched.
 */
import { eq } from "drizzle-orm";
import { scriptMedia } from "../metaMock";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

async function seedMerchant(world: World, phone: string, tag: string) {
  const schema = await import("../../drizzle/schema");
  await world.db.insert(schema.users).values({
    openId: `sim-merchant-${tag}`,
    name: "Sim Merchant",
    phone,
    tenantId: TENANT_ID,
    lastSignedIn: new Date(),
  }).onConflictDoNothing();
}

export const journey: Journey = {
  id: "J127",
  name: "merchant voice note → listing",
  feature: "voice → STT → extract → draft → button publish",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const merchant = world.newPhone("j127");
    await world.grantConsent(merchant);
    await seedMerchant(world, merchant, "j127");

    process.env.OPENAI_API_KEY = "sk-sim-j127";
    world.openai.transcripts.push("New product: Peak Milk 400 grams tin, selling for 1850 naira, groceries category");
    world.llm.when("Peak Milk 400 grams", {
      name: "Peak Milk 400g",
      description: "Peak Milk evaporated milk, 400g tin.",
      category: "groceries",
      priceCents: 185000,
    });

    scriptMedia("m-j127-voice", "fake-ogg-j127", "audio/ogg");
    await world.audio(merchant, "m-j127-voice");

    // ── Draft created + interactive card sent to the merchant ────────────
    let draft: any = null;
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.catalogAiDrafts)
        .where(eq(schema.catalogAiDrafts.merchantPhone, merchant)).limit(5);
      draft = rows.find((r: any) => r.status === "pending_confirm") ?? null;
      return !!draft;
    }, 15000, "voice draft created");
    assert(draft.source === "voice", "draft source is voice");
    assert(draft.tenantId === TENANT_ID, "draft is tenant-scoped");
    assert(draft.name === "Peak Milk 400g", `extracted name (got ${draft.name})`);
    assert(draft.category === "groceries", `extracted category (got ${draft.category})`);
    assert(draft.suggestedPriceCents === 185000, `merchant-stated price kept in cents (got ${draft.suggestedPriceCents})`);
    assert(String(draft.transcript).includes("Peak Milk"), "transcript stored on draft");

    const card = world.outbound.lastOfType("interactive", merchant);
    assert(!!card, "interactive draft card sent to merchant");
    const cardText = bodyText(card!);
    assertIncludes(cardText, "Peak Milk 400g", "card shows product name");
    assertIncludes(cardText, "NGN 1850.00", "card shows suggested price");
    assertIncludes(JSON.stringify(card!.body), `catalog_ai:publish:${draft.id}`, "publish button id");
    assertIncludes(JSON.stringify(card!.body), `catalog_ai:reject:${draft.id}`, "reject button id");

    // ── Merchant taps ✅ Publish → product live in catalog ───────────────
    await world.buttonReply(merchant, `catalog_ai:publish:${draft.id}`, "✅ Publish");
    await world.waitFor(async () => {
      const [p] = await world.db.select().from(schema.products)
        .where(eq(schema.products.id, `ai-${draft.id.slice(0, 8)}`)).limit(1).catch(() => []);
      return !!p;
    }, 15000, "product published from voice draft");

    const [product] = await world.db.select().from(schema.products)
      .where(eq(schema.products.id, `ai-${draft.id.slice(0, 8)}`)).limit(1);
    assert(product.name === "Peak Milk 400g", "product name");
    assert(product.price === "1850.00", `integer cents → decimal price (got ${product.price})`);
    assert(product.category === "groceries", "product category");
    assert((product.metadata as any)?.source === "catalog_ai", "product tagged as AI-sourced");

    const confirmText = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(confirmText, "live in your catalog", "publish confirmation reply");

    const [finalDraft] = await world.db.select().from(schema.catalogAiDrafts)
      .where(eq(schema.catalogAiDrafts.id, draft.id)).limit(1);
    assert(finalDraft.status === "published", "draft status published");
    const events = await world.db.select().from(schema.catalogAiDraftEvents)
      .where(eq(schema.catalogAiDraftEvents.draftId, draft.id));
    const kinds = events.map((e: any) => e.event).sort();
    assert(kinds.includes("created") && kinds.includes("published"), `lifecycle events recorded (got ${kinds.join(",")})`);

    delete process.env.OPENAI_API_KEY;
  },
};
