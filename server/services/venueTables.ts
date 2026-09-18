// === W46 uc-ux (Coder E): UC-17 — venue table QR ordering + kitchen board ===
/**
 * venueTables.ts — table-side QR ordering.
 *
 * A venue table carries a capability `qrToken` (random, unguessable) printed
 * as a QR on the table. The QR encodes a chat deep link (wa.me / t.me) with
 * a prefilled `TABLE:<token>` message — the same token grammar works on BOTH
 * channels because telegram inbound routes through the shared nlp engine
 * (routers/nlp.ts). When the buyer's first message is the TABLE: payload,
 * `seedCartFromTableQr` creates/loads their cart session and stamps
 * sessionData.venueTable = { tableId, label }; createChatOrder (adjacent
 * seam in routers/nlp.ts) copies it onto orders.metadata so the kitchen
 * board (`getKitchenBoard`) shows active orders grouped by table.
 */

import { and, eq, sql } from "drizzle-orm";
import { cartSessions, tenants, venueTables } from "../../drizzle/schema";
import { assertTenantActive } from "./tenantGuard";

type Db = any;

/** Create a venue table with a fresh capability QR token. */
export async function createVenueTable(
  db: Db,
  opts: { tenantId: string; label: string; qrToken?: string },
): Promise<{ id: string; qrToken: string }> {
  const [tenant] = await db.select({ id: tenants.id, status: tenants.status })
    .from(tenants).where(eq(tenants.id, opts.tenantId)).limit(1);
  if (tenant) assertTenantActive(tenant);
  const qrToken = opts.qrToken ?? `vt_${crypto.randomUUID().replace(/-/g, "")}`;
  const [row] = await db.insert(venueTables).values({
    tenantId: opts.tenantId,
    label: opts.label,
    qrToken,
  }).returning({ id: venueTables.id, qrToken: venueTables.qrToken });
  return row;
}

/** Resolve an active venue table by its QR capability token. */
export async function resolveTableByToken(
  db: Db,
  tenantId: string,
  qrToken: string,
): Promise<{ id: string; label: string } | null> {
  const [row] = await db.select({ id: venueTables.id, label: venueTables.label })
    .from(venueTables)
    .where(and(
      eq(venueTables.tenantId, tenantId),
      eq(venueTables.qrToken, qrToken),
      eq(venueTables.active, true),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Deep-link seed: stamp the buyer's cart session (created if missing) with
 * the venue table metadata. Idempotent — re-scanning the same table just
 * refreshes the stamp. Returns null when the token is unknown/inactive.
 */
export async function seedCartFromTableQr(
  db: Db,
  opts: { tenantId: string; qrToken: string; waPhoneNumber: string },
): Promise<{ cartSessionId: string; tableId: string; tableLabel: string } | null> {
  const table = await resolveTableByToken(db, opts.tenantId, opts.qrToken);
  if (!table) return null;
  const stamp = { tableId: table.id, label: table.label, scannedAt: new Date().toISOString() };
  const [existing] = await db.select().from(cartSessions)
    .where(and(eq(cartSessions.tenantId, opts.tenantId), eq(cartSessions.waPhoneNumber, opts.waPhoneNumber)))
    .limit(1);
  if (existing) {
    const sessionData = { ...((existing.sessionData as Record<string, unknown>) ?? {}), venueTable: stamp };
    await db.update(cartSessions).set({ sessionData, updatedAt: new Date() })
      .where(eq(cartSessions.id, existing.id));
    return { cartSessionId: existing.id, tableId: table.id, tableLabel: table.label };
  }
  const id = crypto.randomUUID();
  await db.insert(cartSessions).values({
    id,
    tenantId: opts.tenantId,
    waPhoneNumber: opts.waPhoneNumber,
    sessionData: { venueTable: stamp },
    currentStep: "browse",
  });
  return { cartSessionId: id, tableId: table.id, tableLabel: table.label };
}

/**
 * Attach the cart's venue-table stamp to a freshly created order (adjacent
 * seam called from createChatOrder). Copies
 * cart_sessions.sessionData.venueTable onto orders.metadata.venueTable.
 */
export async function attachVenueTableToOrder(
  db: Db,
  opts: { orderId: string; cartSessionId: string },
): Promise<{ tableId: string; label: string } | null> {
  const [cart] = await db.select({ sessionData: cartSessions.sessionData })
    .from(cartSessions).where(eq(cartSessions.id, opts.cartSessionId)).limit(1);
  const vt = (cart?.sessionData as any)?.venueTable;
  if (!vt?.tableId) return null;
  await db.execute(sql`
    UPDATE orders
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{venueTable}', ${JSON.stringify({ tableId: vt.tableId, label: vt.label })}::jsonb),
        "updatedAt" = now()
    WHERE id = ${opts.orderId}`);
  return { tableId: String(vt.tableId), label: String(vt.label ?? "") };
}

/**
 * Kitchen board: active (unshipped, uncancelled) venue orders with their
 * table labels + itemized lines, oldest first.
 */
export async function getKitchenBoard(
  db: Db,
  tenantId: string,
): Promise<Array<{ orderId: string; orderNumber: string; status: string; tableId: string | null; tableLabel: string | null; items: unknown; createdAt: Date }>> {
  const rows = await db.execute(sql`
    SELECT id, "orderNumber", status, metadata, items, "createdAt"
    FROM orders
    WHERE "tenantId" = ${tenantId}
      AND metadata ? 'venueTable'
      AND status NOT IN ('delivered', 'cancelled', 'refunded')
    ORDER BY "createdAt" ASC`);
  const list = (rows as any).rows ?? rows;
  return (list as any[]).map((r) => ({
    orderId: r.id,
    orderNumber: r.orderNumber,
    status: r.status,
    tableId: r.metadata?.venueTable?.tableId ?? null,
    tableLabel: r.metadata?.venueTable?.label ?? null,
    items: r.items ?? [],
    createdAt: r.createdAt,
  }));
}
// === END W46 uc-ux ===
