/**
 * server/services/ledgerBridge.ts — shared ledger-bridge client helpers.
 *
 * Thin fetch wrapper around the hardened ledger-bridge service
 * (services/ledger-bridge, default http://ledger-bridge:8095). Used by the
 * escrow settlement compensation path — payment.ts keeps its own local copy
 * to avoid changing its battle-tested behavior.
 */
import { ENV } from "../_core/env";

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
      headers: body ? { "Content-Type": "application/json" } : {},
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
