/**
 * Paystack Transfers adapter — merchant wallet payouts.
 *
 * Uses the PLATFORM's own Paystack account (ENV.paystackSecretKey), never a
 * tenant's own gateway keys: a withdrawal moves money OUT of the platform's
 * Paystack balance into the merchant's bank account. Two calls per payout:
 * create (or reuse) a transfer recipient, then initiate the transfer.
 *
 * Paystack accounts can have "Transfer OTP" enabled, which requires a human
 * to finalize the transfer with a one-time code sent to the account owner —
 * that can't be completed here, so callers must handle the "otp" status
 * distinctly from "success"/"pending" rather than assuming the payout landed.
 */

const PAYSTACK_BASE = "https://api.paystack.co";

export class PaystackTransferError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PaystackTransferError";
  }
}

async function paystackFetch(path: string, secretKey: string, body: Record<string, unknown>) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }).catch((err: unknown) => {
    throw new PaystackTransferError(`Paystack request to ${path} failed: ${(err as Error)?.message ?? "network error"}`, err);
  });
  const raw = await res.text();
  let parsed: { status?: boolean; message?: string; data?: Record<string, unknown> } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PaystackTransferError(`Paystack ${path} returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  if (!res.ok || parsed.status !== true) {
    throw new PaystackTransferError(`Paystack ${path} failed: ${parsed.message ?? `HTTP ${res.status}`}`);
  }
  return parsed.data ?? {};
}

export interface PaystackBank {
  name: string;
  code: string;
  slug: string;
}

let bankListCache: { fetchedAt: number; banks: PaystackBank[] } | null = null;
const BANK_LIST_TTL_MS = 60 * 60 * 1000; // banks/CBN codes practically never change

/** Lists NGN-payable banks (incl. fintechs Paystack settles to) for a withdrawal-form picker. */
export async function listBanks(secretKey: string): Promise<PaystackBank[]> {
  if (bankListCache && Date.now() - bankListCache.fetchedAt < BANK_LIST_TTL_MS) {
    return bankListCache.banks;
  }
  const res = await fetch(`${PAYSTACK_BASE}/bank?currency=NGN&country=nigeria&perPage=200`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15000),
  }).catch((err: unknown) => {
    throw new PaystackTransferError(`Paystack bank list request failed: ${(err as Error)?.message ?? "network error"}`, err);
  });
  const raw = await res.text();
  let parsed: { status?: boolean; message?: string; data?: unknown } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PaystackTransferError(`Paystack /bank returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  if (!res.ok || parsed.status !== true || !Array.isArray(parsed.data)) {
    throw new PaystackTransferError(`Paystack /bank failed: ${parsed.message ?? `HTTP ${res.status}`}`);
  }
  const banks = (parsed.data as Record<string, unknown>[])
    .filter((b) => typeof b.name === "string" && typeof b.code === "string")
    .map((b) => ({ name: b.name as string, code: b.code as string, slug: String(b.slug ?? "") }))
    .sort((a, b) => a.name.localeCompare(b.name));
  bankListCache = { fetchedAt: Date.now(), banks };
  return banks;
}

export interface ResolvedAccount {
  accountNumber: string;
  accountName: string;
}

/**
 * Resolves a bank account number to the name on file at the bank (NIBSS
 * lookup via Paystack) — lets the withdrawal form confirm whose account it's
 * paying out to instead of trusting a free-typed name, which a typo or bad
 * actor could otherwise mismatch against the real account.
 */
export async function resolveAccount(secretKey: string, accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
  const url = `${PAYSTACK_BASE}/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15000),
  }).catch((err: unknown) => {
    throw new PaystackTransferError(`Paystack account resolution request failed: ${(err as Error)?.message ?? "network error"}`, err);
  });
  const raw = await res.text();
  let parsed: { status?: boolean; message?: string; data?: Record<string, unknown> } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PaystackTransferError(`Paystack /bank/resolve returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  if (!res.ok || parsed.status !== true) {
    throw new PaystackTransferError(parsed.message ?? `Could not resolve account (HTTP ${res.status})`);
  }
  const data = parsed.data ?? {};
  const accountName = data.account_name;
  const resolvedNumber = data.account_number;
  if (typeof accountName !== "string" || !accountName) {
    throw new PaystackTransferError("Paystack resolution returned no account_name");
  }
  return { accountNumber: typeof resolvedNumber === "string" ? resolvedNumber : accountNumber, accountName };
}

export interface CreateTransferRecipientOpts {
  secretKey: string;
  accountName: string;
  accountNumber: string;
  bankCode: string;
  currency?: string;
}

/** Creates a Paystack transfer recipient, returning its recipient_code. */
export async function createTransferRecipient(opts: CreateTransferRecipientOpts): Promise<string> {
  const data = await paystackFetch("/transferrecipient", opts.secretKey, {
    type: "nuban",
    name: opts.accountName,
    account_number: opts.accountNumber,
    bank_code: opts.bankCode,
    currency: opts.currency ?? "NGN",
  });
  const recipientCode = data.recipient_code;
  if (typeof recipientCode !== "string" || !recipientCode) {
    throw new PaystackTransferError("Paystack recipient creation returned no recipient_code");
  }
  return recipientCode;
}

export interface InitiateTransferOpts {
  secretKey: string;
  recipientCode: string;
  amountMajor: number; // NGN (or configured currency), NOT kobo
  reason: string;
  reference: string;
  currency?: string;
}

export interface InitiateTransferResult {
  /** "otp" means Paystack requires a human to finalize with a one-time code
   *  sent to the account owner — the payout has NOT landed yet. */
  status: "success" | "pending" | "processing" | "otp";
  transferCode: string | null;
  reference: string;
}

/** Initiates a Paystack transfer from the platform's balance to a recipient. */
export async function initiateTransfer(opts: InitiateTransferOpts): Promise<InitiateTransferResult> {
  const data = await paystackFetch("/transfer", opts.secretKey, {
    source: "balance",
    amount: Math.round(opts.amountMajor * 100),
    recipient: opts.recipientCode,
    reason: opts.reason,
    reference: opts.reference,
    currency: opts.currency ?? "NGN",
  });
  const status = data.status;
  const normalized: InitiateTransferResult["status"] =
    status === "success" || status === "pending" || status === "processing" || status === "otp"
      ? status
      : "pending";
  return {
    status: normalized,
    transferCode: typeof data.transfer_code === "string" ? data.transfer_code : null,
    reference: opts.reference,
  };
}
