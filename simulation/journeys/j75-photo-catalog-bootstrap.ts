/**
 * J75 — Photo → catalog bootstrap e2e (W15 F5).
 *
 * A merchant photographs a handwritten price list during onboarding. The
 * customHttp extraction adapter (fake http client — no network) returns a
 * realistic ₦ price list (plain prices, a "1,200-1,500" range, a per-dozen
 * line, OCR noise) → draft items are parsed/normalized into
 * tenants.settings.catalogDrafts (72h TTL) → the merchant confirms a SUBSET
 * with edits → real products rows are created → double-confirm is an
 * idempotent no-op → a second image dedupes against the LIVE catalog (the
 * just-created products) and skips the duplicates on confirm. Also covers:
 * disabled provider refusal, within-extraction dedupe, and lazy TTL expiry.
 */
import { eq, inArray } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J75",
  name: "photo → catalog bootstrap",
  feature: "extract → draft → confirm subset+edits → idempotent dedupe",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const cb = await import("../../server/services/catalogBootstrap");
    const createdProductIds: string[] = [];

    // Scripted extraction endpoint (fake http client, assertion on the request).
    const extractionCalls: any[] = [];
    let nextPayload: any = null;
    const fakeHttp = {
      async request(req: any) {
        extractionCalls.push(req);
        return { status: 200, body: nextPayload };
      },
    };

    process.env.CATALOG_EXTRACTION_PROVIDER = "customHttp";
    process.env.CATALOG_EXTRACTION_ENDPOINT = "http://extraction.sim.local/v1/extract";
    process.env.CATALOG_EXTRACTION_API_KEY = "sim-extraction-key";

    try {
      // ── 0. Disabled provider refuses honestly ────────────────────────────
      const disabled = await cb.bootstrapCatalogFromImage(
        { tenantId: TENANT_ID, imageUrl: "https://cdn.sim.local/pricelist.jpg" },
        { env: {} as NodeJS.ProcessEnv, http: fakeHttp },
      );
      assert(disabled.ok === false && disabled.error === "extraction_disabled", "disabled provider refuses");

      // ── 1. Image → parsed draft ──────────────────────────────────────────
      nextPayload = {
        ref: "sim-extract-j75-1",
        items: [
          { name: "Indomie Noodles 70g", price: "₦250" },
          { name: "Peak Milk 400g", priceCents: 185000, currency: "NGN" },
          { name: "Semovita 1kg", price: "₦1,200-1,500" },
          { name: "Farm Fresh Eggs", price: "₦3,600/dozen" },
          { name: "• GARRI 5KG •", price: "N4500" },
          { name: "indomie noodles 70g", price: "₦260" }, // within-extraction dupe
          { name: "???", price: "₦100" }, // unusable name → dropped
        ],
      };
      const boot = await cb.bootstrapCatalogFromImage(
        { tenantId: TENANT_ID, imageUrl: "https://cdn.sim.local/pricelist1.jpg" },
        { http: fakeHttp },
      );
      assert(boot.ok === true, `bootstrap succeeded (${JSON.stringify(boot).slice(0, 200)})`);
      if (boot.ok !== true) return;
      assert(extractionCalls.length === 1, "extraction endpoint called once");
      const sentBody = JSON.parse(extractionCalls[0].body);
      assert(sentBody.imageUrl === "https://cdn.sim.local/pricelist1.jpg", "image URL forwarded");
      assert(sentBody.hints?.currency === "NGN", "NGN currency hint forwarded");
      assert(
        extractionCalls[0].headers?.authorization === "Bearer sim-extraction-key",
        "API key sent as bearer",
      );

      const items = boot.items;
      assert(items.length === 5, `5 clean items (OCR noise + within-extraction dupe dropped; got ${items.length})`);
      const byName = new Map(items.map((i) => [i.name, i]));
      assert(byName.get("Indomie Noodles 70g")?.priceCents === 25000, "₦250 → 25000 cents");
      assert(byName.get("Peak Milk 400g")?.priceCents === 185000, "trusted numeric priceCents wins");
      const semo = byName.get("Semovita 1kg");
      assert(semo?.priceCents === 120000, `range takes the lower bound (got ${semo?.priceCents})`);
      const eggs = byName.get("Farm Fresh Eggs");
      assert(eggs?.priceCents === 360000 && eggs?.unit === "dozen", "per-dozen unit captured");
      assert(byName.has("Garri 5kg"), `OCR noise cleaned + title-cased (got ${items.map((i) => i.name).join(", ")})`);

      // Draft persisted in tenants.settings.catalogDrafts with a 72h TTL.
      const draftRes = await cb.getCatalogDraft({ tenantId: TENANT_ID, draftId: boot.draftId });
      assert(draftRes.ok === true && draftRes.draft.status === "pending", "draft persisted pending");
      const ttlMs = Date.parse(draftRes.draft.expiresAt) - Date.parse(draftRes.draft.createdAt);
      assert(ttlMs === cb.DRAFT_TTL_MS, "72h TTL");
      assert(draftRes.draft.duplicates.length === 0, "no live-catalog duplicates yet");

      // ── 2. Merchant confirms a SUBSET with edits ─────────────────────────
      const confirmIds = [byName.get("Indomie Noodles 70g")!.id, byName.get("Peak Milk 400g")!.id, eggs!.id];
      const confirmed = await cb.confirmCatalogDraft({
        tenantId: TENANT_ID,
        draftId: boot.draftId,
        approveItemIds: confirmIds,
        edits: {
          [eggs!.id]: { priceCents: 380000, unit: "dozen" }, // merchant correction
          [byName.get("Peak Milk 400g")!.id]: { sku: "PEAK-400" },
        },
      });
      assert(confirmed.ok === true, `confirm succeeded (${JSON.stringify(confirmed).slice(0, 200)})`);
      if (confirmed.ok !== true) return;
      assert(confirmed.productIds.length === 3, "exactly the approved subset became products");
      createdProductIds.push(...confirmed.productIds);
      const rows = await world.db
        .select()
        .from(schema.products)
        .where(inArray(schema.products.id, confirmed.productIds));
      assert(rows.length === 3, "3 products rows in the live catalog");
      const eggRow = rows.find((r: any) => r.name === "Farm Fresh Eggs");
      assert(eggRow?.price === "3800.00", `edit applied (got ${eggRow?.price})`);
      assert(eggRow?.description === "Sold per dozen", "unit carried into the description");
      const peakRow = rows.find((r: any) => r.name === "Peak Milk 400g");
      assert(peakRow?.sku === "PEAK-400", "sku edit applied");
      const afterConfirm = await cb.getCatalogDraft({ tenantId: TENANT_ID, draftId: boot.draftId });
      assert(afterConfirm.ok === true && afterConfirm.draft.status === "confirmed", "draft marked confirmed");

      // ── 3. Double-confirm is an idempotent no-op ─────────────────────────
      const again = await cb.confirmCatalogDraft({ tenantId: TENANT_ID, draftId: boot.draftId });
      assert(again.ok === true && again.alreadyConfirmed === true, "second confirm short-circuits");
      if (again.ok) {
        assert(
          JSON.stringify(again.productIds) === JSON.stringify(confirmed.productIds),
          "same product ids returned, no new rows",
        );
      }
      const allJ75 = await world.db
        .select()
        .from(schema.products)
        .where(inArray(schema.products.id, createdProductIds));
      assert(allJ75.length === 3, "still exactly 3 products after the double-confirm");

      // ── 4. Second image dedupes against the LIVE catalog ─────────────────
      nextPayload = {
        ref: "sim-extract-j75-2",
        items: [
          { name: "Indomie Noodles 70g", price: "₦250" }, // now live → duplicate
          { name: "Farm Fresh Eggs", price: "₦3,800/dozen" }, // now live → duplicate
          { name: "Palm Oil 5L", price: "₦9,500" }, // genuinely new
        ],
      };
      const boot2 = await cb.bootstrapCatalogFromImage(
        { tenantId: TENANT_ID, imageBase64: "U0lNLUZBS0UtUE5HLWJ5dGVz", mimeType: "image/jpeg" },
        { http: fakeHttp },
      );
      assert(boot2.ok === true, "second bootstrap succeeded");
      if (boot2.ok !== true) return;
      const draft2 = await cb.getCatalogDraft({ tenantId: TENANT_ID, draftId: boot2.draftId });
      assert(draft2.ok === true && draft2.draft.duplicates.length === 2,
        `both live items flagged as duplicates (got ${draft2.ok ? draft2.draft.duplicates.length : "err"})`);
      const confirmed2 = await cb.confirmCatalogDraft({ tenantId: TENANT_ID, draftId: boot2.draftId });
      assert(confirmed2.ok === true, "second confirm succeeded");
      if (confirmed2.ok !== true) return;
      assert(confirmed2.productIds.length === 1, "only the genuinely-new item creates a product");
      assert((confirmed2.skippedDuplicates ?? []).length === 2, "duplicates skipped on confirm");
      createdProductIds.push(...confirmed2.productIds);
      const [palm] = await world.db
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, confirmed2.productIds[0]))
        .limit(1);
      assert(palm?.name === "Palm Oil 5L" && palm?.price === "9500.00", "new item created from the second image");

      // ── 5. Lazy TTL expiry on a fresh draft (now-injected) ───────────────
      nextPayload = { ref: "sim-extract-j75-3", items: [{ name: "Sugar 50kg", price: "₦65,000" }] };
      const boot3 = await cb.bootstrapCatalogFromImage(
        { tenantId: TENANT_ID, imageUrl: "https://cdn.sim.local/pricelist3.jpg" },
        { http: fakeHttp },
      );
      assert(boot3.ok === true, "third bootstrap succeeded");
      if (boot3.ok === true) {
        const future = () => new Date(Date.now() + 73 * 60 * 60 * 1000);
        const pastTtl = await cb.getCatalogDraft({ tenantId: TENANT_ID, draftId: boot3.draftId }, { now: future });
        assert(pastTtl.ok === true && pastTtl.draft.status === "expired", "draft expires after the 72h window");
        const lateConfirm = await cb.confirmCatalogDraft({ tenantId: TENANT_ID, draftId: boot3.draftId }, { now: future });
        assert(
          lateConfirm.ok === false && /^draft_(expired|not_confirmable:expired)$/.test(lateConfirm.error),
          `expired draft cannot be confirmed (got ${lateConfirm.ok ? "ok" : lateConfirm.error})`,
        );
      }
    } finally {
      // Journey-owned rows: remove the created products so the seed catalog is
      // restored for later journeys; catalogDrafts + env are wiped by
      // resetJourneyState, deleted here too for standalone reruns.
      if (createdProductIds.length) {
        await world.db.delete(schema.products).where(inArray(schema.products.id, createdProductIds)).catch(() => {});
      }
      const [t] = await world.db
        .select({ settings: schema.tenants.settings })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, TENANT_ID))
        .limit(1);
      const s = { ...((t?.settings ?? {}) as Record<string, any>) };
      delete s.catalogDrafts;
      await world.db.update(schema.tenants).set({ settings: s, updatedAt: new Date() }).where(eq(schema.tenants.id, TENANT_ID));
      delete process.env.CATALOG_EXTRACTION_PROVIDER;
      delete process.env.CATALOG_EXTRACTION_ENDPOINT;
      delete process.env.CATALOG_EXTRACTION_API_KEY;
    }
  },
};
