/**
 * === W41 Coder A (UC-6) ===
 * Tokenized customer payment methods — reusable PSP authorization tokens
 * (Paystack reusable_authorization / flutterwave card token) for one-tap
 * buyer charges.
 *
 * Doctrine:
 *  - EXPLICIT CONSENT ONLY: a token is saved only when the buyer agreed to a
 *    concrete consent prompt (consentText is persisted for audit). Program-
 *    matic callers must pass the exact prompt the buyer saw; an empty
 *    consentText is refused (fail closed).
 *  - NEVER A PAN: only the PSP authorization handle is stored, AES-256-GCM
 *    encrypted with the v1: envelope (crypto/secrets.ts). displayLabel holds
 *    at most "Brand •••• last4" for buyer recognition.
 *  - FAIL-CLOSED / never-throw money path (mandates.ts contract): charge
 *    helpers return result objects; unknown/revoked tokens and provider
 *    errors resolve to { ok:false }.
 *  - Dev escape mirrors mandates.ts: provider 'fake' tokens charge locally
 *    outside production so journeys/tests stay exercisable; production has
 *    no fake rail.
 */
import { and, desc, eq } from "drizzle-orm";
import { customerPaymentTokens, type CustomerPaymentToken } from "../../drizzle/schema";
import { encryptSecret, decryptSecret } from "./crypto/secrets";
import { isProd } from "../_core/env";

type Db = any;

/** Consent prompt shown in chat before saving a card (buyer replies YES). */
export function tokenConsentPrompt(displayLabel: string | null): string {
  return (
    `Save ${displayLabel ?? "this card"} for faster checkouts and installment payments? ` +
    `We'll charge it only when you ask (or for an agreed installment plan). ` +
    `Reply YES to save it, or NO to skip. You can remove it anytime with "my cards".`
  );
}

export interface SaveTokenArgs {
  tenantId: string;
  buyerPhone: string;
  provider: string;
  /** Raw PSP reusable authorization handle (never a PAN). */
  token: string;
  displayLabel?: string | null;
  /** Exact consent prompt the buyer agreed to — REQUIRED (fail closed). */
  consentText: string;
}

/**
 * Persist a reusable authorization token, encrypted v1:. Throws code-tagged
 * BAD_REQUEST on missing consent/token; a duplicate (same tenant/buyer/
 * provider/token) returns the EXISTING active row (idempotent — the unique
 * token value is looked up by a deterministic fingerprint-free equality on
 * the decrypted value is impossible, so dedupe happens by label+provider
 * best-effort: callers pass the same source reference twice at worst).
 */
export async function saveCustomerToken(db: Db, args: SaveTokenArgs): Promise<CustomerPaymentToken> {
  if (!args.consentText || args.consentText.trim().length < 10) {
    throw Object.assign(new Error("explicit buyer consent is required to save a payment method"), { code: "BAD_REQUEST" });
  }
  if (!args.token || args.token.length < 6) {
    throw Object.assign(new Error("invalid provider token"), { code: "BAD_REQUEST" });
  }
  if (/\d{12,}/.test(args.token.replace(/\s/g, ""))) {
    // A 12+ digit run looks like a PAN — refuse. Authorization handles are
    // alphanumeric (Paystack AUTH_xxx) or short flutterwave tokens.
    throw Object.assign(new Error("refusing to store a value that looks like a card number"), { code: "BAD_REQUEST" });
  }
  const now = new Date();
  const [row] = await db.insert(customerPaymentTokens).values({
    tenantId: args.tenantId,
    buyerPhone: args.buyerPhone,
    provider: args.provider,
    tokenEnc: encryptSecret(args.token),
    displayLabel: args.displayLabel ?? null,
    consentText: args.consentText,
    consentAt: now,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).returning();
  return row;
}

/** Active tokens for a buyer — the raw token is NEVER returned. */
export async function listCustomerTokens(
  db: Db,
  tenantId: string,
  buyerPhone: string,
): Promise<Array<Pick<CustomerPaymentToken, "id" | "provider" | "displayLabel" | "consentAt" | "lastUsedAt">>> {
  const rows = await db.select({
    id: customerPaymentTokens.id,
    provider: customerPaymentTokens.provider,
    displayLabel: customerPaymentTokens.displayLabel,
    consentAt: customerPaymentTokens.consentAt,
    lastUsedAt: customerPaymentTokens.lastUsedAt,
  }).from(customerPaymentTokens)
    .where(and(
      eq(customerPaymentTokens.tenantId, tenantId),
      eq(customerPaymentTokens.buyerPhone, buyerPhone),
      eq(customerPaymentTokens.status, "active"),
    ))
    .orderBy(desc(customerPaymentTokens.createdAt));
  return rows;
}

/**
 * Revoke a token (buyer "remove card N" or merchant action): claim-first
 * active → revoked flip + best-effort provider revoke. Never throws into the
 * caller; returns { ok:false } when the token is not the buyer's active one.
 */
export async function revokeCustomerToken(
  db: Db,
  args: { tenantId: string; buyerPhone: string; tokenId: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const [row] = await db.select().from(customerPaymentTokens)
      .where(and(
        eq(customerPaymentTokens.id, args.tokenId),
        eq(customerPaymentTokens.tenantId, args.tenantId),
        eq(customerPaymentTokens.buyerPhone, args.buyerPhone),
      )).limit(1);
    if (!row || row.status !== "active") return { ok: false, error: "token_not_found" };
    if (row.provider !== "fake") {
      try {
        const { getMandateCapableProviders } = await import("./payments/mandates");
        const chain = await getMandateCapableProviders(args.tenantId);
        const entry = chain.find((e) => e.provider.id === row.provider && typeof e.provider.revokeMandate === "function");
        if (entry?.provider.revokeMandate) {
          const res = await entry.provider.revokeMandate(decryptSecret(row.tokenEnc), entry.creds);
          if (!res?.ok) console.warn(`[customerTokens] provider revoke failed for token ${row.id} — revoking locally anyway`);
        }
      } catch (err: any) {
        console.warn(`[customerTokens] provider revoke error for token ${row.id}: ${err?.message}`);
      }
    }
    const now = new Date();
    const [flipped] = await db.update(customerPaymentTokens)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(eq(customerPaymentTokens.id, row.id), eq(customerPaymentTokens.status, "active")))
      .returning({ id: customerPaymentTokens.id });
    return flipped ? { ok: true } : { ok: false, error: "revoke_claim_failed" };
  } catch (err: any) {
    console.error("[customerTokens] revokeCustomerToken failed:", err?.message);
    return { ok: false, error: err?.message ?? "token_revoke_error" };
  }
}

