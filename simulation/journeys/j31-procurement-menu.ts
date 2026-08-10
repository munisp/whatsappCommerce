/**
 * J31 — Procurement menu browse: enabling the "procurement" use case puts
 * "Restock / Buy supplies" on the interactive menu; selecting it lists
 * network suppliers (with MOQ + available credit); picking a supplier renders
 * its wholesale catalog with per-item minimum quantities and the MOQ line.
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { catalogItemNumbers, enableProcurementMenu, restoreMenu } from "./helpers";

export const journey: Journey = {
  id: "J31",
  name: "procurement menu browse",
  feature: "waMenu procurement → supplier directory → wholesale catalog",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const before = await enableProcurementMenu(world);

    // ── Menu shows the procurement entry ──────────────────────────────────
    await world.text(phone, "menu");
    const menu = world.outbound.lastOfType("interactive", phone);
    assert(menu, "menu delivered as interactive payload");
    const menuSerialized = JSON.stringify(menu.body?.interactive ?? {});
    assertIncludes(menuSerialized, "Restock / Buy supplies", "menu shows the procurement entry");

    // ── Select the procurement entry via its actual interactive reply id ──
    const iv = menu.body?.interactive;
    let replyId: string | undefined;
    let replyTitle = "Restock / Buy supplies";
    if (iv?.type === "list") {
      const rows = (iv.action?.sections ?? []).flatMap((s: any) => s.rows ?? []);
      const row = rows.find((r: any) => String(r?.title ?? "").includes("Restock"));
      replyId = row?.id;
    } else if (iv?.type === "button") {
      const btn = (iv.action?.buttons ?? []).find((b: any) => String(b?.reply?.title ?? "").includes("Restock"));
      replyId = btn?.reply?.id;
    }
    assert(typeof replyId === "string" && replyId.length > 0, "procurement entry has a reply id");
    await world.listReply(phone, replyId!, replyTitle);

    // ── Procurement entry screen ──────────────────────────────────────────
    const entry = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(entry, "Restock / Buy supplies", "procurement entry screen header");
    assertIncludes(entry, "Browse suppliers", "entry offers supplier browsing");

    // ── Supplier directory ────────────────────────────────────────────────
    await world.text(phone, "1");
    const directory = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(directory, "Choose a supplier", "supplier directory rendered");
    assertIncludes(directory, "Lagos Plastics Manufacturing", "seeded supplier listed");
    assertIncludes(directory, "lead 5d", "supplier lead time shown");
    assertIncludes(directory, "MOQ ₦1,000.00", "supplier MOQ shown");
    // The seeded ₦500,000 credit facility is summarized for the buyer.
    assertIncludes(directory, "credit: ₦500,000.00 avail (net 14d)", "buyer's available credit shown");

    // ── Wholesale catalog (min qty + MOQ respected in rendered text) ──────
    await world.text(phone, "1");
    const catalog = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(catalog, "wholesale catalog", "wholesale catalog rendered");
    assertIncludes(catalog, "lead time 5d", "catalog shows lead time");
    assertIncludes(catalog, "Minimum order: ₦1,000.00", "catalog enforces MOQ line");
    assertIncludes(catalog, "PET Preforms 500ml — ₦40.00", "tier wholesale price used (not ₦45 retail)");
    assertIncludes(catalog, "(min 100)", "wholesale tier min quantity rendered");
    assertIncludes(catalog, "Plastic Crates 20L — ₦2,500.00", "non-tier item at base price");

    // Min-qty guard: adding below the tier minimum is refused.
    const preformsNo = catalogItemNumbers(catalog).get("PET Preforms 500ml");
    assert(preformsNo, "preforms numbered in the catalog");
    await world.text(phone, `add ${preformsNo} 50`);
    const minQtyRefusal = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(minQtyRefusal, "minimum quantity of 100", "add below min qty refused");

    await restoreMenu(world, before);
  },
};
