/**
 * J619 — picking a numbered item adds THAT item, even when another product has (almost) the same name.
 *
 * Found live 2026-11-10 (Freaks fashion hub): the shop had "Hand painted jean" (0 in stock) and "Hand painted jean "
 * (trailing space, 5 in stock). The menu listed both; replying "2" turned the pick into its NAME, the name matcher
 * trimmed the buyer's text but not the catalog's, so it matched #1 exactly and the buyer was told "out of stock" for
 * an item that wasn't. Numbered picks now carry the product id, and names are compared whitespace-normalized on
 * both sides (so typing the shared name asks which one instead of silently picking one).
 *
 * Runs with the LLM forced down, which is how the live chat was answering (the deterministic menu path).
 */
import { and, eq, inArray } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { lastReply, replyCount } from "./helpers";

const TWIN_OOS = "p-twin-oos";
const TWIN_OK = "p-twin-ok";

export const journey: Journey = {
  id: "J619",
  name: "numbered pick adds the exact product when two products share a name",
  feature: "deterministic numbered pick → product id → cart (no name re-matching)",
  async run(world: World) {
    const { llm } = await import("../metaMock");
    const schema = await import("../../drizzle/schema");
    const base = { tenantId: TENANT_ID, category: "sim", price: "45000.00", currency: "NGN", status: "active", lowStockThreshold: 1 };
    await world.db.insert(schema.products).values([
      { ...base, id: TWIN_OOS, sku: "SIM-TWIN-OOS", name: "Hand painted jean", description: "twin (sold out)", stockQuantity: 0 },
      { ...base, id: TWIN_OK, sku: "SIM-TWIN-OK", name: "Hand painted jean ", description: "twin (in stock)", stockQuantity: 5 },
    ]).onConflictDoNothing();

    llm.forceNetworkError = true;
    try {
      const phone = world.newPhone("j619");
      await world.grantConsent(phone);

      let before = replyCount(world, phone);
      await world.text(phone, "shop");
      await world.waitFor(() => replyCount(world, phone) > before, 15000, "menu");
      const menu = bodyText(lastReply(world, phone));
      const lines = menu.split("\n").filter((l) => /^\d+\.\s+Hand painted jean/.test(l));
      assert(lines.length === 2, `both twins are listed (got: ${menu.slice(0, 400)})`);
      const inStockLine = lines.find((l) => !/out of stock/.test(l));
      assert(!!inStockLine, "one twin is listed as in stock");
      const pick = inStockLine!.split(".")[0];

      before = replyCount(world, phone);
      await world.text(phone, pick);
      await world.waitFor(() => replyCount(world, phone) > before, 20000, "add-to-cart reply");
      const addReply = bodyText(lastReply(world, phone));
      assert(!/out of stock/i.test(addReply), `picking the in-stock twin (#${pick}) must not say out of stock (got: ${addReply.slice(0, 200)})`);
      assertIncludes(addReply, "Hand painted jean", "the picked item is named in the reply");

      const sessions = await world.db.select({ id: schema.cartSessions.id }).from(schema.cartSessions)
        .where(and(eq(schema.cartSessions.tenantId, TENANT_ID), eq(schema.cartSessions.waPhoneNumber, phone)));
      const items = sessions.length === 0 ? [] : await world.db.select().from(schema.cartItems)
        .where(inArray(schema.cartItems.cartSessionId, sessions.map((s: { id: string }) => s.id)));
      assert(items.length === 1 && items[0].productId === TWIN_OK, `the cart holds the in-stock twin (got: ${JSON.stringify(items.map((i: any) => i.productId))})`);

      // Picking the sold-out twin by number is still refused.
      const oosPick = lines.find((l) => /out of stock/.test(l))!.split(".")[0];
      before = replyCount(world, phone);
      await world.text(phone, oosPick);
      await world.waitFor(() => replyCount(world, phone) > before, 20000, "sold-out pick reply");
      assertIncludes(bodyText(lastReply(world, phone)), "out of stock", "the sold-out twin is still refused");
    } finally {
      llm.forceNetworkError = false;
      await world.db.delete(schema.cartItems).where(inArray(schema.cartItems.productId, [TWIN_OOS, TWIN_OK]));
      await world.db.delete(schema.products).where(inArray(schema.products.id, [TWIN_OOS, TWIN_OK]));
    }
  },
};
