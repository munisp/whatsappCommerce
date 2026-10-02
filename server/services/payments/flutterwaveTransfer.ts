// === W59 banking-pos ===
/**
 * Flutterwave Transfers adapter — thin rail mirroring paystackTransfer.ts so
 * a merchant payout account can choose its rail per row
 * (merchant_payout_accounts.provider = 'paystack' | 'flutterwave').
 *
 * Uses the PLATFORM's own Flutterwave secret key read DIRECTLY from
 * process.env.FLUTTERWAVE_SECRET_KEY — deliberately NOT added to
 * _core/env.ts (the env-validation tests snapshot that schema; additive env
 * reads stay local to this adapter).
 *
 * Flutterwave v3 endpoints:
 *   GET  /banks/NG                 — Nigerian bank list (bank codes)
 *   POST /accounts/resolve         — NIBSS name enquiry {account_number, account_bank}
 *   POST /transfers                — initiate payout {account_bank, account_number, amount, narration, reference, currency}
 *   GET  /transfers?reference=...  — post-timeout lookup before any refund
 *
 * Amounts: Flutterwave /transfers takes MAJOR units (NGN) in `amount`; the
 * platform's internal convention is integer cents (toCents upstream), so the
 * conversion happens here at the boundary via currencyExponent.ts.
 */

import { fromMinorUnits } from "./currencyExponent";

const FLUTTERWAVE_BASE = "https://api.flutterwave.com/v3";

export class FlutterwaveTransferError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "FlutterwaveTransferError";
  }
}

/** Reads the platform Flutterwave key at call time (never at module load, so
 *  tests/sim can set the env before the first call). */
export function flutterwaveSecretKey(): string {
  return process.env.FLUTTERWAVE_SECRET_KEY ?? "";
}

async function flutterwaveFetch(path: string, opts: { method?: string; body?: Record<string, unknown> } = {}) {
  const secretKey = flutterwaveSecretKey();
  if (!secretKey) throw new FlutterwaveTransferError("No Flutterwave key configured (FLUTTERWAVE_SECRET_KEY)");
  const res = await fetch(`${FLUTTERWAVE_BASE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15000),
  }).catch((err: unknown) => {
    throw new FlutterwaveTransferError(`Flutterwave request to ${path} failed: ${(err as Error)?.message ?? "network error"}`, err);
  });
  const raw = await res.text();
  let parsed: { status?: string; message?: string; data?: unknown } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FlutterwaveTransferError(`Flutterwave ${path} returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  return { res, parsed };
}

export interface FlutterwaveBank {
  name: string;
  code: string;
}

let bankListCache: { fetchedAt: number; banks: FlutterwaveBank[] } | null = null;
const BANK_LIST_TTL_MS = 60 * 60 * 1000;

/** Lists NGN-payable banks (GET /banks/NG) for the payout-account picker. */
export async function listBanks(): Promise<FlutterwaveBank[]> {
  if (bankListCache && Date.now() - bankListCache.fetchedAt < BANK_LIST_TTL_MS) {
    return bankListCache.banks;
  }
  const { res, parsed } = await flutterwaveFetch("/banks/NG");
  if (!res.ok || parsed.status !== "success" || !Array.isArray(parsed.data)) {
    throw new FlutterwaveTransferError(`Flutterwave /banks/NG failed: ${parsed.message ?? `HTTP ${res.status}`}`);
  }
  const banks = (parsed.data as Record<string, unknown>[])
    .filter((b) => typeof b.name === "string" && typeof b.code === "string")
    .map((b) => ({ name: b.name as string, code: b.code as string }))
    .sort((a, b) => a.name.localeCompare(b.name));
  bankListCache = { fetchedAt: Date.now(), banks };
  return banks;
}

export interface ResolvedAccount {
  accountNumber: string;
  accountName: string;
}

/** NIBSS name enquiry via Flutterwave (POST /accounts/resolve). Fail-closed:
 *  any failure throws and the caller must NOT persist the account. */
export async function resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
  const { res, parsed } = await flutterwaveFetch("/accounts/resolve", {
    body: { account_number: accountNumber, account_bank: bankCode },
  });
  if (!res.ok || parsed.status !== "success") {
    throw new FlutterwaveTransferError(parsed.message ?? `Could not resolve account (HTTP ${res.status})`);
  }
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const accountName = data.account_name;
  if (typeof accountName !== "string" || !accountName) {
    throw new FlutterwaveTransferError("Flutterwave resolution returned no account_name");
  }
  return {
    accountNumber: typeof data.account_number === "string" ? data.account_number : accountNumber,
    accountName,
  };
}

