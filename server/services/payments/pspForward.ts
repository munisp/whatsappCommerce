/**
 * Paystack sends every webhook for an account to ONE URL, and this account's URL is OAK's. Other platforms sharing
 * the same Paystack account (VolumeOS today) tag their checkouts with `metadata.platform`; OAK forwards those
 * notifications to the platform's own webhook, byte for byte with Paystack's signature, instead of treating them
 * as OAK payments. The receiving platform verifies the signature and the payment itself.
 *
 * Routes come from PAYSTACK_FORWARD_TARGETS, a JSON object of platform → webhook URL, e.g.
 *   {"volumeos":"http://svc-collections.volumeos.svc.cluster.local/v1/collections/webhooks/paystack"}
 * Unset or invalid → nothing is forwarded.
 */

export function paystackForwardTargets(raw = process.env.PAYSTACK_FORWARD_TARGETS): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(
      ([platform, url]) => /^[a-z0-9-]{2,32}$/.test(platform) && platform !== "oak" && typeof url === "string" && /^https?:\/\//.test(url),
    )) as Record<string, string>;
  } catch {
    return {};
  }
}

/** The webhook URL this Paystack event belongs to, or null when it's OAK's own (or nobody else's). */
export function paystackForwardTarget(payload: any, targets = paystackForwardTargets()): string | null {
  const platform = payload?.data?.metadata?.platform;
  if (typeof platform !== "string") return null;
  return targets[platform] ?? null;
}

/** Sends Paystack's exact body and signature on; returns the receiver's HTTP status (0 when unreachable). */
export async function forwardPaystackWebhook(url: string, rawBody: Buffer, signature: string): Promise<number> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paystack-signature": signature },
      body: new Uint8Array(rawBody),
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  } catch {
    return 0;
  }
}
