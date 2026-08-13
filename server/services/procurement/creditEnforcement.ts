/**
 * procurement/creditEnforcement.ts — adapter over the trade-credit
 * enforcement + supplier-direct settlement contracts (owned by the
 * tradeCredit module).
 *
 * Frozen contracts (implemented in services/tradeCredit):
 *
 *   isOrderAccessSuspended(buyerTenantId, supplierTenantId) → Promise<boolean>
 *       false when the buyer has no credit account with the supplier.
 *   settleDrawToSupplier({ poId, drawResult: { ledgerId } }) → Promise<{ ok }>
 *       marks the PO paid-via-credit once the credit draw has landed.
 *
 * The credit account row also gains (informational) `suspended` and
 * `suspension_reason` columns used for UX copy.
 *
 * These helpers resolve the contract functions at call time and degrade
 * safely when the enforcement module has not landed yet (fail-open for
 * suspension checks so existing ordering is never broken; the settle call is
 * a no-op `{ ok: true }` because the PO already transitions to the
 * credit-settled 'invoiced' state through the existing approval path). Call
 * sites stay a single line.
 */
import * as tradeCredit from "../tradeCredit";
import { isCreditEnforcementStrict } from "../../_core/env";

export interface OrderSuspension {
  suspended: boolean;
  /** Supplier-recorded reason for the suspension (UX copy), when known. */
  reason: string | null;
  /** Outstanding balance in cents, when an account exists. */
  outstandingCents: number | null;
  /**
   * True when the suspension verdict is a fail-CLOSED stand-in for a failed
   * lookup (strict mode), not a supplier-recorded suspension. Callers should
   * surface a transient "unavailable, try again" message, not dunning copy.
   */
  unavailable?: boolean;
}

const NOT_SUSPENDED: OrderSuspension = { suspended: false, reason: null, outstandingCents: null };

/**
 * Safe lookup of an optionally-present tradeCredit export (undefined before
 * the enforcement module merges). Guarded because module-namespace access
 * can throw under mocked/stubbed module registries.
 */
function contractFn(name: string): ((...args: any[]) => any) | undefined {
  try {
    const fn = (tradeCredit as any)[name];
    return typeof fn === "function" ? fn : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Is the buyer barred from submitting new POs to this supplier? Combines the
 * enforcement contract with the account row for reason/outstanding UX copy.
 * Never throws. Lookup failures are governed by CREDIT_ENFORCEMENT_STRICT
 * (see _core/env.isCreditEnforcementStrict):
 *   - strict (default in production-like envs): FAIL-CLOSED — the error
 *     blocks submission with a transient "credit status unavailable, try
 *     again" verdict (`unavailable: true`), so a delinquent buyer can never
 *     slip orders through a lookup outage.
 *   - non-strict (default in dev/test): FAIL-OPEN — ordering stays
 *     available and the failure is logged (historical behavior).
 */
export const CREDIT_STATUS_UNAVAILABLE_REASON = "credit status unavailable, try again";
export async function checkOrderSuspension(
  buyerTenantId: string,
  supplierTenantId: string,
): Promise<OrderSuspension> {
  try {
    const check = contractFn("isOrderAccessSuspended");
    if (!check) return NOT_SUSPENDED; // contract not merged yet
    const suspended = !!(await check(buyerTenantId, supplierTenantId));
    if (!suspended) return NOT_SUSPENDED;
    // Best-effort enrichment for message copy (suspension_reason, outstanding).
    let reason: string | null = null;
    let outstandingCents: number | null = null;
    try {
      const account = await (tradeCredit as any).getCreditAccount?.(supplierTenantId, buyerTenantId);
      if (account) {
        reason = typeof account.suspensionReason === "string" && account.suspensionReason.trim()
          ? account.suspensionReason.trim()
          : typeof account.suspension_reason === "string" && account.suspension_reason.trim()
            ? account.suspension_reason.trim()
            : null;
        const oc = Number(account.outstandingCents ?? account.outstanding_cents);
        outstandingCents = Number.isFinite(oc) ? oc : null;
      }
    } catch {
      /* enrichment is best-effort */
    }
    return { suspended: true, reason, outstandingCents };
  } catch (e: any) {
    if (isCreditEnforcementStrict()) {
      console.warn("[procurement] suspension check failed (strict: fail-closed):", e?.message);
      return {
        suspended: true,
        unavailable: true,
        reason: CREDIT_STATUS_UNAVAILABLE_REASON,
        outstandingCents: null,
      };
    }
    console.warn("[procurement] suspension check failed (fail-open):", e?.message);
    return NOT_SUSPENDED;
  }
}

/**
 * Settle a successful credit draw directly to the supplier: the PO moves to
 * its paid-via-credit state with no payment link. Single-line call sites;
 * safe no-op until the tradeCredit enforcement module lands.
 */
export async function settleCreditDrawToSupplier(args: {
  poId: string;
  drawResult: { ledgerId: string };
}): Promise<{ ok: boolean }> {
  const settle = contractFn("settleDrawToSupplier");
  if (!settle) return { ok: true }; // contract not merged yet
  try {
    // The tradeCredit contract keys on a SUCCESSFUL draw result
    // (Extract<DrawResult, { ok: true }>) — passing a bare { ledgerId }
    // silently no-ops with action 'no_draw' and the PO never reaches its
    // paid-via-credit state. Reconstruct the success shape here (the caller
    // only invokes us after draw.ok === true).
    const result = await settle({
      poId: args.poId,
      drawResult: { ok: true, ledgerId: args.drawResult.ledgerId },
    });
    return { ok: !!result?.ok };
  } catch (e: any) {
    // Settlement bookkeeping must not roll back an already-successful draw;
    // the PO is credit-settled ('invoiced') either way.
    console.warn("[procurement] settleDrawToSupplier failed:", e?.message);
    return { ok: false };
  }
}

/**
 * Buyer-facing suspension message, e.g. used by the submit gate and the
 * WhatsApp flow: reason + "repay to restore ordering" guidance.
 */
export function suspensionMessage(s: OrderSuspension, formatAmount: (cents: number) => string): string {
  const parts = ["Ordering is suspended with this supplier"];
  if (s.reason) parts.push(`— ${s.reason}`);
  const guidance = s.outstandingCents != null && s.outstandingCents > 0
    ? `Repay your outstanding balance of ${formatAmount(s.outstandingCents)} to restore ordering.`
    : "Repay your outstanding balance to restore ordering.";
  return `${parts.join(" ")}. ${guidance}`;
}
