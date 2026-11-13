/**
 * J620 — a pickup order marked "shipped" tells the customer it's READY FOR PICKUP (found 2026-11-10: the order
 * summary promised "We'll message you when it's ready for pickup", but nothing ever sent it), while a delivery
 * order still gets the shipped template — and the template is logged with what it carried, so the dashboard can
 * show what the customer was told (it used to be logged with no content at all).
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import { adminCaller } from "./helpers";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J620",
  name: "pickup orders are told they're ready; order updates keep their content",
  feature: "orderCrud.updateStatus → shipped: pickup text vs delivery template + logged payload",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const make = async (id: string, phone: string, fulfillment: "pickup" | "delivery") => {
      await world.db.insert(schema.orders).values({
        id, tenantId: TENANT_ID, customerId: phone, orderNumber: `SIM-J620-${fulfillment.toUpperCase()}`,
        status: "confirmed", totalAmount: "3000.00", currency: "NGN", paymentStatus: "completed",
        metadata: { source: "whatsapp_chat", fulfillment },
      });
    };
    const pickupPhone = world.newPhone("j620p"), deliveryPhone = world.newPhone("j620d");
    await make("j620-pickup", pickupPhone, "pickup");
    await make("j620-delivery", deliveryPhone, "delivery");
    const saved = await world.db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.tenantId, TENANT_ID));
    assert(["j620-pickup", "j620-delivery"].every((id) => saved.some((o: any) => o.id === id)), `both orders saved (got ${JSON.stringify(saved.map((o: any) => o.id).filter((x: string) => x.startsWith("j620")))})`);
    // adminCaller's user (id 1) has no users row in the sim; order updates log who sent them (FK to users), as a real
    // merchant's would.
    await world.db.execute(`INSERT INTO users (id, "openId", email, name, role) VALUES (1, 'sim-admin', 'admin@sim.local', 'Sim Admin', 'admin') ON CONFLICT DO NOTHING`);
    const caller = await adminCaller();
    for (const id of ["j620-pickup", "j620-delivery"]) {
      await caller.orderCrud.updateStatus({ orderId: id, status: "processing" });
      await caller.orderCrud.updateStatus({ orderId: id, status: "shipped" });
    }
    const logFor = async (phone: string) => {
      for (let i = 0; i < 40; i++) {  // the notification is sent in the background
        const rows = await world.db.select().from(schema.whatsappNotificationLog)
          .where(and(eq(schema.whatsappNotificationLog.tenantId, TENANT_ID), eq(schema.whatsappNotificationLog.phone, phone)));
        if (rows.length) return rows;
        await new Promise((r) => setTimeout(r, 150));
      }
      return [];
    };
    const pickup = await logFor(pickupPhone);
    assert(pickup.some((r: any) => r.notifType === "order_ready_pickup" && JSON.stringify(r.payload).includes("ready for pickup")),
      `the pickup customer is told the order is ready for pickup (got ${JSON.stringify(pickup.map((r: any) => r.notifType))})`);
    assert(!pickup.some((r: any) => r.notifType === "order_shipped"), "and isn't sent the 'shipped' template as well");
    const delivery = await logFor(deliveryPhone);
    const shipped = delivery.find((r: any) => r.notifType === "order_shipped");
    assert(!!shipped, `the delivery customer gets the shipped update (got ${JSON.stringify(delivery.map((r: any) => r.notifType))})`);
    assert((shipped as any).payload?.type === "template" && JSON.stringify((shipped as any).payload).includes("SIM-J620-DELIVERY"),
      `the shipped update is logged with its template and values (got ${JSON.stringify((shipped as any)?.payload)?.slice(0, 160)})`);
  },
};
