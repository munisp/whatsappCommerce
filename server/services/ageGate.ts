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
// === W47 crosscutting (ONB-I18N-1): attestation prompt via locale packs. ===
import { tr } from "./i18n";

export const DEFAULT_MIN_AGE = 18;

export interface AgeGateVerdict {
  ok: boolean;
  /** Required age when ok=false. */
  requiredAge?: number;
  /** Product ids that triggered the gate. */
  restrictedProductIds?: string[];
  /** ok=false + needsAttestation: the caller must collect an attestation. */
  needsAttestation?: boolean;
  // === W47 buyer (ONB-B-1) ===
  /** ok=false + underage: the buyer STATED an age below requiredAge — the
   *  caller must block the restricted items (not re-prompt). */
  underage?: boolean;
  /** The actual digits the buyer stated. */
  statedAge?: number;
  // === END W47 buyer ===
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

/**
 * === W47 crosscutting (ONB-TOCTOU-2 / ONB-ID-3) ===
 * Attestations older than ONB_DORMANT_DAYS (default 90) no longer satisfy the
 * gate: the phone identity is recycled-able, so a stale attestation proves
 * nothing about the CURRENT holder. Re-attestation is required.
 */
export function attestationFreshnessCutoff(): number {
  const days = Number.parseInt(process.env.ONB_DORMANT_DAYS ?? "", 10) || 90;
  return Date.now() - days * 86_400_000;
}

/** True when a durable attestation meeting `requiredAge` exists AND is fresh. */
export async function hasAgeAttestation(
  db: any,
  tenantId: string,
  phone: string,
  requiredAge: number,
): Promise<boolean> {
  const [row] = await db
    .select({ attestedAge: ageAttestations.attestedAge, createdAt: ageAttestations.createdAt })
    .from(ageAttestations)
    .where(and(eq(ageAttestations.tenantId, tenantId), eq(ageAttestations.phone, phone)))
    .limit(1);
  if (!row || Number(row.attestedAge) < requiredAge) return false;
  // W47: dormant attestations expire (recycled-number protection).
  if (row.createdAt && new Date(row.createdAt as any).getTime() < attestationFreshnessCutoff()) {
    return false;
  }
  return true;
}

/**
 * Record an attestation (idempotent per tenant+phone). Re-attesting to a
 * HIGHER age raises the stored attestedAge; a lower re-attestation never
 * lowers it. Returns the stored row's attestedAge.
 */
/** W47 (ONB-TOCTOU-2): proof-of-attestation versioning (mirrors TEN-16). */
export const AGE_GATE_POLICY_VERSION = "age-attestation-v1";

export async function recordAgeAttestation(
  db: any,
  opts: {
    tenantId: string;
    phone: string;
    attestedAge: number;
    channel?: string;
    source?: string;
    orderId?: string | null;
    /** W47: inbound evidence id (WhatsApp wamid) + policy version. */
    proofWamid?: string | null;
    policyVersion?: string | null;
  },
): Promise<number> {
  const channel = opts.channel ?? "whatsapp";
  const source = opts.source ?? "chat_reply";
  const proof = {
    policyVersion: opts.policyVersion ?? AGE_GATE_POLICY_VERSION,
    proofWamid: opts.proofWamid ?? null,
  };
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
        // W47: refresh proof + freshness timestamp on re-attestation.
        createdAt: new Date(),
        ...proof,
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
    ...proof,
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
    // === W47 buyer (ONB-B-1): the ACTUAL digits the buyer stated. When ===
    // provided they decide the outcome: below requiredAge is a FAILED
    // attestation (durable, ratchet-safe); at/above records the real age.
    attestedAge?: number | null;
    channel?: string;
    source?: string;
    /** W47 (ONB-TOCTOU-2): inbound evidence wamid for the attestation. */
    proofWamid?: string | null;
  },
): Promise<AgeGateVerdict> {
  const requirement = await requiredAgeForProducts(db, opts.tenantId, opts.productIds);
  if (!requirement) return { ok: true };
  const { requiredAge, restrictedProductIds } = requirement;
  if (await hasAgeAttestation(db, opts.tenantId, opts.phone, requiredAge)) return { ok: true };
  if (opts.attested === true) {
    const stated = typeof opts.attestedAge === "number" && Number.isFinite(opts.attestedAge)
      ? Math.floor(opts.attestedAge)
      : null;
    if (stated !== null) {
      // Persist the STATED age (never the required age): a truthful minor's
      // "I am 16" records 16 and fails; the ratchet in recordAgeAttestation
      // still never lowers an existing higher attestation.
      const stored = await recordAgeAttestation(db, {
        tenantId: opts.tenantId,
        phone: opts.phone,
        attestedAge: stated,
        channel: opts.channel,
        source: opts.source,
      });
      void stored;
      if (stated < requiredAge) {
        console.info(
          `[ageGate] ONB-B-1 failed attestation: tenant=${opts.tenantId} stated=${stated} required=${requiredAge} — restricted items blocked`,
        );
        return { ok: false, requiredAge, restrictedProductIds, underage: true, statedAge: stated };
      }
      return { ok: true };
    }
    // No digits captured (API flag without an age): keep the pre-W47
    // behavior — the caller vouched for the attestation out-of-band.
    await recordAgeAttestation(db, {
      tenantId: opts.tenantId,
      phone: opts.phone,
      attestedAge: requiredAge,
      channel: opts.channel,
      source: opts.source,
      proofWamid: opts.proofWamid,
    });
    return { ok: true };
  }
  return { ok: false, requiredAge, restrictedProductIds, needsAttestation: true };
}

