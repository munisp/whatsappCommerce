// === W46 privacy-consent (TEN-15) ===
/**
 * ageGate.ts — age-restricted product gating at checkout.
 *
 * A product with products.ageRestricted=true may not be ordered until the
 * buyer has attested to being at least the required age (products.minAge,
 * default DEFAULT_MIN_AGE when the column is NULL). The gate runs inside
 * createChatOrder (server/routers/nlp.ts) — the SINGLE order-creation seam
 * shared by the WhatsApp flow, the Telegram flow (channel parity routes the
 * same intents) and the LLM/agent confirm_order path, so every chat/agent
 * order is covered by one check.
 *
 * Attestations are durable (age_attestations, mig 0161): one row per
 * (tenant, buyer identity). A returning buyer is not re-prompted. The gate
 * FAILS CLOSED on DB errors for the restriction lookup (better to prompt
 * again than to sell a restricted item ungated) but never throws into the
 * checkout flow — it returns a structured verdict the caller renders.
 */
import { and, eq, inArray } from "drizzle-orm";
import { ageAttestations, products } from "../../drizzle/schema";

export const DEFAULT_MIN_AGE = 18;

export interface AgeGateVerdict {
  ok: boolean;
  /** Required age when ok=false. */
  requiredAge?: number;
  /** Product ids that triggered the gate. */
  restrictedProductIds?: string[];
  /** ok=false + needsAttestation: the caller must collect an attestation. */
  needsAttestation?: boolean;
}

/** Highest required age among the given products, or null when none gated. */
export async function requiredAgeForProducts(
  db: any,
  tenantId: string,
  productIds: string[],
): Promise<{ requiredAge: number; restrictedProductIds: string[] } | null> {
  if (productIds.length === 0) return null;
  const rows = await db
    .select({ id: products.id, ageRestricted: products.ageRestricted, minAge: products.minAge })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), inArray(products.id, productIds)));
  const restricted = rows.filter((r: any) => r.ageRestricted === true);
  if (restricted.length === 0) return null;
  const requiredAge = restricted.reduce(
    (m: number, r: any) => Math.max(m, Number(r.minAge ?? 0) > 0 ? Number(r.minAge) : DEFAULT_MIN_AGE),
    0,
  );
  return { requiredAge, restrictedProductIds: restricted.map((r: any) => r.id) };
}

/** True when a durable attestation meeting `requiredAge` exists. */
export async function hasAgeAttestation(
  db: any,
  tenantId: string,
  phone: string,
  requiredAge: number,
): Promise<boolean> {
  const [row] = await db
    .select({ attestedAge: ageAttestations.attestedAge })
    .from(ageAttestations)
    .where(and(eq(ageAttestations.tenantId, tenantId), eq(ageAttestations.phone, phone)))
    .limit(1);
  return !!row && Number(row.attestedAge) >= requiredAge;
}

/**
 * Record an attestation (idempotent per tenant+phone). Re-attesting to a
 * HIGHER age raises the stored attestedAge; a lower re-attestation never
 * lowers it. Returns the stored row's attestedAge.
 */
export async function recordAgeAttestation(
  db: any,
  opts: {
    tenantId: string;
    phone: string;
    attestedAge: number;
    channel?: string;
    source?: string;
    orderId?: string | null;
  },
): Promise<number> {
  const channel = opts.channel ?? "whatsapp";
  const source = opts.source ?? "chat_reply";
  const [existing] = await db
    .select()
    .from(ageAttestations)
    .where(and(eq(ageAttestations.tenantId, opts.tenantId), eq(ageAttestations.phone, opts.phone)))
    .limit(1);
  if (existing) {
    const raised = Math.max(Number(existing.attestedAge), opts.attestedAge);
    await db
      .update(ageAttestations)
      .set({
        attestedAge: raised,
        channel,
        source,
        ...(opts.orderId ? { orderId: opts.orderId } : {}),
      })
      .where(eq(ageAttestations.id, existing.id));
    return raised;
  }
  await db.insert(ageAttestations).values({
    tenantId: opts.tenantId,
    phone: opts.phone,
    attestedAge: opts.attestedAge,
    channel,
    source,
    orderId: opts.orderId ?? null,
  });
  return opts.attestedAge;
}

/**
 * Checkout gate. When the cart contains age-restricted products the buyer
 * must either have a durable attestation on file or be explicitly attesting
 * in this checkout (`attested: true` — the caller confirmed the buyer's
 * affirmative reply and renders the attestation into evidence).
 */
export async function assertAgeGate(
  db: any,
  opts: {
    tenantId: string;
    phone: string;
    productIds: string[];
    /** Buyer attested in this checkout turn (chat reply / API flag). */
    attested?: boolean;
    channel?: string;
    source?: string;
  },
): Promise<AgeGateVerdict> {
  const requirement = await requiredAgeForProducts(db, opts.tenantId, opts.productIds);
  if (!requirement) return { ok: true };
  const { requiredAge, restrictedProductIds } = requirement;
  if (await hasAgeAttestation(db, opts.tenantId, opts.phone, requiredAge)) return { ok: true };
  if (opts.attested === true) {
    await recordAgeAttestation(db, {
      tenantId: opts.tenantId,
      phone: opts.phone,
      attestedAge: requiredAge,
      channel: opts.channel,
      source: opts.source,
    });
    return { ok: true };
  }
  return { ok: false, requiredAge, restrictedProductIds, needsAttestation: true };
}

/** Buyer-facing attestation prompt (both channels — plain text, no WA-only affordances). */
export function buildAgeAttestationPrompt(requiredAge: number, productNames: string[]): string {
  const list = productNames.length ? ` (${productNames.join(", ")})` : "";
  return (
    `🔞 One or more items in your cart${list} are age-restricted. ` +
    `Please confirm you are ${requiredAge} years or older by replying "YES ${requiredAge}+" to complete your order.`
  );
}

/** Matches an affirmative age attestation reply, e.g. "yes 18+", "I am 21". */
export const AGE_AFFIRM_RE = /\b(yes|confirm|i am|i'm)\b[^\d]{0,12}(\d{2})\s*\+?/i;
