/**
 * J129 — W27 catalog-ai: draft review — edit via portal service path, reject
 * via WhatsApp (button + text fallback), and guards (published drafts can't be
 * rejected/edited; foreign tenants can't act).
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J129",
  name: "catalog draft edit / reject",
  feature: "edit + reject + text fallback + state guards",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { createDraft, editDraft, rejectDraft, publishDraft, handleCatalogDraftButton } =
      await import("../../server/services/catalogAI");
    const merchant = world.newPhone("j129");
    await world.grantConsent(merchant);
    await world.db.insert(schema.users).values({
      openId: "sim-merchant-j129",
      name: "Sim Merchant 129",
      phone: merchant,
      tenantId: TENANT_ID,
      lastSignedIn: new Date(),
    }).onConflictDoNothing();

    // ── Edit before publish (portal path) ────────────────────────────────
    const d1 = await createDraft(world.db, {
      tenantId: TENANT_ID, source: "voice", merchantPhone: merchant,
      transcript: "rice bag", listing: { name: "Rice Bag", description: "50kg bag", category: "groceries", priceCents: 9000000 },
    });
    const edit = await editDraft(world.db, d1.id, "portal-user", { name: "Royal Stallion Rice 50kg", priceCents: 9500000 });
    assert(edit.ok, "edit succeeds on pending draft");
    let [row] = await world.db.select().from(schema.catalogAiDrafts).where(eq(schema.catalogAiDrafts.id, d1.id)).limit(1);
    assert(row.name === "Royal Stallion Rice 50kg", `edit applied (got ${row.name})`);
    assert(row.suggestedPriceCents === 9500000, "price edit applied (integer cents)");
    assert(row.status === "pending_confirm", "edit keeps draft pending");

    // Publish the edited draft via the portal mutation path.
    const pub = await publishDraft(world.db, d1.id, "portal-user");
    assert(pub.ok, "publish edited draft");
    const [product] = await world.db.select().from(schema.products)
      .where(eq(schema.products.id, pub.productId!)).limit(1);
    assert(product.name === "Royal Stallion Rice 50kg", "edited name published");
    assert(product.price === "95000.00", "edited price published");

    // Guards: published drafts can't be edited or rejected.
    assert((await editDraft(world.db, d1.id, "portal-user", { name: "x" })).ok === false, "edit blocked after publish");
    assert((await rejectDraft(world.db, d1.id, "portal-user")).ok === false, "reject blocked after publish");
    // Idempotent re-publish returns the same product.
    const pub2 = await publishDraft(world.db, d1.id, "portal-user");
    assert(pub2.ok && pub2.productId === pub.productId, "re-publish idempotent");

    // ── Reject via WhatsApp button ───────────────────────────────────────
    const d2 = await createDraft(world.db, {
      tenantId: TENANT_ID, source: "photo", merchantPhone: merchant,
      mediaId: "m-j129", listing: { name: "Mystery Gadget", description: "?", category: "electronics", priceCents: 500000 },
    });
    const btn = await handleCatalogDraftButton({ tenantId: TENANT_ID, phone: merchant, replyId: `catalog_ai:reject:${d2.id}` });
    assertIncludes(btn!.reply, "discarded", "reject button reply");
    [row] = await world.db.select().from(schema.catalogAiDrafts).where(eq(schema.catalogAiDrafts.id, d2.id)).limit(1);
    assert(row.status === "rejected", "draft rejected via button");
    // Rejected drafts can't be published.
    assert((await publishDraft(world.db, d2.id, merchant)).ok === false, "publish blocked after reject");

    // Cross-tenant isolation: same draft id on another tenant channel.
    const foreign = await handleCatalogDraftButton({ tenantId: "some-other-tenant", phone: merchant, replyId: `catalog_ai:publish:${d2.id}` });
    assertIncludes(foreign!.reply, "not found", "cross-tenant guard");

    // ── Text fallback through the real webhook → nlp pipeline ───────────
    const d3 = await createDraft(world.db, {
      tenantId: TENANT_ID, source: "voice", merchantPhone: merchant,
      transcript: "groundnut oil 5l", listing: { name: "Groundnut Oil 5L", description: "5 litre keg", category: "groceries", priceCents: 1250000 },
    });
    await world.text(merchant, `REJECT ${d3.id.slice(0, 8)}`);
    await world.waitFor(async () => {
      const [r] = await world.db.select().from(schema.catalogAiDrafts)
        .where(eq(schema.catalogAiDrafts.id, d3.id)).limit(1);
      return r?.status === "rejected";
    }, 15000, "text REJECT command rejects draft");
    assertIncludes(bodyText(world.outbound.lastOfType("text", merchant)), "discarded", "text reject reply");

    // Events audit covers the lifecycle.
    const events = await world.db.select().from(schema.catalogAiDraftEvents)
      .where(eq(schema.catalogAiDraftEvents.draftId, d1.id));
    const kinds = events.map((e: any) => e.event);
    assert(kinds.includes("created") && kinds.includes("edited") && kinds.includes("published"),
      `d1 events (got ${kinds.join(",")})`);
  },
};