export interface InitiateTransferOpts {
  accountNumber: string;
  bankCode: string;
  accountName: string;
  amountCents: number; // integer cents — converted to major NGN at the boundary
  narration: string;
  reference: string;
  currency?: string;
}

export interface InitiateTransferResult {
  status: "success" | "pending" | "processing";
  transferId: number | null;
  reference: string;
}

/** Initiates a Flutterwave transfer (POST /transfers). Flutterwave has no
 *  recipient object — account details ride on each transfer. */
export async function initiateTransfer(opts: InitiateTransferOpts): Promise<InitiateTransferResult> {
  const currency = opts.currency ?? "NGN";
  const { res, parsed } = await flutterwaveFetch("/transfers", {
    body: {
      account_bank: opts.bankCode,
      account_number: opts.accountNumber,
      // Boundary conversion: integer cents → major units (ISO-4217 exponent).
      amount: fromMinorUnits(opts.amountCents, currency),
      narration: opts.narration.slice(0, 100),
      reference: opts.reference,
      currency,
      debit_currency: currency,
      beneficiary_name: opts.accountName,
    },
  });
  if (!res.ok || parsed.status !== "success") {
    throw new FlutterwaveTransferError(`Flutterwave /transfers failed: ${parsed.message ?? `HTTP ${res.status}`}`);
  }
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const rawStatus = typeof data.status === "string" ? data.status.toUpperCase() : "";
  const status: InitiateTransferResult["status"] =
    rawStatus === "SUCCESSFUL" ? "success" : rawStatus === "PENDING" || rawStatus === "NEW" ? "pending" : "processing";
  return {
    status,
    transferId: typeof data.id === "number" ? data.id : null,
    reference: opts.reference,
  };
}

export interface VerifyTransferResult {
  /** Raw Flutterwave transfer status ("SUCCESSFUL" | "PENDING" | "FAILED" |
   *  ...), or null when Flutterwave has no transfer for this reference. */
  status: string | null;
  transferId: number | null;
  found: boolean;
}

/** Post-timeout lookup by reference (GET /transfers?reference=...). A wallet
 *  refund must NEVER be issued until this proves the transfer does not exist
 *  or terminally FAILED — same double-spend guard as paystackTransfer. */
export async function verifyTransfer(reference: string): Promise<VerifyTransferResult> {
  const { res, parsed } = await flutterwaveFetch(`/transfers?reference=${encodeURIComponent(reference)}`);
  if (!res.ok || parsed.status !== "success" || !Array.isArray(parsed.data) || parsed.data.length === 0) {
    const msg = String(parsed.message ?? "");
    if (res.status === 404 || /not found|no transfer/i.test(msg) || (Array.isArray(parsed.data) && parsed.data.length === 0)) {
      return { status: null, transferId: null, found: false };
    }
    throw new FlutterwaveTransferError(`Flutterwave transfer verify failed: ${msg || `HTTP ${res.status}`}`);
  }
  const data = parsed.data[0] as Record<string, unknown>;
  return {
    status: typeof data.status === "string" ? data.status.toUpperCase() : null,
    transferId: typeof data.id === "number" ? data.id : null,
    found: true,
  };
}