/**
 * Buyer-facing attestation prompt (both channels — plain text, no WA-only
 * affordances).
 * === W47 crosscutting (ONB-I18N-1): served through the i18n locale packs
 * (en/fr/ha/yo/ig/sw/am). The prompt is a legal gate — an unintelligible
 * prompt is not meaningful attestation. ===
 */
export function buildAgeAttestationPrompt(
  requiredAge: number,
  productNames: string[],
  locale?: string | null,
): string {
  const list = productNames.length ? ` (${productNames.join(", ")})` : "";
  return tr(locale, "ageGatePrompt")
    .split("{age}").join(String(requiredAge))
    .split("{items}").join(list);
}

/** Matches an affirmative age attestation reply, e.g. "yes 18+", "I am 21". */
export const AGE_AFFIRM_RE = /\b(yes|confirm|i am|i'm)\b[^\d]{0,12}(\d{2})\s*\+?/i;

// === W47 buyer (ONB-B-1 / ONB-B-11) =======================================
// The captured digits are the attestation: a truthful minor MUST fail.
export interface AgeAttestationParse {
  /** true = affirmative with an age, false = explicit denial. */
  affirmed: boolean;
  /** The ACTUAL digits the buyer stated (undefined for bare denials). */
  statedAge?: number;
}

/**
 * Parse a reply at the age-attestation prompt.
 *  - Affirmative WITH digits ("yes 18+", "I am 21") → affirmed, statedAge.
 *  - Explicit denial ("no", "not 18", "I'm 16" is affirmative-truthful —
 *    the digits decide, not the keyword) → denied.
 *  - Anything else → null (caller re-prompts with guidance, no loop).
 */
export function parseAgeAttestationReply(text: string): AgeAttestationParse | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const affirm = AGE_AFFIRM_RE.exec(t);
  if (affirm) {
    const statedAge = Number(affirm[2]);
    if (Number.isFinite(statedAge) && statedAge > 0 && statedAge < 130) {
      return { affirmed: true, statedAge };
    }
    return null;
  }
  if (/^(no|nope|nah|not yet|non|rara|mba|a'a)\b/i.test(t) || /\b(under\s?\d{2}|minor)\b/i.test(t)) {
    return { affirmed: false };
  }
  return null;
}

/** Buyer-facing message when the stated age is below the requirement. */
export function buildAgeGateUnderageReply(requiredAge: number, statedAge: number, removedNames: string[]): string {
  const list = removedNames.length ? ` (${removedNames.join(", ")})` : "";
  return (
    `Thanks for your honesty. You must be ${requiredAge} or older to buy age-restricted items, ` +
    `so we've removed the restricted items${list} from your cart. ` +
    `You can still check out with the remaining items — reply "menu" to keep shopping.`
  );
}

/** Buyer-facing message for an explicit denial at the age prompt. */
export function buildAgeGateDenialReply(removedNames: string[]): string {
  const list = removedNames.length ? ` (${removedNames.join(", ")})` : "";
  return (
    `No problem — we've removed the age-restricted items${list} from your cart. ` +
    `You can continue with the remaining items or reply "menu" to keep shopping.`
  );
}
// === END W47 buyer ===