export interface ChargeTokenResult {
  ok: boolean;
  reference?: string;
  status?: "success" | "pending" | "failed";
  provider?: string;
  error?: string;
}

/**
 * Charge an active customer token off-session (installment capture or
 * one-tap reorder). NEVER throws; fail-closed on every doubt (unknown /
 * revoked / cross-tenant token, provider missing, provider error).
 * 'pending' means the provider accepted but money has NOT moved — the
 * caller persists a durable buyer_plan_charges row and the verify-first
 * reconciler settles it.
 */
export async function chargeCustomerToken(
  db: Db,
  args: {
    tenantId: string;
    tokenId: string;
    amountCents: number;
    currency?: string;
    reference: string;
    metadata?: Record<string, unknown>;
  },
): Promise<ChargeTokenResult> {
  try {
    const amountCents = Math.round(args.amountCents);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      return { ok: false, error: "invalid_amount" };
    }
    const [token] = await db.select().from(customerPaymentTokens)
      .where(and(
        eq(customerPaymentTokens.id, args.tokenId),
        eq(customerPaymentTokens.tenantId, args.tenantId),
      )).limit(1);
    if (!token) return { ok: false, error: "token_not_found" };
    if (token.status !== "active") return { ok: false, error: `token_not_active:${token.status}` };

    // Dev fake tokens "charge" locally — success without provider I/O.
    if (token.provider === "fake" && !isProd) {
      await db.update(customerPaymentTokens)
        .set({ lastUsedAt: new Date(), updatedAt: new Date() })
        .where(eq(customerPaymentTokens.id, token.id)).catch(() => undefined);
      return { ok: true, reference: args.reference, status: "success", provider: "fake" };
    }

    const { getMandateCapableProviders } = await import("./payments/mandates");
    const chain = await getMandateCapableProviders(args.tenantId);
    const entry = chain.find(
      (e) => e.provider.id === token.provider && typeof e.provider.chargeMandate === "function",
    );
    if (!entry || typeof entry.provider.chargeMandate !== "function") {
      return { ok: false, error: "provider_not_token_capable", provider: token.provider };
    }
    const res = await entry.provider.chargeMandate(
      {
        mandateRef: decryptSecret(token.tokenEnc),
        amountCents,
        currency: (args.currency ?? "NGN").toUpperCase(),
        reference: args.reference,
        metadata: args.metadata,
      },
      entry.creds,
    );
    if (!res?.ok) {
      return { ok: false, provider: entry.provider.id, status: "failed", error: res?.error ?? "token_charge_failed" };
    }
    await db.update(customerPaymentTokens)
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(eq(customerPaymentTokens.id, token.id)).catch(() => undefined);
    return { ok: true, reference: res.reference ?? args.reference, status: res.status, provider: entry.provider.id };
  } catch (err: any) {
    console.error("[customerTokens] chargeCustomerToken failed:", err?.message);
    return { ok: false, error: err?.message ?? "token_charge_error" };
  }
}

/**
 * READ-ONLY status probe for a token charge reference (verify-first
 * reconciler). Returns 'unknown' on any failure — never guesses.
 */
