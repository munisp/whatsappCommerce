/**
 * Dunning — overdue-credit reminder/fee/freeze sweep.
 *
 * runDunningCheckTx(db, now) scans POSTED invoice_draw ledger rows whose
 * due_date is within the sweep horizon (due in ≤3 days, or already overdue)
 * and applies escalating milestones by days-overdue offset:
 *
 *   offset -3d  → reminder "[dun:r-3]"  (due soon)
 *   offset  0d  → reminder "[dun:r0]"   (due today / just overdue)
 *   offset +3d  → reminder "[dun:r+3]" + late fee "[dun:fee]" — 2% of the
 *                 draw amount, once per draw (ledger 'fee' row,
 *                 ref `latefee:<drawId>`)
 *   offset +7d  → reminder "[dun:r+7]" + freeze the credit_account
 *                 (status='frozen', claim-first)
 *
 * IDEMPOTENCY: each milestone is gated by a claim-first marker UPDATE —
 *
 *   UPDATE credit_ledger SET note = COALESCE(note,'') || ' [dun:r-3]'
 *   WHERE id=$id AND status='posted'
 *     AND (note IS NULL OR note NOT LIKE '%[dun:r-3]%') RETURNING id
 *
 * Only when the marker lands (row returned) is the reminder sent / fee
 * inserted, so repeated sweeps never double-send or double-fee a draw.
 *
 * Delivery: WhatsApp to the BUYER tenant's admin phone — free-form text
 * while the 24h session window is open (sessionWindow.getWindow), the
 * tenant's configured `creditReminderTemplate` (fallback
 * "credit_due_reminder") template when closed. Every send is fail-safe:
 * failures are logged and the sweep continues — it NEVER throws.
 */
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { creditAccounts, creditLedger, tenants } from "../../../drizzle/schema";
import type { TxHandle } from "./accounts";
import { getWindow } from "../sessionWindow";
import { sendWhatsAppTemplate, sendWhatsAppText } from "../waSender";
import { formatNairaCompact } from "./scoring";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Late fee: 2% of the overdue draw amount, applied once at +3d. */
export const LATE_FEE_RATE = 0.02;
/** Days overdue at which the credit account is frozen. */
export const FREEZE_AFTER_DAYS = 7;
/** Sweep batch size per run. */
const SWEEP_LIMIT = 200;

const MARKERS = {
  remindMinus3: "[dun:r-3]",
  remind0: "[dun:r0]",
  remindPlus3: "[dun:r+3]",
  remindPlus7: "[dun:r+7]",
  fee: "[dun:fee]",
} as const;

export interface DunningResult {
  reminded: number;
  feesApplied: number;
  frozen: number;
}

/** Claim a dunning milestone on a draw row. True ⇒ caller performs the action. */
async function claimMarker(db: TxHandle, drawId: string, marker: string): Promise<boolean> {
  const [row] = await db
    .update(creditLedger)
    .set({ note: sql`COALESCE(${creditLedger.note}, '') || ${" " + marker}` })
    .where(
      and(
        eq(creditLedger.id, drawId),
        eq(creditLedger.status, "posted"),
        sql`(${creditLedger.note} IS NULL OR ${creditLedger.note} NOT LIKE ${"%" + marker + "%"})`,
      ),
    )
    .returning({ id: creditLedger.id });
  return !!row;
}

function adminPhoneFromSettings(settings: unknown): string | null {
  const s = settings as any;
  const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
  return typeof cand === "string" && cand.trim() ? cand.trim() : null;
}

function reminderTemplateFromSettings(settings: unknown): string {
  const s = settings as any;
  const cand = s?.creditReminderTemplate ?? s?.whatsapp?.creditReminderTemplate;
  return typeof cand === "string" && cand.trim() ? cand.trim() : "credit_due_reminder";
}

/**
 * Send one dunning reminder to the buyer tenant's admin phone. Fail-safe:
 * never throws — returns true when a send was attempted without error.
 */
