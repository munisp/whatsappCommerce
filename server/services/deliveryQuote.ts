/**
 * Delivery fee quoting.
 *
 * Honest fallback-zone quoting derived from the same published Nigerian
 * carrier base rates used by logistics.getProviders when no Shipbubble API
 * key is configured (Sendbox economy anchor for same-city, GIG standard
 * anchor for intercity). There is deliberately NO fake precision: we quote a
 * flat zone rate + per-kg increment and label it as an estimate. When a live
 * rates provider is configured, checkout can swap this out for a real quote.
 */

export interface DeliveryQuote {
  fee: number;          // major currency units (NGN)
  currency: "NGN";
  zone: "same_city" | "intercity";
  carrier: string;      // anchor carrier whose published rate the quote derives from
  estimatedDays: number;
  source: "fallback_zone_rate";
}

// Metro-Lagos address hints — chat orders overwhelmingly deliver within Lagos.
const LAGOS_HINTS = [
  "lagos", "ikeja", "lekki", "victoria island", "ikoyi", "yaba", "surulere",
  "ajah", "maroko", "ikorodu", "epe", "badagry", "oshodi", "apapa", "festac",
  "maryland", "gbagada", "magodo", "ogudu", "ojota", "ketu", "ojodu", "berger",
  "isolo", "egbeda", "alimosho", "amuwo", "ojo", "vi,", "onikan", "obiakoro",
];

const SAME_CITY_BASE = 1500;   // Sendbox economy anchor (see logistics.getProviders)
const SAME_CITY_PER_KG = 500;
const INTERCITY_BASE = 2500;   // GIG Logistics standard anchor
const INTERCITY_PER_KG = 800;

/**
 * Quote a delivery fee for a free-text address.
 * Unknown/empty addresses are quoted as same-city (the common case for
 * WhatsApp chat orders) so the buyer is not overcharged by default.
 */
export function quoteDeliveryFee(opts: { address?: string | null; weightKg?: number }): DeliveryQuote {
  const weightKg = Math.max(1, Math.ceil(opts.weightKg ?? 1));
  const addr = (opts.address ?? "").toLowerCase();
  const sameCity = !addr.trim() || LAGOS_HINTS.some(h => addr.includes(h));

  return sameCity
    ? {
        fee: SAME_CITY_BASE + (weightKg - 1) * SAME_CITY_PER_KG,
        currency: "NGN",
        zone: "same_city",
        carrier: "Sendbox",
        estimatedDays: 1,
        source: "fallback_zone_rate",
      }
    : {
        fee: INTERCITY_BASE + (weightKg - 1) * INTERCITY_PER_KG,
        currency: "NGN",
        zone: "intercity",
        carrier: "GIG Logistics",
        estimatedDays: 2,
        source: "fallback_zone_rate",
      };
}
