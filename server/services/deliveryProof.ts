// === W43 dispatch (Coder C) ===
/**
 * deliveryProof.ts — proof-of-delivery (POD) photos + the tenants.requirePod
 * delivered-transition gate (mig 0134).
 *
 * Two capture paths, ONE recording core:
 *   1. Courier/driver → POST /api/delivery/proof (base64 JSON, idempotent on
 *      idempotencyKey) — see server/_core/index.ts.
 *   2. Customer sends a photo in chat while their order is in the
 *      "awaiting_pod" state = latest shipment out_for_delivery/in_transit,
 *      order not yet delivered, tenant requirePod on. WA images claim through
 *      the existing inbound-image chain (before visual search); Telegram
 *      photos claim in telegramInbound's media branch. Media bytes are stored
 *      via the EXISTING WA media storage path (storagePut under
 *      whatsapp-media/<tenantId>/…) — no new deps.
 *
 * Gate: when tenants.requirePod is false (default) every delivered
 * transition behaves exactly as pre-W43. When true, logistics.simulateDelivery
 * and the shipbubble webhook refuse the → delivered transition until a
 * delivery_proofs row exists; recordDeliveryProof itself completes the
 * transition claim-first (guarded UPDATE … WHERE status <> 'delivered').
 *
 * Notifications: the delivered confirmation goes out on BOTH channels via
 * channelParity sendCustomerText (category "delivery_proof", registered in
 * channelParity.ts).
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  deliveryProofs,
  logisticsShipments,
  orders,
  telegramIdentities,
  tenants,
  type DeliveryProof,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const POD_CATEGORY = "delivery_proof";
export const POD_TYPES = ["photo", "signature", "otp"] as const;
export type PodType = (typeof POD_TYPES)[number];

/** Shipment states in which a buyer photo counts as an awaiting-POD proof. */
export const AWAITING_POD_SHIPMENT_STATUSES = ["out_for_delivery", "in_transit"] as const;

// ─── Tenant flag ─────────────────────────────────────────────────────────────

export async function tenantRequiresPod(db: Db, tenantId: string): Promise<boolean> {
  const [t] = await db
    .select({ requirePod: tenants.requirePod })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  return t?.requirePod === true;
}

/**
 * Gate consulted by every → delivered transition. required=false means the
 * tenant flag is off (default) and the transition is unchanged from pre-W43.
 */
export async function podDeliveryGate(
  db: Db,
  tenantId: string,
  orderId: string,
): Promise<{ required: boolean; satisfied: boolean }> {
  const required = await tenantRequiresPod(db, tenantId);
  if (!required) return { required: false, satisfied: true };
  const [proof] = await db
    .select({ id: deliveryProofs.id })
    .from(deliveryProofs)
    .where(and(eq(deliveryProofs.tenantId, tenantId), eq(deliveryProofs.orderId, orderId)))
    .limit(1);
  return { required: true, satisfied: !!proof };
}

// ─── Awaiting-POD order resolution (chat claim) ─────────────────────────────

async function resolveBuyerPhones(db: Db, tenantId: string, buyerRef: string): Promise<string[]> {
  const ref = String(buyerRef).trim();
  if (/^telegram:/i.test(ref) || /^\d{1,19}$/.test(ref) === false) {
    // Telegram chat id → linked phone (telegram: refs carry the chat id).
    const chatId = ref.replace(/^telegram:/i, "");
    const [row] = await db
      .select({ phone: telegramIdentities.phoneE164 })
      .from(telegramIdentities)
      .where(and(eq(telegramIdentities.tenantId, tenantId), eq(telegramIdentities.chatId, chatId)))
      .limit(1)
      .catch(() => [] as any[]);
    return row?.phone ? [row.phone] : [];
  }
  return [ref.replace(/^\+/, "")];
}

/**
 * The buyer's most recent order in the awaiting-POD state: shipment
 * out_for_delivery/in_transit, order not delivered/cancelled, and (for the
 * CHAT claim only) the tenant requires POD — when the flag is off an inbound
 * photo must fall through to the receipt/visual-search chain unchanged.
 */
