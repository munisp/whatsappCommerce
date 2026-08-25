/**
 * W31 vendor-bills (Coder A) — Vendor Bills AP inbox service layer.
 *
 * Lifecycle: capture (photo/pdf/whatsapp/manual/odoo) → OCR extraction
 * (shared receipt-vision pipeline) → pending → recordPayment debits the
 * merchant wallet via the post-W30 locked pattern (SELECT ... FOR UPDATE +
 * atomic conditional decrement + unique payment_ref idempotency anchor on
 * wallet_tx) → partially_paid / paid (honest vocabulary — 'paid' only after
 * the ledger write commits) → Odoo outbox enqueue on paid (queued honestly
 * when Odoo isn't configured).
 *
 * All money is INTEGER CENTS. wallet_tx reference format: `vbill:<billId>`
 * (partials use `vbill:<billId>:part:<seq>` or an explicit caller ref).
 */
import crypto from "crypto";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { merchantWallets, vendorBillEvents, vendorBills, walletTransactions } from "../../drizzle/schema";

type Db = any;
type Tx = any;

/** Statuses from which a payment can be recorded. */
const PAYABLE_STATUSES = ["pending", "scheduled", "approved", "overdue", "partially_paid"] as const;

/** wallet_tx unique-ref violation (wallet_tx_wallet_ref_uniq, migration 0053). */
export function isWalletRefUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code !== "23505") return false;
  const hay = `${e.constraint ?? ""} ${e.message ?? ""}`;
  return hay.includes("wallet_tx_wallet_ref_uniq");
}

