/**
 * === W41 rma-fx (Coder C) ===
 * J305 — Multi-currency DISPLAY: with a tenant display currency + manual
 * rate configured, the chat catalog/order-summary messages render the dual
 * price ("₦8,000.00 (~$5.28)") plus the honest footer; unconfigured tenants
 * render plain NGN.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { nlpAddToCart, nlpConfirm } from "./helpers";

export const journey: Journey = {
  id: "J305",
  name: "dual-currency rendering (catalog + order summary)",
  feature: "formatPriceDual wired into chat builders; display-only conversion",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // Unit-level: the pure helper.
    const { formatPriceDual, parseDisplayFxConfig } = await import("../../server/services/displayFx");
    const tenant = {
      displayCurrency: "USD",
      displayFxRates: { USD: { rate: "0.00066", updatedAt: new Date().toISOString() } },
    };
    assert(formatPriceDual(tenant, 8000) === "₦8,000.00 (~$5.28)",
      `dual format (got ${formatPriceDual(tenant, 8000)})`);
    assert(formatPriceDual(null, 8000) === "₦8,000.00", "plain format when unconfigured");
    assert(formatPriceDual({ displayCurrency: "USD", displayFxRates: {} }, 8000) === "₦8,000.00",
      "plain format when rate missing");
    assert(parseDisplayFxConfig(tenant)?.currency === "USD", "config parses");

    // Configure the sim tenant (manual rate — no live feed).
    await world.db.update(schema.tenants).set({
      displayCurrency: "USD",
      displayFxRates: { USD: { rate: "0.00066", updatedAt: new Date().toISOString() } },
    }).where(eq(schema.tenants.id, TENANT_ID));

    const phone = world.newPhone("j305");
    await world.grantConsent(phone);
    await nlpAddToCart(world, phone, "2 jollof rice and 1 chicken j305", [
      { product: "Jollof Rice", quantity: 2 },
      { product: "Grilled Chicken", quantity: 1 },
    ]);
    await nlpConfirm(world, phone, "confirm my order j305");
    const summary = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(summary, "₦8,000.00", "NGN subtotal still shown");
    assertIncludes(summary, "(~$", "dual display shown");
    assertIncludes(summary, "$5.28", "converted amount correct");
    assertIncludes(summary, "charged in NGN", "honest footer present");

    // Catalog product image caption renders the dual price too (Ankara is
    // the seeded product with an image). Drive the real nlp.processMessage
    // mutation directly — the webhook delivers the card asynchronously and
    // the delivery seam is covered by j17; here we assert the caption text.
    // === W41 merger === nlp.processMessage is an internalProcedure: the
    // HTTP-key gate sees adminCaller's req with no key and FAILS once any
    // earlier journey (j222) leaves INTERNAL_API_KEY set in-process. An
    // in-process caller WITHOUT req is the documented trusted path
    // (assertInternalApiKey returns early when ctx.req is absent).
    const { appRouter } = await import("../../server/routers");
    const caller = appRouter.createCaller({
      user: {
        id: 1, openId: "sim-admin", email: "admin@sim.local", name: "Sim Admin",
        loginMethod: "keycloak", role: "admin",
        createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
      },
      res: { clearCookie: () => {} },
    } as any);
    world.llm.when("ankara j305", {
      reply: "Here it is!",
      intent: "search",
      nextState: "product_detail",
      extractedItems: [],
      extractedProduct: "Ankara Fabric",
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.95,
    });
    // Fresh phone: the first buyer is mid-checkout, where free text is
    // consumed by the fulfillment flow before the LLM search intent runs.
    const catalogPhone = world.newPhone("j305c");
    const result: any = await (caller as any).nlp.processMessage({
      tenantId: TENANT_ID,
      waPhoneNumber: catalogPhone,
      message: "ankara j305",
    });
    assert(result?.productImage?.link, "product image card composed");
    assertIncludes(result.productImage.caption, "₦5,000.00", "catalog caption NGN price");
    assertIncludes(result.productImage.caption, "(~$", "catalog caption dual price");

    // Reset the tenant config for later journeys.
    await world.db.update(schema.tenants).set({ displayCurrency: null, displayFxRates: null })
      .where(eq(schema.tenants.id, TENANT_ID));
  },
};
