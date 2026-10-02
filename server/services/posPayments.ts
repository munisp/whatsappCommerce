// === W59 banking-pos ===
/**
 * W59 banking-pos (Feature 3) — POS payment sessions.
 *
 * Flow: the platform creates a session (amount + unique reference embedding
 * a 6-digit USSD short code) → the terminal does the card read (physical
 * terminal push, or softPOS SDK NFC — NO PAN ever touches the platform, see
 * docs/softpos-integration.md) → the provider webhook confirms → we settle
 * claim-first into the merchant wallet → post-commit chat receipt via the
 * receipts seam (sendOrderReceipt when the session carries an orderId).
 *
 * Contracts:
 *  - reference = `POS-<code6>-<rand8>` — unique (pos_payment_sessions_ref_uniq)
 *    and embeds the USSD short code so `pay by pos <code>` resolves without
 *    an extra column.
 *  - confirm is claim-first: UPDATE ... WHERE status='awaiting' — exactly
 *    one webhook wins; replays report duplicate and never double-settle.
 *  - settlement credits the merchant PSP wallet with a wallet_tx row
 *    (reference `pos:<sessionReference>`, wallet_tx_wallet_ref_uniq backstop)
 *    in the SAME transaction as the status flip.
 *  - webhook signature verify is FAIL-CLOSED per provider (Paystack HMAC
 *    x-paystack-signature; Flutterwave verif-hash; softpos HMAC
 *    x-softpos-signature) — an unset secret rejects in production.
 *  - expiry sweep flips awaiting→expired (releases the session claim);
 *    idempotent.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  merchantPosTerminals,
  merchantWallets,
  posPaymentSessions,
  walletTransactions,
} from "../../drizzle/schema";

type Db = any;

export type PosChannel = "physical" | "softpos" | "ussd_ref";
export type PosProvider = "paystack" | "flutterwave" | "softpos";

const SESSION_TTL_MINUTES = 15;

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** 6-digit USSD short code, deterministic from the random suffix. */
function shortCode(rand: string): string {
  const h = createHmac("sha256", "w59-pos-code").update(rand).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

// ─── Terminals ──────────────────────────────────────────────────────────────

export async function listTerminals(db: Db, tenantId: string) {
  return db.select().from(merchantPosTerminals)
    .where(eq(merchantPosTerminals.tenantId, tenantId))
    .orderBy(merchantPosTerminals.createdAt);
}

export async function registerTerminal(db: Db, input: {
  tenantId: string;
  provider: PosProvider;
  terminalRef: string;
  label?: string;
  storeLocation?: string;
}) {
  if (!["paystack", "flutterwave", "softpos"].includes(input.provider)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "provider must be paystack | flutterwave | softpos" });
  }
  const [existing] = await db.select().from(merchantPosTerminals)
    .where(and(eq(merchantPosTerminals.tenantId, input.tenantId), eq(merchantPosTerminals.provider, input.provider),
      eq(merchantPosTerminals.terminalRef, input.terminalRef)));
  if (existing) return { terminal: existing, duplicate: true };
  try {
    const [row] = await db.insert(merchantPosTerminals).values({
      tenantId: input.tenantId,
      provider: input.provider,
      terminalRef: input.terminalRef,
      label: input.label ?? null,
      storeLocation: input.storeLocation ?? null,
      status: "active",
    }).returning();
    return { terminal: row, duplicate: false };
  } catch (err: any) {
    if (String(err?.code) === "23505") {
      const [row] = await db.select().from(merchantPosTerminals)
        .where(and(eq(merchantPosTerminals.tenantId, input.tenantId), eq(merchantPosTerminals.provider, input.provider),
          eq(merchantPosTerminals.terminalRef, input.terminalRef)));
      if (row) return { terminal: row, duplicate: true };
    }
    throw err;
  }
}