export async function findAwaitingPodOrder(
  db: Db,
  tenantId: string,
  buyerRef: string,
): Promise<{ order: typeof orders.$inferSelect; shipment: typeof logisticsShipments.$inferSelect } | null> {
  if (!(await tenantRequiresPod(db, tenantId))) return null;
  const phones = await resolveBuyerPhones(db, tenantId, buyerRef);
  if (!phones.length) return null;
  const candidates = await db
    .select()
    .from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      inArray(orders.customerId, phones),
      inArray(orders.status, ["pending", "confirmed", "processing", "shipped"]),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(5)
    .catch(() => [] as any[]);
  for (const order of candidates) {
    const [shipment] = await db
      .select()
      .from(logisticsShipments)
      .where(and(
        eq(logisticsShipments.tenantId, tenantId),
        eq(logisticsShipments.orderId, order.id),
        inArray(logisticsShipments.status, [...AWAITING_POD_SHIPMENT_STATUSES]),
      ))
      .orderBy(desc(logisticsShipments.createdAt))
      .limit(1)
      .catch(() => [] as any[]);
    if (shipment) return { order, shipment };
  }
  return null;
}

// ─── Recording + delivered completion ───────────────────────────────────────

export interface RecordDeliveryProofInput {
  tenantId: string;
  orderId: string;
  type?: PodType;
  /** Raw media bytes; stored via the existing WA media storage path. */
  mediaBuffer?: Buffer | null;
  mimeType?: string | null;
  /** Pre-existing media reference (e.g. WA graph URL) when no buffer. */
  mediaUrl?: string | null;
  capturedByDriverId?: string | null;
  capturedVia: "endpoint" | "whatsapp" | "telegram";
  idempotencyKey?: string | null;
  fulfillmentId?: string | null;
  capturedAt?: Date;
}

export interface RecordDeliveryProofResult {
  proof: DeliveryProof;
  duplicate: boolean;
  delivered: boolean;
  podRequired: boolean;
}

function extForMime(mime: string | null | undefined): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("pdf")) return "pdf";
  return "bin";
}

/**
 * Record a POD and — when the tenant gate requires it — complete the
 * delivered transition claim-first. Idempotent on idempotencyKey.
 */
