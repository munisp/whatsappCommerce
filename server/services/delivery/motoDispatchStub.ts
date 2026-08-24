/**
 * server/services/delivery/motoDispatchStub.ts — W27 interface stub for real
 * moto-dispatch APIs (e.g. a courier aggregator REST API).
 *
 * This is the integration seam for a live partner: set
 *   MOTO_DISPATCH_API_URL   — partner base URL
 *   MOTO_DISPATCH_API_KEY   — partner API key (server-side env, never per-tenant
 *                             plaintext; per-tenant keys go into
 *                             courier_configs.credentials ENCRYPTED, same
 *                             discipline as payment_gateway_configs)
 * and this adapter will call the partner's /quotes, /bookings and
 * /bookings/:id endpoints. Without configuration every method throws a clear
 * "not configured" error so a tenant that enables `moto_dispatch` without
 * credentials fails loudly at quote time rather than silently falling back.
 */
import type {
  BookRequest,
  Booking,
  CourierAdapter,
  DeliveryStatus,
  Quote,
  QuoteRequest,
} from "./types";

function config(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.MOTO_DISPATCH_API_URL ?? "";
  const apiKey = process.env.MOTO_DISPATCH_API_KEY ?? "";
  if (!baseUrl || !apiKey) {
    throw new Error(
      "moto_dispatch courier is not configured — set MOTO_DISPATCH_API_URL and MOTO_DISPATCH_API_KEY",
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const { baseUrl, apiKey } = config();
  const resp = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
  });
  if (!resp.ok) {
    throw new Error(`moto_dispatch ${path} failed: HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export const motoDispatchStubAdapter: CourierAdapter = {
  id: "moto_dispatch",
  displayName: "Moto Dispatch Partner API (stub)",
  // verify-v1 #11: stub adapter — no live courier feed; untrusted for escrow.
  escrowTrusted: false,

  async quote(req: QuoteRequest): Promise<Quote> {
    const data = await call<{
      quote_id: string; fee_cents: number; currency?: string;
      distance_km?: number | null; eta_minutes?: number;
    }>("/quotes", { method: "POST", body: JSON.stringify(req) });
    return {
      courier: "moto_dispatch",
      quoteId: data.quote_id,
      feeCents: Math.round(data.fee_cents),
      currency: data.currency ?? req.currency ?? "NGN",
      distanceKm: data.distance_km ?? null,
      etaMinutes: data.eta_minutes ?? 60,
      label: "Moto dispatch partner",
    };
  },

  async book(req: BookRequest): Promise<Booking> {
    const data = await call<{ booking_id: string; status?: string }>("/bookings", {
      method: "POST",
      body: JSON.stringify(req),
    });
    return {
      courier: "moto_dispatch",
      externalId: data.booking_id,
      status: "booked",
      raw: data,
    };
  },

  async status(externalId: string): Promise<DeliveryStatus> {
    const data = await call<{ status: DeliveryStatus["status"]; at?: string }>(
      `/bookings/${encodeURIComponent(externalId)}`,
      { method: "GET" },
    );
    return {
      courier: "moto_dispatch",
      externalId,
      status: data.status,
      at: data.at ?? new Date().toISOString(),
      raw: data,
    };
  },
};
