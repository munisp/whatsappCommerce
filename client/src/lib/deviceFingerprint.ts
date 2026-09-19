// === W47 crosscutting (ONB-ID-1) ===
/**
 * Stable client device fingerprint for the phone-OTP second factor
 * (server: services/deviceAuth.ts, DEVICE_FACTOR_POLICY=required).
 * A random id persisted in localStorage + UA, SHA-256 hashed — the server
 * only ever sees the hash.
 */
export async function getDeviceFingerprintHash(): Promise<string> {
  const KEY = "hm.device.id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  const material = `${id}|${navigator.userAgent}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// === END W47 crosscutting ===
