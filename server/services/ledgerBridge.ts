/**
 * server/services/ledgerBridge.ts — shared ledger-bridge client helpers.
 *
 * Thin fetch wrapper around the ledger-bridge service (rust/ledger-bridge,
 * default http://ledger-bridge:8095). Used by the escrow settlement
 * compensation path and the direct ledger legs — payment.ts keeps its own
 * local copy to avoid changing its battle-tested behavior.
 */
import { ENV } from "../_core/env";
import { ledgerAccountIdFromRef } from "./ledgerAccounts";
// === W34 otel-core === traceparent propagation to the TigerBeetle ledger-bridge.
import { injectTraceHeaders } from "../_core/telemetry";

export class LedgerBridgeError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "LedgerBridgeError";
    this.status = status;
  }
}

export async function ledgerBridgeRequest(path: string, method = "GET", body?: unknown): Promise<any> {
  const url = `${ENV.ledgerBridgeUrl ?? "http://ledger-bridge:8095"}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      // QA-038: the bridge now requires this header once its own INTERNAL_API_KEY is set (same shared
      // secret already used for internalProcedure/gateway's internal auth) — sent unconditionally so this
      // is already true the moment the bridge starts enforcing, with nothing else to redeploy.
      headers: injectTraceHeaders({
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(process.env.INTERNAL_API_KEY ? { "X-Internal-Api-Key": process.env.INTERNAL_API_KEY } : {}),
      }),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err: any) {
    throw new LedgerBridgeError(`Ledger bridge ${method} ${path} unreachable: ${err?.message ?? err}`, null);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LedgerBridgeError(`Ledger bridge ${method} ${path} → ${res.status}: ${text}`, res.status);
  }
  return res.json();
}

/**
 * Post a direct, single-phase ledger leg: the transfer is POSTED atomically, with nothing left pending.
 *
 * Do NOT use a plain POST /transfer for this. That is a two-phase RESERVE: the funds sit in a pending
 * transfer that TigerBeetle auto-voids after `pending_timeout_secs`, so a "leg" posted that way silently
 * disappears (loan funding, pay-over-time and fee legs did exactly that).
 *
 * `debit_ref` / `credit_ref` are domain references ("credit-facility:<id>", "platform-fees:USD"), turned
 * into ledger ids here; an unknown kind throws. Any non-2xx THROWS. In particular a 400 is a malformed
 * leg and a 409 is the ledger refusing it (e.g. an overdraft): neither is "already posted". A replay of
 * the same idempotency key is a 200 with `replayed: true`, so there is nothing to swallow.
 */
export async function postDirectLedgerLeg(leg: {
  debit_ref: string;
  credit_ref: string;
  amount: number;
  idempotency_key: string;
  code?: number;
}): Promise<any> {
  return ledgerBridgeRequest("/transfer", "POST", {
    debit_account_id: ledgerAccountIdFromRef(leg.debit_ref),
    credit_account_id: ledgerAccountIdFromRef(leg.credit_ref),
    amount: leg.amount,
    ledger: 1,
    code: leg.code ?? 1,
    idempotency_key: leg.idempotency_key,
    single_phase: true,
  });
}

/**
 * Idempotently reverse a COMMITTED ledger transfer (saga compensation).
 * The bridge dedupes on reverse:{pending_id}, so replays are safe.
 * Returns the bridge response. Throws LedgerBridgeError on 5xx/unreachable
 * (caller must retry / flag for recon). A 400/409/404 means the transfer is
 * already final (nothing captured or already reversed) — returns the body
 * with `noop: true` instead of throwing.
 */
export async function reverseCommittedTransfer(pendingId: string, reason: string): Promise<any> {
  try {
    return await ledgerBridgeRequest("/ledger/reverse", "POST", { pending_id: pendingId, reason });
  } catch (err: any) {
    if (err instanceof LedgerBridgeError && err.status != null && [400, 404, 409].includes(err.status)) {
      return { status: "noop", pending_id: pendingId, detail: err.message, noop: true };
    }
    throw err;
  }
}