export async function setTerminalStatus(db: Db, tenantId: string, terminalId: string, status: "active" | "disabled") {
  const [row] = await db.update(merchantPosTerminals).set({ status, updatedAt: new Date() })
    .where(and(eq(merchantPosTerminals.id, terminalId), eq(merchantPosTerminals.tenantId, tenantId)))
    .returning();
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "terminal not found" });
  return { terminal: row };
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export interface PosSessionCreated {
  sessionId: string;
  reference: string;
  ussdCode: string;
  qrPayload: string;
  amountCents: number;
  channel: PosChannel;
  expiresAt: Date;
  pushed: boolean;
}

export async function createSession(db: Db, input: {
  tenantId: string;
  amountCents: number;
  channel: PosChannel;
  orderId?: string;
  terminalId?: string;
  ttlMinutes?: number;
}): Promise<PosSessionCreated> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "amountCents must be a positive integer" });
  }
  if (!["physical", "softpos", "ussd_ref"].includes(input.channel)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "channel must be physical | softpos | ussd_ref" });
  }
  let terminal: any = null;
  if (input.terminalId) {
    [terminal] = await db.select().from(merchantPosTerminals)
      .where(and(eq(merchantPosTerminals.id, input.terminalId), eq(merchantPosTerminals.tenantId, input.tenantId)));
    if (!terminal) throw new TRPCError({ code: "NOT_FOUND", message: "terminal not found" });
    if (terminal.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "terminal is disabled" });
  }
  const rand = crypto.randomUUID().slice(0, 8);
  const code = shortCode(rand);
  const reference = `POS-${code}-${rand}`.slice(0, 64);
  const expiresAt = new Date(Date.now() + (input.ttlMinutes ?? SESSION_TTL_MINUTES) * 60_000);
  const [row] = await db.insert(posPaymentSessions).values({
    tenantId: input.tenantId,
    orderId: input.orderId ?? null,
    amountCents: input.amountCents,
    reference,
    status: "awaiting",
    channel: input.channel,
    terminalId: terminal?.id ?? null,
    expiresAt,
  }).returning();

  // QR payload string: a self-describing payment URI the softPOS SDK / payer
  // scanner resolves (amount in MAJOR units at the boundary).
  const qrPayload = `expresspay://pos/pay?ref=${encodeURIComponent(reference)}&amt=${(input.amountCents / 100).toFixed(2)}&cur=NGN&t=${encodeURIComponent(input.tenantId)}`;

  // Terminal push (physical channel) — best-effort adapter; a push failure
  // never fails session creation (payer can still use the USSD code / QR).
  let pushed = false;
  if (terminal && input.channel === "physical") {
    pushed = await pushSessionToTerminal(terminal.provider, terminal.terminalRef, {
      reference, amountCents: input.amountCents, currency: "NGN",
    }).catch(() => false);
  }
  return { sessionId: row.id, reference, ussdCode: code, qrPayload, amountCents: input.amountCents, channel: input.channel, expiresAt, pushed };
}

/** Terminal push adapter — Paystack Terminal event API shape. Fail-open. */
export async function pushSessionToTerminal(
  provider: PosProvider,
  terminalRef: string,
  session: { reference: string; amountCents: number; currency: string },
): Promise<boolean> {
  try {
    if (provider === "paystack") {
      const key = process.env.PAYSTACK_SECRET_KEY ?? "";
      if (!key) return false;
      const res = await fetch("https://api.paystack.co/terminal/event", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "transaction",
          action: "process",
          data: { id: terminalRef, reference: session.reference, amount: session.amountCents, currency: session.currency },
        }),
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    }
    if (provider === "flutterwave") {
      const key = process.env.FLUTTERWAVE_SECRET_KEY ?? "";
      if (!key) return false;
      const res = await fetch("https://api.flutterwave.com/v3/terminal/event", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ terminal_ref: terminalRef, reference: session.reference, amount: session.amountCents / 100, currency: session.currency }),
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    }
    // softpos: the SDK polls/pulls sessions — no push channel.
    return true;
  } catch {
    return false;
  }
}

