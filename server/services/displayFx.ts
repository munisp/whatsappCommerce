/**
 * displayFx.ts — W41 (Coder C) multi-currency DISPLAY pricing (UC-5).
 *
 * Diaspora buyers see an approximate home-currency price next to the NGN
 * price. This is PRESENTATIONAL ONLY — the honest doctrine for W41:
 *   - the ledger, orders and every PSP charge stay in NGN (kobo);
 *   - rates are MANUAL, tenant-set (tenants.displayCurrency +
 *     tenants.displayFxRates = { "USD": { "rate": "0.00066", "updatedAt" } })
 *     — no live FX feed this wave;
 *   - every dual-displayed message carries the footer from
 *     DUAL_DISPLAY_FOOTER so the buyer knows they are charged in NGN.
 *
 * formatPriceDual(tenant, amount, "NGN") → "₦1,500.00 (~$0.99)" when the
 * tenant configured a display currency + rate; plain "₦1,500.00" otherwise.
 */

export interface DisplayFxRate {
  /** display-currency units per 1 NGN (major unit), decimal string. */
  rate: string;
  updatedAt?: string;
}

export interface DisplayFxConfig {
  currency: string; // ISO-4217, e.g. "USD"
  rates: Record<string, DisplayFxRate>;
}

const SYMBOLS: Record<string, string> = {
  NGN: "₦", USD: "$", GBP: "£", EUR: "€", GHS: "GH₵", KES: "KSh ", ZAR: "R",
};

export function currencySymbol(currency: string): string {
  return SYMBOLS[(currency ?? "").toUpperCase()] ?? `${currency} `;
}

/** Honest footer appended (once) to messages that show a converted price. */
export const DUAL_DISPLAY_FOOTER =
  "Approximate conversion at this store's manual rate — you are charged in NGN.";

type TenantFxRow = {
  displayCurrency?: string | null;
  displayFxRates?: unknown;
};

/** Parse the tenant row into a display config; null when unconfigured. */
export function parseDisplayFxConfig(tenant: TenantFxRow | null | undefined): DisplayFxConfig | null {
  if (!tenant?.displayCurrency) return null;
  const currency = String(tenant.displayCurrency).toUpperCase();
  const raw = (tenant.displayFxRates ?? {}) as Record<string, unknown>;
  const entry = raw?.[currency] as DisplayFxRate | undefined;
  const rate = Number(entry?.rate);
  if (!entry || !(rate > 0)) return null;
  return { currency, rates: { [currency]: { rate: String(entry.rate), updatedAt: entry.updatedAt } } };
}

/**
 * Convert an NGN major-unit amount to the tenant display currency.
 * Returns the converted major-unit amount, or null when no valid rate.
 */
export function convertForDisplay(
  amountNgn: number,
  cfg: DisplayFxConfig | null,
): { amount: number; currency: string } | null {
  if (!cfg) return null;
  const rate = Number(cfg.rates[cfg.currency]?.rate);
  if (!(rate > 0)) return null;
  return { amount: amountNgn * rate, currency: cfg.currency };
}

/** "₦1,500.00 (~$0.99)" or plain "₦1,500.00" when unconfigured. */
export function formatPriceDual(
  tenant: TenantFxRow | null | undefined,
  amountNgn: number,
  baseCurrency = "NGN",
): string {
  const base = `${currencySymbol(baseCurrency)}${amountNgn.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const cfg = parseDisplayFxConfig(tenant);
  const conv = convertForDisplay(amountNgn, cfg);
  if (!conv) return base;
  const shown = `${currencySymbol(conv.currency)}${conv.amount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${base} (~${shown})`;
}

/**
 * Build a formatter bound to a tenant row for message builders. Returns
 * null when the tenant has no valid display config (callers render plain).
 */
export function makeDualFormatter(
  tenant: TenantFxRow | null | undefined,
): ((amountNgn: number, currency?: string) => string) | null {
  if (!parseDisplayFxConfig(tenant)) return null;
  return (amountNgn, currency = "NGN") => formatPriceDual(tenant, amountNgn, currency);
}