export async function recordDeliveryProof(
  db: Db,
  input: RecordDeliveryProofInput,
): Promise<RecordDeliveryProofResult> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);

  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.tenantId, input.tenantId)))
    .limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });

  // Idempotency: a replayed courier POST returns the original proof.
  if (input.idempotencyKey) {
    const [existing] = await db.select().from(deliveryProofs)
      .where(and(
        eq(deliveryProofs.tenantId, input.tenantId),
        eq(deliveryProofs.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1);
    if (existing) {
      return { proof: existing, duplicate: true, delivered: order.status === "delivered", podRequired: tenant.requirePod === true };
    }
  }

  // Latest shipment for linkage/timeline (nullable — POD may arrive first).
  const [shipment] = await db.select().from(logisticsShipments)
    .where(and(eq(logisticsShipments.tenantId, input.tenantId), eq(logisticsShipments.orderId, order.id)))
    .orderBy(desc(logisticsShipments.createdAt))
    .limit(1)
    .catch(() => [] as any[]);

  // Media bytes → the existing WA media storage path (no new deps). Storage
  // failure is NON-FATAL (same contract as visualStocktake): the proof row
  // keeps its key + any source URL so a storage outage never blocks a
  // delivery confirmation.
  let mediaUrl = input.mediaUrl ?? null;
  let mediaKey: string | null = null;
  if (input.mediaBuffer && input.mediaBuffer.length > 0) {
    const ext = extForMime(input.mimeType);
    mediaKey = `whatsapp-media/${input.tenantId}/pod-${order.id}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    try {
      const { storagePut } = await import("../storage");
      const put = await storagePut(mediaKey, input.mediaBuffer, input.mimeType ?? "image/jpeg");
      mediaUrl = put.url;
    } catch (e: any) {
      console.warn("[deliveryProof] storagePut failed (keeping source reference):", e?.message);
    }
  }

  const now = new Date();
  const [proof] = await db.insert(deliveryProofs).values({
    tenantId: input.tenantId,
    orderId: order.id,
    fulfillmentId: input.fulfillmentId ?? null,
    shipmentId: shipment?.id ?? null,
    type: input.type ?? "photo",
    mediaUrl,
    mediaKey,
    mimeType: input.mimeType ?? null,
    capturedByDriverId: input.capturedByDriverId ?? null,
    capturedVia: input.capturedVia,
    idempotencyKey: input.idempotencyKey ?? null,
    capturedAt: input.capturedAt ?? now,
  }).returning();

  // Complete the delivered transition when the gate is now satisfied.
  const delivered = await completeDeliveryWithProof(db, {
    tenantId: input.tenantId,
    order,
    shipment: shipment ?? null,
    at: now,
  });

  return { proof: proof!, duplicate: false, delivered, podRequired: tenant.requirePod === true };
}

/**
 * Claim-first delivered completion: ONE guarded UPDATE wins; escrow delivery
 * confirmation runs exactly once for the winner. Safe to call when the order
 * is already delivered (returns true, no double-notify).
 */
export async function completeDeliveryWithProof(
  db: Db,
  opts: {
    tenantId: string;
    order: Pick<typeof orders.$inferSelect, "id" | "status" | "orderNumber">;
    shipment?: Pick<typeof logisticsShipments.$inferSelect, "id" | "escrowTxId" | "status" | "carrierName" | "trackingId" | "deliveryPin"> | null;
    at: Date;
  },
): Promise<boolean> {
  const { order, shipment, at } = opts;
  if (order.status === "delivered") return true;

  const claimed = (await db.execute(sql`
    UPDATE orders
    SET status = 'delivered', "updatedAt" = ${at.toISOString()}
    WHERE id = ${order.id}
      AND "tenantId" = ${opts.tenantId}
      AND status <> 'delivered'
    RETURNING id`)) as any;
  const claimRows: any[] = Array.isArray(claimed) ? claimed : (claimed?.rows ?? []);
  if (claimRows.length === 0) return true; // already delivered (lost the race)

  if (shipment) {
    await db.update(logisticsShipments).set({
      status: "delivered",
      deliveredAt: at,
      webhookPayloads: sql`webhook_payloads || ${JSON.stringify([{ event: "delivered", via: "delivery_proof", timestamp: at.toISOString() }])}::jsonb`,
      updatedAt: at,
    }).where(and(eq(logisticsShipments.id, shipment.id), ne(logisticsShipments.status, "delivered")));
    if (shipment.escrowTxId) {
      const { confirmEscrowDelivery } = await import("./escrowLifecycle");
      await confirmEscrowDelivery(db, { escrowTxId: shipment.escrowTxId, shipmentId: shipment.id, at });
    }
  }

  // Both-channel delivered notification (category registered in channelParity).
  try {
    const { resolveBuyerPhone } = await import("../routers/logistics");
    const phone = await resolveBuyerPhone(db, order.id);
    if (phone) {
      const { sendCustomerText } = await import("./channelParity");
      // Found live 2026-09-26: the Reviews admin page's own copy claims "buyers are prompted on WhatsApp
      // after delivery," but nothing ever actually sent that prompt — the review-submission flow itself
      // works (nlp.ts's "RATE 1-5 ..." handler, verified-purchase gated) but was undiscoverable, so the
      // reviews table sat at zero rows despite real deliveries happening. This is the one moment the
      // buyer is both eligible (order just went delivered = hasVerifiedPurchase becomes true) and most
      // likely to actually respond.
      await sendCustomerText(opts.tenantId, phone, POD_CATEGORY,
        `✅ Proof of delivery received for order ${order.orderNumber} — your order is now marked delivered. Enjoy! If anything is wrong, just reply here.\n\n⭐ How was it? Reply "RATE 5 great!" (1-5) to leave a review — it helps other buyers and the seller.`,
        { notifType: POD_CATEGORY, orderId: order.id } as any);
    }
  } catch (e: any) {
    console.warn("[deliveryProof] delivered notify failed:", e?.message);
  }
  return true;
}

// ─── Chat capture paths ──────────────────────────────────────────────────────

/** Download a WhatsApp media object (same Graph flow as receiptVerification). */
async function downloadWaMedia(tenantId: string, mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const { resolveTenantWaCredentials } = await import("./waSender");
  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) return null;
  const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(12000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const url = meta?.url;
  if (!url) return null;
  const bin = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(20000),
  }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  if (!bin) return null;
  return { buffer: Buffer.from(bin), mimeType: typeof meta?.mime_type === "string" ? meta.mime_type : "image/jpeg" };
}

export interface PodChatOutcome {
  handled: boolean;
  outcome?: "recorded" | "not_awaiting" | "download_failed";
  orderId?: string;
}

/**
 * WA inbound-image chain hook: claims the image ONLY when the sender has an
 * order in the awaiting-POD state (tenant requirePod on + shipment
 * out_for_delivery/in_transit). Anything else falls through to the existing
 * receipt/visual-search chain unchanged.
 */
export async function handleInboundPodImage(opts: {
  tenantId: string;
  waPhoneNumber: string;
  mediaId: string;
  caption?: string;
}): Promise<PodChatOutcome> {
  const db = await getDb();
  if (!db) return { handled: false };
  const found = await findAwaitingPodOrder(db, opts.tenantId, opts.waPhoneNumber);
  if (!found) return { handled: false, outcome: "not_awaiting" };

  const { sendWhatsAppText } = await import("./waSender");
  const media = await downloadWaMedia(opts.tenantId, opts.mediaId);
  if (!media) {
    await sendWhatsAppText(opts.tenantId, opts.waPhoneNumber,
      `📷 Thanks! We couldn't download that photo — please resend it so we can confirm delivery of order ${found.order.orderNumber}.`,
      { notifType: POD_CATEGORY, orderId: found.order.id }).catch(() => {});
    return { handled: true, outcome: "download_failed", orderId: found.order.id };
  }
  await recordDeliveryProof(db, {
    tenantId: opts.tenantId,
    orderId: found.order.id,
    type: "photo",
    mediaBuffer: media.buffer,
    mimeType: media.mimeType,
    capturedVia: "whatsapp",
    idempotencyKey: `wa:${opts.mediaId}`,
  });
  await sendWhatsAppText(opts.tenantId, opts.waPhoneNumber,
    `📷 Proof of delivery received for order ${found.order.orderNumber} — thank you!`,
    { notifType: POD_CATEGORY, orderId: found.order.id }).catch(() => {});
  return { handled: true, outcome: "recorded", orderId: found.order.id };
}