async function sendReminder(
  db: TxHandle,
  args: {
    buyerTenantId: string;
    amountCents: number;
    dueDate: Date;
    offsetDays: number;
    frozen: boolean;
  },
): Promise<boolean> {
  try {
    const [tenant] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, args.buyerTenantId))
      .limit(1);
    const phone = adminPhoneFromSettings(tenant?.settings);
    if (!phone) {
      console.warn(`[tradeCredit/dunning] no admin phone for buyer tenant ${args.buyerTenantId} — reminder skipped`);
      return false;
    }
    const amount = formatNairaCompact(args.amountCents);
    const due = args.dueDate.toISOString().slice(0, 10);
    const overdueBy = args.offsetDays > 0 ? ` (${args.offsetDays}d overdue)` : "";
    const body =
      `Credit reminder: your outstanding invoice draw of ${amount} was due ${due}${overdueBy}. ` +
      `Please repay to keep your trade credit facility in good standing.` +
      (args.frozen ? ` Your credit facility has been FROZEN until repayment.` : "");

    // Free-form inside the 24h session window; template outside it.
    const win = await getWindow(db as any, args.buyerTenantId, phone);
    if (win.open) {
      await sendWhatsAppText(args.buyerTenantId, phone, body, { notifType: "credit_dunning" });
    } else {
      await sendWhatsAppTemplate(args.buyerTenantId, phone, reminderTemplateFromSettings(tenant?.settings), "en", [
        {
          type: "body",
          parameters: [
            { type: "text", text: amount },
            { type: "text", text: due },
          ],
        },
      ], { notifType: "credit_dunning" });
    }
    return true;
  } catch (err: any) {
    console.error(`[tradeCredit/dunning] reminder send failed (buyer=${args.buyerTenantId}):`, err?.message);
    return false;
  }
}

/**
 * Run one dunning sweep. Never throws into the caller (cron-safe): a
 * failing scan returns zeros, per-row failures are logged and skipped.
 */
export async function runDunningCheckTx(
  db: TxHandle,
  now: Date = new Date(),
): Promise<DunningResult> {
  const result: DunningResult = { reminded: 0, feesApplied: 0, frozen: 0 };
  const horizon = new Date(now.getTime() + 3 * DAY_MS); // -3d window start

  let draws: Array<{
    id: string;
    creditAccountId: string;
    amountCents: number;
    dueDate: Date | null;
  }> = [];
  try {
    draws = await db
      .select({
        id: creditLedger.id,
        creditAccountId: creditLedger.creditAccountId,
        amountCents: creditLedger.amountCents,
        dueDate: creditLedger.dueDate,
      })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.kind, "invoice_draw"),
          eq(creditLedger.status, "posted"),
          isNotNull(creditLedger.dueDate),
          lte(creditLedger.dueDate, horizon),
        ),
      )
      .limit(SWEEP_LIMIT);
  } catch (err: any) {
    console.error("[tradeCredit/dunning] sweep scan failed:", err?.message);
    return result;
  }

  for (const draw of draws) {
    try {
      const dueDate = new Date(draw.dueDate!);
      const offsetDays = Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS);
      if (offsetDays < -3) continue; // outside the -3d window

      const [account] = await db
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.id, draw.creditAccountId))
        .limit(1);
      if (!account || account.status === "closed") continue;

      // +7d: freeze the facility (claim-first) and send the final reminder.
      let justFroze = false;
      if (offsetDays >= FREEZE_AFTER_DAYS && account.status === "active") {
        const [frozenRow] = await db
          .update(creditAccounts)
          .set({ status: "frozen", updatedAt: now })
          .where(and(eq(creditAccounts.id, account.id), eq(creditAccounts.status, "active")))
          .returning({ id: creditAccounts.id });
        if (frozenRow) {
          result.frozen += 1;
          justFroze = true;
        }
      }

      // +3d: late fee, once per draw.
      if (offsetDays >= 3) {
        if (await claimMarker(db, draw.id, MARKERS.fee)) {
          const feeCents = Math.max(1, Math.round(draw.amountCents * LATE_FEE_RATE));
          await db.insert(creditLedger).values({
            creditAccountId: draw.creditAccountId,
            kind: "fee",
            amountCents: feeCents,
            ref: `latefee:${draw.id}`.slice(0, 128),
            note: `Late fee ${LATE_FEE_RATE * 100}% of draw ${draw.id} at +${offsetDays}d overdue`,
          });
          result.feesApplied += 1;
        }
      }

      // Reminder: at most one per draw per sweep — the HIGHEST applicable
      // milestone. Each marker is claimed atomically ⇒ idempotent across
      // sweeps (a draw first seen at offset -2 claims r-3; the next sweep at
      // offset -1 finds it claimed and stays quiet until offset 0).
      const milestones: Array<[number, string]> = [
        [FREEZE_AFTER_DAYS, MARKERS.remindPlus7],
        [3, MARKERS.remindPlus3],
        [0, MARKERS.remind0],
        [-3, MARKERS.remindMinus3],
      ];
      const milestone = milestones.find(([threshold]) => offsetDays >= threshold);
      if (milestone && (await claimMarker(db, draw.id, milestone[1]))) {
        const sent = await sendReminder(db, {
          buyerTenantId: account.buyerTenantId,
          amountCents: draw.amountCents,
          dueDate,
          offsetDays,
          frozen: justFroze || account.status === "frozen",
        });
        if (sent) result.reminded += 1;
      }
    } catch (err: any) {
      console.error(`[tradeCredit/dunning] row ${draw.id} failed:`, err?.message);
    }
  }
  return result;
}