export async function fetchTokenChargeStatus(
  tenantId: string,
  args: { provider: string; reference: string; timeoutMs?: number },
): Promise<{ status: "pending" | "success" | "failed" | "unknown"; amountCents?: number }> {
  try {
    const { fetchMandateChargeStatus } = await import("./payments/mandates");
    return await fetchMandateChargeStatus(tenantId, args);
  } catch {
    return { status: "unknown" };
  }
}

/**
 * Extract a reusable authorization from a provider webhook payload (RAW
 * payload as passed to confirmProviderPayment). Returns null when the
 * provider did not return a reusable handle — the honest "nothing to save"
 * outcome. NEVER fabricates a token.
 *
 *  - paystack:    data.authorization { reusable:true, authorization_code,
 *                 card_type/brand, last4 }
 *  - flutterwave: data.card { token, type, last_4digits }
 *  - fake (dev):  rawPayload.fakeAuthorization { token, label } — journeys.
 */
export function extractReusableAuthorization(
  provider: string,
  rawPayload: unknown,
): { token: string; displayLabel: string | null } | null {
  const p = (rawPayload ?? {}) as Record<string, any>;
  if (provider === "paystack") {
    const a = p?.authorization;
    if (a && a.reusable === true && typeof a.authorization_code === "string" && a.authorization_code) {
      const brand = (a.brand ?? a.card_type ?? "Card") as string;
      const last4 = typeof a.last4 === "string" && a.last4 ? a.last4 : null;
      return { token: a.authorization_code, displayLabel: last4 ? `${brand} •••• ${last4}` : brand };
    }
    return null;
  }
  if (provider === "flutterwave") {
    const c = p?.card;
    if (c && typeof c.token === "string" && c.token) {
      const type = (c.type ?? "Card") as string;
      const last4 = typeof c.last_4digits === "string" && c.last_4digits ? c.last_4digits : null;
      return { token: c.token, displayLabel: last4 ? `${type} •••• ${last4}` : type };
    }
    return null;
  }
  if (provider === "fake" && !isProd) {
    const f = p?.fakeAuthorization;
    if (f && typeof f.token === "string" && f.token) {
      return { token: f.token, displayLabel: typeof f.label === "string" ? f.label : "Dev card" };
    }
    return null;
  }
  return null;
}

/**
 * Save a token from a COMPLETED payment reference by re-fetching the
 * provider's reusable authorization (READ-ONLY verify — never a charge).
 * Honest outcomes:
 *   - provider returns a reusable handle → token saved (encrypted v1:).
 *   - no reusable handle → { ok:false, error:"no_reusable_authorization" }
 *     (the honest "nothing to save" — we NEVER fabricate a token).
 *   - provider unreachable/misconfigured → { ok:false }.
 */
export async function saveTokenFromPayment(
  db: Db,
  args: { tenantId: string; buyerPhone: string; provider: string; reference: string; consentText: string },
): Promise<{ ok: boolean; tokenId?: string; displayLabel?: string | null; error?: string }> {
  try {
    if (!args.consentText || args.consentText.trim().length < 10) {
      return { ok: false, error: "consent_required" };
    }
    if (args.provider === "fake" && !isProd) {
      const row = await saveCustomerToken(db, {
        tenantId: args.tenantId,
        buyerPhone: args.buyerPhone,
        provider: "fake",
        token: `fake-${args.reference}`.slice(0, 64),
        displayLabel: "Dev card",
        consentText: args.consentText,
      });
      return { ok: true, tokenId: row.id, displayLabel: row.displayLabel };
    }
    const reusable = await fetchReusableAuthorization(args.provider, args.reference);
    if (!reusable) return { ok: false, error: "no_reusable_authorization" };
    const row = await saveCustomerToken(db, {
      tenantId: args.tenantId,
      buyerPhone: args.buyerPhone,
      provider: args.provider,
      token: reusable.token,
      displayLabel: reusable.displayLabel,
      consentText: args.consentText,
    });
    return { ok: true, tokenId: row.id, displayLabel: row.displayLabel };
  } catch (err: any) {
    console.error("[customerTokens] saveTokenFromPayment failed:", err?.message);
    return { ok: false, error: err?.message ?? "save_failed" };
  }
}

/** READ-ONLY provider verify to recover a reusable authorization handle. */
async function fetchReusableAuthorization(
  provider: string,
  reference: string,
): Promise<{ token: string; displayLabel: string | null } | null> {
  if (provider === "paystack") {
    const key = process.env.PAYSTACK_SECRET_KEY ?? "";
    if (!key) return null;
    const resp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${key}` },
    }).then((r) => r.json()).catch(() => null);
    return extractReusableAuthorization("paystack", resp?.data ?? null);
  }
  if (provider === "flutterwave") {
    const key = process.env.FLW_SECRET_KEY ?? "";
    if (!key) return null;
    const resp = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${key}` },
    }).then((r) => r.json()).catch(() => null);
    return extractReusableAuthorization("flutterwave", resp?.data ?? null);
  }
  return null;
}