/** Resolve an awaiting session by its 6-digit USSD short code (tenant-scoped). */
export async function findSessionByUssdCode(db: Db, tenantId: string, code: string) {
  const clean = code.replace(/[^\d]/g, "");
  if (clean.length !== 6) return null;
  const [row] = await db.select().from(posPaymentSessions)
    .where(and(eq(posPaymentSessions.tenantId, tenantId), eq(posPaymentSessions.status, "awaiting"),
      sql`${posPaymentSessions.reference} LIKE ${`POS-${clean}-%`}`))
    .orderBy(desc(posPaymentSessions.createdAt))
    .limit(1);
  return row ?? null;
}

// ─── Webhook verification (fail-closed per provider) ───────────────────────

export function verifyPosWebhookSignature(provider: string, rawBody: Buffer, headers: Record<string, unknown>): boolean {
  if (provider === "paystack") {
    const key = process.env.PAYSTACK_SECRET_KEY ?? "";
    if (!key) return false;
    const sig = String(headers["x-paystack-signature"] ?? "");
    const expected = createHmac("sha512", key).update(rawBody).digest("hex");
    return !!sig && timingSafeEqualStr(sig, expected);
  }
  if (provider === "flutterwave") {
    const secret = process.env.FLW_WEBHOOK_SECRET ?? "";
    if (!secret) return false;
    const sig = String(headers["verif-hash"] ?? "");
    return !!sig && timingSafeEqualStr(sig, secret);
  }
  if (provider === "softpos") {
    const secret = process.env.POS_SOFTPOS_WEBHOOK_SECRET ?? "";
    if (!secret) return false;
    const sig = String(headers["x-softpos-signature"] ?? "");
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return !!sig && timingSafeEqualStr(sig, expected);
  }
  return false;
}

/** Extract the session reference + terminal status from a provider payload. */
export function extractPosWebhookEvent(provider: string, payload: any): { reference: string; ok: boolean } | null {
  if (provider === "paystack") {
    if (payload?.event !== "charge.success" && payload?.event !== "terminal.transaction") return null;
    const reference = payload?.data?.reference;
    const ok = payload?.data?.status === "success" || payload?.event === "terminal.transaction";
    return typeof reference === "string" ? { reference, ok } : null;
  }
  if (provider === "flutterwave") {
    if (payload?.event !== "charge.completed") return null;
    const reference = payload?.data?.tx_ref ?? payload?.data?.reference;
    return typeof reference === "string" ? { reference, ok: payload?.data?.status === "successful" } : null;
  }
  if (provider === "softpos") {
    const reference = payload?.reference ?? payload?.data?.reference;
    return typeof reference === "string" ? { reference, ok: payload?.status === "charged" || payload?.data?.status === "charged" } : null;
  }
  return null;
}

// ─── Settlement (claim-first) ───────────────────────────────────────────────

export interface PosConfirmResult {
  reference: string;
  status: "charged" | "failed";
  duplicate: boolean;
  settledCents: number;
}