async function getOrCreateWallet(db: Db, tenantId: string) {
  const [existing] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  if (existing) return existing;
  const id = crypto.randomUUID();
  await db.insert(merchantWallets).values({
    id, tenantId, currency: "NGN",
    availableBalance: "0", escrowBalance: "0",
    totalEarned: "0", totalWithdrawn: "0",
    custodyMode: "psp", isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing();
  const [created] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  return created!;
}

export async function appendBillEvent(
  db: Db | Tx,
  billId: string,
  event: string,
  actor: string | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db.insert(vendorBillEvents).values({
    id: crypto.randomUUID(), billId, event, actor, metadata: metadata ?? null, createdAt: new Date(),
  });
}

// ─── Creation / capture ─────────────────────────────────────────────────────

export interface CreateVendorBillInput {
  tenantId: string;
  vendorName?: string | null;
  vendorContact?: Record<string, unknown> | null;
  billNumber?: string | null;
  description?: string | null;
  amountCents?: number | null;
  currency?: string;
  issueDate?: Date | null;
  dueDate?: Date | null;
  captureSource?: "photo" | "pdf" | "whatsapp" | "manual" | "odoo";
  captureMediaKey?: string | null;
  captureImage?: { base64: string; mimeType: "image/jpeg" | "image/png" | "image/webp" } | null;
  actor?: string | null;
}

export interface VendorBillCreated {
  bill: typeof vendorBills.$inferSelect;
  reviewRequired: boolean;
  ocrConfidence: number | null;
}

/**
 * Create a vendor bill. When captureImage (or captureMediaKey) is supplied the
 * shared receipt-vision OCR pipeline extracts vendor/amount/date; explicit
 * fields always win over OCR. Low-confidence extractions are stored honestly
 * (ocrConfidence + ocrRaw) and flagged reviewRequired — never silently
 * "corrected".
 */
export async function createVendorBill(db: Db, input: CreateVendorBillInput): Promise<VendorBillCreated> {
  let ocrConfidence: number | null = null;
  let ocrRaw: Record<string, unknown> | null = null;
  let reviewRequired = false;
  let vendorName = input.vendorName ?? null;
  let amountCents = input.amountCents ?? null;
  let issueDate = input.issueDate ?? null;
  let billNumber = input.billNumber ?? null;

  if (input.captureImage || input.captureMediaKey) {
    const { analyzeReceiptImage, parseReceiptAmount } = await import("./receiptVision");
    const { parseExpenseDate } = await import("./bookkeeping");
    let scan: Awaited<ReturnType<typeof analyzeReceiptImage>> | null = null;
    if (input.captureImage) {
      scan = await analyzeReceiptImage(input.captureImage.base64, input.captureImage.mimeType);
    } else if (input.captureMediaKey) {
      const media = await downloadWaMedia(input.tenantId, input.captureMediaKey);
      if (media) {
        const mime = (["image/jpeg", "image/png", "image/webp"].includes(media.mimeType)
          ? media.mimeType : "image/jpeg") as "image/jpeg" | "image/png" | "image/webp";
        scan = await analyzeReceiptImage(media.base64, mime);
      }
    }
    if (scan) {
      ocrConfidence = typeof scan.confidence === "number" ? scan.confidence : null;
      ocrRaw = {
        keyFields: scan.keyFields ?? {},
        extractedText: (scan.extractedText ?? "").slice(0, 8000),
        isReadable: scan.isReadable,
        clarityScore: scan.clarityScore,
        documentType: scan.documentType,
      };
      const kf = (scan.keyFields ?? {}) as Record<string, string>;
      const pick = (...keys: string[]) => {
        for (const [k, v] of Object.entries(kf)) {
          if (v && keys.some((want) => k.toLowerCase().includes(want))) return v;
        }
        return null;
      };
      if (!vendorName) vendorName = (pick("seller", "vendor", "supplier", "merchant") ?? "").trim().slice(0, 160) || null;
      if (!billNumber) billNumber = (pick("invoice", "order number", "bill", "reference") ?? "").trim().slice(0, 64) || null;
      if (amountCents == null) {
        const { toCents } = await import("./bookkeeping");
        const amountMajor = parseReceiptAmount(kf.amount ?? null) ?? parseReceiptAmount(scan.extractedText);
        if (amountMajor != null && amountMajor > 0) amountCents = toCents(amountMajor);
      }
      if (!issueDate) {
        const raw = pick("due") ?? pick("date");
        issueDate = raw ? parseExpenseDate(raw, new Date()) : null;
      }
      // receiptVision confidence is a 0-100 score; below 60 → honest review flag.
      if (!scan.isReadable || (ocrConfidence != null && ocrConfidence < 60) || amountCents == null) {
        reviewRequired = true;
      }
    } else {
      reviewRequired = true; // media unreadable / OCR failed — honest flag
    }
  }

  if (!vendorName) throw new Error("vendorName is required (OCR could not extract one)");
  if (amountCents == null || amountCents <= 0) {
    throw new Error("amountCents must be a positive integer (OCR could not extract an amount)");
  }

  const [bill] = await db.insert(vendorBills).values({
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    vendorName,
    vendorContact: input.vendorContact ?? null,
    billNumber,
    description: input.description ?? null,
    amountCents,
    currency: (input.currency ?? "NGN").slice(0, 3),
    issueDate,
    dueDate: input.dueDate ?? null,
    status: "pending",
    paidCents: 0,
    captureSource: input.captureSource ?? (input.captureImage || input.captureMediaKey ? "photo" : "manual"),
    captureMediaKey: input.captureMediaKey ?? null,
    ocrConfidence: ocrConfidence != null ? String(ocrConfidence) : null,
    ocrRaw,
    createdBy: input.actor ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();
  await appendBillEvent(db, bill.id, input.captureImage || input.captureMediaKey ? "captured" : "created", input.actor ?? null, {
    captureSource: bill.captureSource,
    reviewRequired,
    ocrConfidence,
  });
  return { bill, reviewRequired, ocrConfidence };
}

// ─── Payment (locked wallet debit) ─────────────────────────────────────────

export interface RecordPaymentResult {
  ok: true;
  billId: string;
  status: string;
  paidCents: number;
  amountCents: number;
  chargedCents: number;
  paymentRef: string;
  walletTxId?: string;
  duplicate?: boolean;
  approvalRequired?: boolean;
  approvalId?: string;
}

/**
 * Record a (full or partial) payment against a vendor bill with a REAL
 * wallet debit. Mirrors the post-W30 locked withdrawal pattern:
 *   - the bill row is re-checked inside the transaction,
 *   - the wallet balance is decremented by a single atomic conditional
 *     UPDATE (available_balance >= amount) — insufficient balance fails the
 *     whole transaction honestly with INSUFFICIENT_FUNDS and nothing moves,
 *   - wallet_tx (wallet_id, reference) unique index is the idempotency
 *     anchor: a replayed payment_ref returns the original result
 *     (duplicate:true) with no second debit.
 */
export async function recordVendorBillPayment(
  db: Db,
  opts: {
    tenantId: string;
    billId: string;
    amountCents?: number | null;
    paymentRef?: string | null;
    actor?: string | null;
    approvalId?: string | null;
  },
): Promise<RecordPaymentResult> {
  const [bill] = await db.select().from(vendorBills)
    .where(and(eq(vendorBills.id, opts.billId), eq(vendorBills.tenantId, opts.tenantId)));
  if (!bill) throw Object.assign(new Error("Vendor bill not found"), { code: "NOT_FOUND" });
  if (bill.status === "paid") {
    // Honest idempotent surface: a paid bill cannot be paid again.
    throw Object.assign(new Error(`Bill is already paid (ref ${bill.paymentRef ?? "n/a"})`), { code: "CONFLICT" });
  }
  if (bill.status === "cancelled") {
    throw Object.assign(new Error("Bill is cancelled"), { code: "CONFLICT" });
  }
  // An approval execution re-invokes with approvalId from the
  // 'pending_approval' parked state — that state is payable ONLY then.
  const payable: readonly string[] = opts.approvalId ? [...PAYABLE_STATUSES, "pending_approval"] : PAYABLE_STATUSES;
  if (!payable.includes(bill.status)) {
    throw Object.assign(new Error(`Bill status "${bill.status}" cannot accept a payment`), { code: "CONFLICT" });
  }
  const remaining = bill.amountCents - bill.paidCents;
  const amountCents = opts.amountCents ?? remaining;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw Object.assign(new Error("amountCents must be a positive integer"), { code: "BAD_REQUEST" });
  }
  if (amountCents > remaining) {
    throw Object.assign(new Error(`amountCents exceeds remaining balance (${remaining})`), { code: "BAD_REQUEST" });
  }

  // ── W31 approval contract (Coder C collaboration) ──────────────────────
  // If the approvals module + a tenant policy exist and this amount crosses
  // the threshold, the bill honestly parks in 'pending_approval' and NO
  // money moves; approval execution re-invokes this procedure with
  // approvalId to bypass the gate. When the module isn't merged yet the
  // dynamic import fails and this block is a no-op.
  if (!opts.approvalId) {
    try {
      // Non-literal specifier: the module may not exist on this branch yet.
      const approvalsModule = "./approvals";
      const approvals: any = await import(approvalsModule);
      const res = await approvals?.requireApprovalIfNeeded?.(
        opts.tenantId, "vendor_bill_payment", amountCents, opts.billId, db,
      );
      if (res?.approvalRequired) {
        await db.update(vendorBills)
          .set({ status: "pending_approval", approvalId: res.approvalId, updatedAt: new Date() })
          .where(and(eq(vendorBills.id, bill.id), eq(vendorBills.tenantId, opts.tenantId)));
        await appendBillEvent(db, bill.id, "approval_requested", opts.actor ?? null, {
          approvalId: res.approvalId, amountCents,
        });
        return {
          ok: true, billId: bill.id, status: "pending_approval",
          paidCents: bill.paidCents, amountCents: bill.amountCents, chargedCents: 0,
          paymentRef: "", approvalRequired: true, approvalId: res.approvalId,
        };
      }
    } catch {
      // approvals module not on this branch yet → gate no-ops.
    }
  }

  // Deterministic reference: explicit caller ref (idempotency key) wins;
  // otherwise `vbill:<billId>` for a one-shot full payment, or
  // `vbill:<billId>:part:<seq>` for partial payments.
  let ref = opts.paymentRef ?? null;
  if (!ref) {
    if (amountCents === remaining && bill.paidCents === 0) {
      ref = `vbill:${bill.id}`;
    } else {
      const prior = await db.select({ id: vendorBillEvents.id }).from(vendorBillEvents)
        .where(and(eq(vendorBillEvents.billId, bill.id), eq(vendorBillEvents.event, "payment_recorded")));
      ref = `vbill:${bill.id}:part:${prior.length + 1}`;
    }
  }

  const wallet = await getOrCreateWallet(db, opts.tenantId);
  const walletTxId = crypto.randomUUID();

  try {
    await db.transaction(async (tx: Tx) => {
      // Lock the wallet row FIRST so concurrent writers serialize here.
      const locked = await tx.execute(sql`SELECT available_balance, currency FROM merchant_wallets WHERE id = ${wallet.id} FOR UPDATE`);
      const lrow = (locked as unknown as Record<string, unknown>[])[0];
      if (!lrow) throw new Error("Wallet not found");
      const currency = String(lrow.currency ?? "NGN");

      // Idempotent replay short-circuit (inside the lock).
      const [dup] = await tx.select({ id: walletTransactions.id }).from(walletTransactions)
        .where(and(eq(walletTransactions.walletId, wallet.id), eq(walletTransactions.reference, ref)));
      if (dup) throw new VendorBillDuplicatePaymentError();

      // Re-check the bill inside the transaction (status/paidCents drift).
      const [fresh] = await tx.select().from(vendorBills)
        .where(and(eq(vendorBills.id, bill.id), eq(vendorBills.tenantId, opts.tenantId)));
      if (!fresh || !payable.includes(fresh.status)) {
        throw Object.assign(new Error(`Bill status "${fresh?.status ?? "missing"}" cannot accept a payment`), { code: "CONFLICT" });
      }
      const freshRemaining = fresh.amountCents - fresh.paidCents;
      if (amountCents > freshRemaining) {
        throw Object.assign(new Error(`amountCents exceeds remaining balance (${freshRemaining})`), { code: "BAD_REQUEST" });
      }

      // Atomic conditional debit — balance check + decrement in ONE UPDATE.
      const debited = await tx.execute(sql`
        UPDATE merchant_wallets
        SET available_balance = available_balance - ${(amountCents / 100).toFixed(2)}::numeric,
            total_withdrawn = total_withdrawn + ${(amountCents / 100).toFixed(2)}::numeric,
            updated_at = now()
        WHERE id = ${wallet.id}
          AND available_balance >= ${(amountCents / 100).toFixed(2)}::numeric
        RETURNING available_balance
      `);
      const drow = (debited as unknown as Record<string, unknown>[])[0];
      if (!drow) {
        throw Object.assign(
          new Error("INSUFFICIENT_FUNDS: wallet available balance is too low for this payment"),
          { code: "BAD_REQUEST" },
        );
      }
      const after = parseFloat(String(drow.available_balance));
      const before = after + amountCents / 100;

      await tx.insert(walletTransactions).values({
        id: walletTxId,
        walletId: wallet.id,
        tenantId: opts.tenantId,
        type: "withdrawal",
        amount: (amountCents / 100).toFixed(2),
        balanceBefore: before.toFixed(2),
        balanceAfter: after.toFixed(2),
        currency,
        description: `Vendor bill payment to ${fresh.vendorName}${fresh.billNumber ? ` (bill ${fresh.billNumber})` : ""}`,
        reference: ref,
        metadata: { source: "vendor_bill_payment", billId: bill.id, status: "executed" },
        createdAt: new Date(),
      });

      const newPaid = fresh.paidCents + amountCents;
      const newStatus = newPaid >= fresh.amountCents ? "paid" : "partially_paid";
      await tx.update(vendorBills).set({
        paidCents: newPaid,
        status: newStatus,
        paymentRef: fresh.paymentRef ?? ref,
        updatedAt: new Date(),
      }).where(eq(vendorBills.id, fresh.id));
      await appendBillEvent(tx, bill.id, "payment_recorded", opts.actor ?? null, {
        paymentRef: ref, walletTxId, chargedCents: amountCents,
        paidCents: newPaid, resultingStatus: newStatus,
        ...(opts.approvalId ? { approvalId: opts.approvalId } : {}),
      });
    });
  } catch (err: any) {
    if (err instanceof VendorBillDuplicatePaymentError || isWalletRefUniqueViolation(err)) {
      // Idempotent replay: the original payment already committed; return it
      // without a second debit.
      const [existing] = await db.select().from(walletTransactions)
        .where(and(eq(walletTransactions.walletId, wallet.id), eq(walletTransactions.reference, ref)));
      const [current] = await db.select().from(vendorBills).where(eq(vendorBills.id, bill.id));
      if (existing && current) {
        return {
          ok: true, billId: bill.id, status: current.status,
          paidCents: current.paidCents, amountCents: current.amountCents,
          chargedCents: 0, paymentRef: ref, walletTxId: existing.id, duplicate: true,
        };
      }
    }
    throw err;
  }

  const [updated] = await db.select().from(vendorBills).where(eq(vendorBills.id, bill.id));

  // Odoo hook (fire-and-forget, honest): enqueue the paid bill into the
  // outbox; if Odoo isn't configured the row simply stays queued.
  if (updated.status === "paid") {
    try {
      const { onVendorBillPaid } = await import("./odoo/sync");
      await onVendorBillPaid(db, opts.tenantId, updated);
      await db.update(vendorBills).set({ odooSyncState: "queued", updatedAt: new Date() })
        .where(eq(vendorBills.id, bill.id));
    } catch (e: any) {
      console.warn("[vendorBills] odoo outbox enqueue failed (bill stays paid, sync pending):", e?.message);
    }
  }

  return {
    ok: true, billId: bill.id, status: updated.status,
    paidCents: updated.paidCents, amountCents: updated.amountCents,
    chargedCents: amountCents, paymentRef: ref, walletTxId,
  };
}

/** Internal control-flow signal: a same-reference payment already exists. */
export class VendorBillDuplicatePaymentError extends Error {
  constructor() { super("vendor_bill_duplicate_payment_ref"); }
}

// ─── Overdue sweep ──────────────────────────────────────────────────────────

/**
 * Flip unpaid/partially-paid bills whose due_date has passed to 'overdue'
 * (guarded UPDATE — safe to run repeatedly / concurrently). Returns the ids
 * flipped by THIS call.
 */
export async function sweepOverdueVendorBills(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<{ flipped: number; billIds: string[] }> {
  const rows = await db.update(vendorBills)
    .set({ status: "overdue", updatedAt: now })
    .where(and(
      eq(vendorBills.tenantId, tenantId),
      inArray(vendorBills.status, ["pending", "scheduled", "approved", "partially_paid"]),
      isNotNull(vendorBills.dueDate),
      lt(vendorBills.dueDate, now),
    ))
    .returning({ id: vendorBills.id });
  for (const r of rows) {
    await appendBillEvent(db, r.id, "overdue", "system:sweep", { sweptAt: now.toISOString() });
  }
  return { flipped: rows.length, billIds: rows.map((r: any) => r.id) };
}

/** Overdue summary for digests / dashboards (read-only). */
export async function overdueBillSummary(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<{ count: number; totalCents: number }> {
  const rows = await db.select({
    amountCents: vendorBills.amountCents,
    paidCents: vendorBills.paidCents,
  }).from(vendorBills)
    .where(and(
      eq(vendorBills.tenantId, tenantId),
      inArray(vendorBills.status, ["overdue", "pending", "scheduled", "approved", "partially_paid"]),
      isNotNull(vendorBills.dueDate),
      lt(vendorBills.dueDate, now),
    ));
  return {
    count: rows.length,
    totalCents: rows.reduce((acc: number, r: any) => acc + (r.amountCents - r.paidCents), 0),
  };
}

// ─── WhatsApp capture path ─────────────────────────────────────────────────

/** Download a WhatsApp media object, base64-encoded (same pattern as bookkeeping). */
export async function downloadWaMedia(tenantId: string, mediaId: string): Promise<{ base64: string; mimeType: string } | null> {
  const { resolveTenantWaCredentials } = await import("./waSender");
  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) return null;
  const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  }).then((r: any) => (r.ok ? r.json() : null)).catch(() => null);
  const url: string | undefined = (meta as any)?.url;
  if (!url) return null;
  const bin = await fetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` } })
    .then((r: any) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  if (!bin) return null;
  const mimeType = ((meta as any)?.mime_type ?? "image/jpeg") as string;
  return { base64: Buffer.from(bin).toString("base64"), mimeType };
}

export interface VendorBillImageOutcome {
  handled: boolean;
  outcome?: "captured" | "review" | "download_failed" | "ocr_failed" | "no_fields";
  billId?: string;
}

/**
 * Inbound image hook (W31): claims the image only when its caption marks it
 * as a supplier bill/invoice forward (e.g. "bill", "invoice from Musa");
 * otherwise returns handled:false so the stocktake/visual-search chain
 * proceeds unchanged. Never throws at the webhook layer.
 */
export async function handleInboundVendorBillImage(opts: {
  tenantId: string;
  waPhoneNumber: string;
  mediaId: string;
  caption?: string | null;
}): Promise<VendorBillImageOutcome> {
  const caption = (opts.caption ?? "").trim();
  if (!/^(bill|invoice|supplier invoice)\b/i.test(caption)) return { handled: false };

  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) return { handled: false };
  const { sendWhatsAppText } = await import("./waSender");
  const { formatNairaExact } = await import("./bookkeeping");

  const media = await downloadWaMedia(opts.tenantId, opts.mediaId);
  if (!media) {
    await sendWhatsAppText(opts.tenantId, opts.waPhoneNumber,
      "⚠️ I couldn't download that invoice image. Please forward it again in good light.")
      .catch(() => {});
    return { handled: true, outcome: "download_failed" };
  }
  let created: VendorBillCreated;
  try {
    const mime = (["image/jpeg", "image/png", "image/webp"].includes(media.mimeType)
      ? media.mimeType : "image/jpeg") as "image/jpeg" | "image/png" | "image/webp";
    created = await createVendorBill(db, {
      tenantId: opts.tenantId,
      captureSource: "whatsapp",
      captureMediaKey: opts.mediaId,
      captureImage: { base64: media.base64, mimeType: mime },
      description: caption.length > 4 ? caption : null,
      actor: `wa:${opts.waPhoneNumber}`,
    });
  } catch (e: any) {
    console.warn("[vendorBills] whatsapp capture failed:", e?.message);
    await sendWhatsAppText(opts.tenantId, opts.waPhoneNumber,
      "⚠️ I couldn't read that invoice — I couldn't find the vendor or amount. Send a clearer photo or add the bill manually from the dashboard.")
      .catch(() => {});
    return { handled: true, outcome: "ocr_failed" };
  }

  const b = created.bill;
  const reviewNote = created.reviewRequired
    ? "\n⚠️ Low-confidence scan — please review the extracted fields in the dashboard before paying."
    : "";
  await sendWhatsAppText(opts.tenantId, opts.waPhoneNumber,
    `🧾 Vendor bill captured: ${b.vendorName} — ${formatNairaExact(b.amountCents, b.currency)}` +
    `${b.dueDate ? `, due ${b.dueDate.toISOString().slice(0, 10)}` : ""}` +
    `${b.billNumber ? ` (ref ${b.billNumber})` : ""}.${reviewNote}\nReply "pay bill ${b.billNumber ?? b.id.slice(0, 8)}" to pay it from your wallet.`)
    .catch(() => {});
  return { handled: true, outcome: created.reviewRequired ? "review" : "captured", billId: b.id };
}

// ─── W31 merger seam: approval executor for kind "vendor_bill_payment" ─────
// Approval execution re-invokes the normal locked payment path with the
// approvalId (which admits the parked 'pending_approval' state). Idempotency
// stays the vbill:<billId> payment_ref unique anchor.
import { registerApprovalExecutor } from "./approvals";
registerApprovalExecutor("vendor_bill_payment", async ({ approval, db }) => {
  try {
    if (!approval.targetId) return { ok: false, detail: "approval has no vendor-bill target" };
    const res = await recordVendorBillPayment(db as never, {
      tenantId: approval.tenantId,
      billId: approval.targetId,
      amountCents: approval.amountCents,
      approvalId: approval.id,
      actor: approval.decidedBy ?? approval.requestedBy,
    });
    return { ok: true, reference: res.paymentRef };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
});
