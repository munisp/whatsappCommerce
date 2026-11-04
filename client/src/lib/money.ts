/** Money as shops see it: the naira sign by default, never a hard-coded "$". */
const SYMBOL: Record<string, string> = { NGN: "₦", USD: "$", GBP: "£", EUR: "€", GHS: "GH₵", KES: "KSh ", ZAR: "R", XOF: "CFA " };

export function currencySymbol(currency?: string | null): string {
  const c = (currency || "NGN").toUpperCase();
  return SYMBOL[c] ?? `${c} `;
}

/** "₦13,000.00" (or the currency given). */
export function formatMoney(amount: number | string | null | undefined, currency?: string | null, decimals = 2): string {
  const n = Number(amount ?? 0);
  return currencySymbol(currency) + (Number.isFinite(n) ? n : 0).toLocaleString("en-NG", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** "₦1.2M" / "₦45.0K" for headline numbers. */
export function formatMoneyShort(amount: number | string | null | undefined, currency?: string | null): string {
  const n = Number(amount ?? 0) || 0;
  const s = currencySymbol(currency);
  if (Math.abs(n) >= 1_000_000) return `${s}${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${s}${(n / 1_000).toFixed(1)}K`;
  return `${s}${n.toFixed(2)}`;
}