export async function confirmSession(db: Db, reference: string, ok: boolean): Promise<PosConfirmResult> {
  const result = await db.transaction(async (tx: Db) => {
    // Claim-first: exactly one caller flips awaiting → charged|failed.
    const claim = await tx.execute(sql`
      UPDATE pos_payment_sessions
      SET status = ${ok ? "charged" : "failed"}, "updatedAt" = now()
      WHERE reference = ${reference} AND status = 'awaiting'
      RETURNING id, "tenantId", "orderId", "amountCents"`);
    const row = (Array.isArray(claim) ? claim : (claim as any).rows ?? [])[0];
    if (!row) return null; // already finalized / unknown reference
    let settledCents = 0;
    if (ok) {
      const [wallet] = await tx.select().from(merchantWallets).where(eq(merchantWallets.tenantId, row.tenantId));
      let walletId: string = wallet?.id ?? "";
      if (!walletId) {
        walletId = crypto.randomUUID();
        await tx.insert(merchantWallets).values({ id: walletId, tenantId: row.tenantId, custodyMode: "psp" }).onConflictDoNothing();
        const [created] = await tx.select().from(merchantWallets).where(eq(merchantWallets.tenantId, row.tenantId));
        walletId = created.id as string;
      }
      const amountCents = Number(row.amountCents);
      const amountMajor = (amountCents / 100).toFixed(2);
      const lock = await tx.execute(sql`SELECT available_balance FROM merchant_wallets WHERE id = ${walletId} FOR UPDATE`);
      const before = parseFloat(String((Array.isArray(lock) ? lock : (lock as any).rows ?? [])[0].available_balance));
      await tx.update(merchantWallets).set({
        availableBalance: sql`${merchantWallets.availableBalance} + ${amountMajor}::numeric`,
        totalEarned: sql`${merchantWallets.totalEarned} + ${amountMajor}::numeric`,
        updatedAt: new Date(),
      }).where(eq(merchantWallets.id, walletId));
      // wallet_tx_type has no pos_credit value (additive-only doctrine);
      // labelled via description + metadata like escrow settlement legs.
      await tx.insert(walletTransactions).values({
        id: crypto.randomUUID(),
        walletId,
        tenantId: row.tenantId,
        type: "escrow_release",
        amount: amountMajor,
        balanceBefore: before.toFixed(2),
        balanceAfter: (before + amountCents / 100).toFixed(2),
        currency: "NGN",
        orderId: row.orderId ?? null,
        description: `POS payment ${reference}`,
        reference: `pos:${reference}`,
        metadata: { source: "pos_payment", posReference: reference },
        createdAt: new Date(),
      });
      settledCents = amountCents;
    }
    return { tenantId: String(row.tenantId), orderId: row.orderId ? String(row.orderId) : null, settledCents };
  });

  if (!result) {
    const [existing] = await db.select().from(posPaymentSessions).where(eq(posPaymentSessions.reference, reference));
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "POS session not found" });
    return { reference, status: existing.status === "charged" ? "charged" : "failed", duplicate: true, settledCents: 0 };
  }

  // Post-commit chat receipt via the receipts seam (fail-open; paymentConfirm.ts
  // is byte-locked, so POS settlement notifies on this adjacent seam).
  if (result.settledCents > 0) {
    void (async () => {
      try {
        if (result.orderId) {
          const { sendOrderReceipt } = await import("./receipts");
          await sendOrderReceipt(db, result.orderId, reference);
        } else {
          const { notifyMerchantPosCharge } = await import("./bankingChat");
          await notifyMerchantPosCharge(db, result.tenantId, reference, result.settledCents);
        }
      } catch (err: any) {
        console.warn("[pos] post-commit receipt failed (fail-open):", err?.message);
      }
    })();
  }
  return { reference, status: ok ? "charged" : "failed", duplicate: false, settledCents: result.settledCents };
}

/** Expiry sweep: awaiting sessions past expiresAt flip to 'expired',
 *  releasing the session claim so the reference can never settle late.
 *  Idempotent. */
export async function sweepExpiredSessions(db: Db, now = new Date()): Promise<{ expired: number }> {
  const res = await db.update(posPaymentSessions).set({ status: "expired", updatedAt: new Date() })
    .where(and(eq(posPaymentSessions.status, "awaiting"), lt(posPaymentSessions.expiresAt, now)))
    .returning({ id: posPaymentSessions.id });
  return { expired: res.length };
}

export async function listSessions(db: Db, tenantId: string, limit = 50) {
  return db.select().from(posPaymentSessions)
    .where(eq(posPaymentSessions.tenantId, tenantId))
    .orderBy(desc(posPaymentSessions.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
}
