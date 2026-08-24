/**
 * W30 auth-gates — shared SSRF guard (V2#8).
 *
 * assertSafeOutboundUrl() validates a user/tenant-supplied URL before the
 * server fetches it with credentials attached:
 *   - must be a syntactically valid absolute http(s) URL
 *   - hostname must not be a loopback / private / link-local / reserved IP
 *     (literal IPv4 or IPv6), nor a well-known internal hostname
 *
 * DNS-rebinding (a public hostname resolving to a private IP) is out of scope
 * for this synchronous guard; literal-IP blocking plus the http(s) scheme
 * restriction closes the credentialed cloud-metadata probe vector.
 *
 * Pure functions — no env, no db — so unit tests exercise them directly.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "metadata.google.internal",
]);

/** True when the dotted-quad IPv4 address is not globally routable. */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && nums[2] === 0) return true; // 192.0.0/24
  if (a === 192 && b === 0 && nums[2] === 2) return true; // TEST-NET documentation
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && nums[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && nums[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** True when the IPv6 address is loopback / ULA / link-local / unspecified. */
export function isPrivateIpv6(ip: string): boolean {
  const norm = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (norm === "::1" || norm === "::") return true;
  if (norm.startsWith("fc") || norm.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(norm)) return true; // link-local fe80::/10
  if (norm.startsWith("::ffff:")) {
    // IPv4-mapped — evaluate the embedded v4 address.
    const v4 = norm.slice(7);
    if (v4.includes(".")) return isPrivateIpv4(v4);
  }
  return false;
}

export interface UrlSafetyResult {
  ok: boolean;
  reason?: string;
  url?: URL;
}

/** Pure URL safety evaluation. */
export function evaluateOutboundUrl(raw: string): UrlSafetyResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `scheme '${url.protocol.replace(":", "")}' is not allowed (http/https only)` };
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: `hostname '${host}' is not allowed` };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIpv4(host)) {
    return { ok: false, reason: `private/reserved IPv4 address '${host}' is not allowed` };
  }
  if (host.includes(":") || host.startsWith("[")) {
    if (isPrivateIpv6(host)) {
      return { ok: false, reason: `private/reserved IPv6 address '${host}' is not allowed` };
    }
  }
  return { ok: true, url };
}

/**
 * Throws Error with an operator-readable message when the URL is unsafe.
 * Call at config-write time AND at request time for credentialed fetches.
 */
export function assertSafeOutboundUrl(raw: string, label = "baseUrl"): URL {
  const result = evaluateOutboundUrl(raw);
  if (!result.ok) {
    throw new Error(`SSRF guard rejected ${label}: ${result.reason}`);
  }
  return result.url!;
}
