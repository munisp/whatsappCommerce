// === W46 uc-ux (Coder E) ===
/**
 * w46-uc-ux-seed.ts — shared seeds for the W46 uc-ux journeys (J407–J411).
 * NOT a journey itself (runner imports journeys explicitly).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, type World } from "../world";

/** Product with stock + a cart session with items, ready for createChatOrder. */
export async function seedCartWithProduct(
  world: World,
  tag: string,
  phone: string,
  opts: { unitPrice?: string; qty?: number; stock?: number } = {},
): Promise<{ productId: string; cartSessionId: string }> {
  const schema = await import("../../drizzle/schema");
  const productId = `prod-w46-${tag}`;
  await world.db.execute(`DELETE FROM products WHERE id = '${productId}'`).catch(() => undefined);
  await world.db.insert(schema.products).values({
    id: productId,
    tenantId: TENANT_ID,
    sku: `SIM-W46-${tag.toUpperCase()}`,
    name: `W46 Product ${tag}`,
    price: opts.unitPrice ?? "5000.00",
    currency: "NGN",
    status: "active",
    stockQuantity: opts.stock ?? 10,
  });
  const cartSessionId = `cart-w46-${tag}-${Date.now().toString(36)}`;
  await world.db.insert(schema.cartSessions).values({
    id: cartSessionId,
    tenantId: TENANT_ID,
    waPhoneNumber: phone,
    sessionData: {},
    currentStep: "browse",
  });
  await world.db.insert(schema.cartItems).values({
    id: crypto.randomUUID(),
    cartSessionId,
    productId,
    productName: `W46 Product ${tag}`,
    quantity: opts.qty ?? 1,
    unitPrice: opts.unitPrice ?? "5000.00",
    currency: "NGN",
  });
  return { productId, cartSessionId };
}

/** Reset the tenant's W46 policy columns so journeys stay isolated. */
export async function resetW46TenantPolicies(world: World): Promise<void> {
  const schema = await import("../../drizzle/schema");
  await world.db.update(schema.tenants).set({
    minOrderCentsDelivery: 0,
    minOrderCentsPickup: 0,
    giftWrapFeeCents: 0,
  }).where(eq(schema.tenants.id, TENANT_ID));
}
// === END W46 uc-ux ===
