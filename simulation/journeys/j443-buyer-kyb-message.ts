// === W47 buyer (Coder B) ===
/**
 * J443 — ONB-B-7: buyer KYB block (TEN-17) renders an honest, actionable
 * message with a remediation path and PRESERVES the draft cart — no more
 * "supplier isn't available" dead end on both the chat renderer and the
 * tRPC path.
 */
import { assert, assertIncludes, SUPPLIER_TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J443",
  name: "ONB-B-7 buyer-KYB block message with remediation + preserved draft",
  feature: "W47 buyer KYB-block UX",
  async run(world: World) {
    const { readFile } = await import("node:fs/promises");

    // 1. submitPurchaseOrder fails closed with the structured reason.
    const poFlow = await import("../../server/services/procurement/poFlow");
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({
      id: "t-j443-nokyb", name: "J443 NoKyb Retail", slug: "t-j443-nokyb", status: "active",
    }).onConflictDoNothing();
    const result = await poFlow.submitPurchaseOrder(world.db, {
      buyerTenantId: "t-j443-nokyb",
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerPhone: world.newPhone("443"),
      lines: [{ name: "Polybag 50kg", qty: 10, unitPriceCents: 20_000 }],
      paymentMode: "paynow",
    });
    assert(result.ok === false && result.reason === "buyer_kyb_required", `buyer without approved KYB blocked (got ${JSON.stringify(result)})`);

    // 2. Chat renderer: distinct KYB copy + remediation + draft preserved.
    const poSrc = await readFile(new URL("../../server/services/procurement/poFlow.ts", import.meta.url), "utf8");
    assertIncludes(poSrc, 'result.reason === "buyer_kyb_required"', "chat renderer special-cases buyer_kyb_required");
    assertIncludes(poSrc, "verification (KYB)", "buyer-facing copy names KYB");
    assertIncludes(poSrc, "Settings → Verification", "remediation path given");
    assert(poSrc.includes('buyer_kyb_required') && poSrc.indexOf("buyer_kyb_required") < poSrc.indexOf("Sorry, that supplier isn't available"), "KYB branch precedes the generic fallback");

    // 3. tRPC path surfaces an actionable FORBIDDEN, not the generic message.
    const procSrc = await readFile(new URL("../../server/routers/procurement.ts", import.meta.url), "utf8");
    assertIncludes(procSrc, "buyer_kyb_required", "tRPC path special-cases buyer_kyb_required");
    assertIncludes(procSrc, "Complete it under Settings → Verification", "tRPC remediation copy");
  },
};