/**
 * Telegram inbound-photo claim (telegramInbound media branch): same
 * awaiting-POD gate; bytes arrive already downloaded (Bot API getFile).
 */
export async function handleInboundPodPhotoTelegram(opts: {
  tenantId: string;
  chatId: string;
  buffer: Buffer;
  mimeType?: string | null;
  fileId?: string;
}): Promise<PodChatOutcome> {
  const db = await getDb();
  if (!db) return { handled: false };
  const found = await findAwaitingPodOrder(db, opts.tenantId, `telegram:${opts.chatId}`);
  if (!found) return { handled: false, outcome: "not_awaiting" };
  await recordDeliveryProof(db, {
    tenantId: opts.tenantId,
    orderId: found.order.id,
    type: "photo",
    mediaBuffer: opts.buffer,
    mimeType: opts.mimeType ?? "image/jpeg",
    capturedVia: "telegram",
    idempotencyKey: opts.fileId ? `tg:${opts.fileId}` : null,
  });
  const { sendTelegramText } = await import("./telegramSender");
  await sendTelegramText(opts.tenantId, opts.chatId,
    `📷 Proof of delivery received for order ${found.order.orderNumber} — thank you!`,
    { parseMode: "HTML", disablePreview: true }).catch(() => {});
  return { handled: true, outcome: "recorded", orderId: found.order.id };
}
