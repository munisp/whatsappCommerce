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

/**
 * Parse an IPv6 address (string form, brackets optional) into eight 16-bit
 * hextets, or null when the input is not a syntactically valid IPv6 literal.
 *
 * Handles every RFC 4291/5952 form that WHATWG URL parsing can produce:
 *   - full 8-hextet form           2001:db8:0:0:0:0:0:1
 *   - compressed `::` forms        ::1, fe80::1, 2001:db8::/32-style
 *   - IPv4-mapped hex (WHATWG)     ::ffff:7f00:1        (= 127.0.0.1)
 *   - IPv4-mapped dotted           ::ffff:127.0.0.1
 *   - IPv4-compatible              ::127.0.0.1 / ::7f00:1
 *   - embedded dotted quad in any  2001:db8::127.0.0.1
 *     tail position (counts as two hextets)
 */
function parseIpv6Hextets(raw: string): number[] | null {
  let s = raw.toLowerCase().replace(/^\[|\]$/g, "");
  if (s.length === 0) return null;
  // Zone id (fe80::1%eth0) — strip for parsing; the address itself classifies.
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);
  if (s.length === 0) return null;

  // An embedded dotted-quad IPv4 tail counts as the final two hextets —
  // rewrite it textually as hex so the rest of the parse is uniform.
  const lastColon = s.lastIndexOf(":");
  const tail = lastColon === -1 ? s : s.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (lastColon === -1) return null; // bare dotted quad is not IPv6
    const parts = tail.split(".");
    if (parts.length !== 4) return null;
    if (parts.some((p) => !/^\d{1,3}$/.test(p))) return null;
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => n > 255)) return null;
    const hi = ((nums[0] << 8) | nums[1]).toString(16);
    const lo = ((nums[2] << 8) | nums[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const pieces = s.split("::");
  if (pieces.length > 2) return null; // more than one '::'
  const parseGroup = (g: string): number[] | null => {
    if (g === "") return [];
    const out: number[] = [];
    for (const part of g.split(":")) {
      if (part === "" || !/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const head = parseGroup(pieces[0]);
  if (head === null) return null;
  let tailGroups: number[] = [];
  if (pieces.length === 2) {
    const t = parseGroup(pieces[1]);
    if (t === null) return null;
    tailGroups = t;
  }
  const total = head.length + tailGroups.length;
  if (pieces.length === 1) {
    // No '::' — must be exactly 8 groups.
    if (total !== 8) return null;
    return head;
  }
  // '::' fills at least one zero group.
  if (total > 7) return null;
  const zeros = new Array(8 - total).fill(0);
  return [...head, ...zeros, ...tailGroups];
}

/** True when the IPv6 address is loopback / ULA / link-local / unspecified /
 *  documentation / or embeds a non-routable IPv4 address (mapped, compatible,
 *  6to4, Teredo). */
export function isPrivateIpv6(ip: string): boolean {
  const h = parseIpv6Hextets(ip);
  if (!h) return false;
  // :: (unspecified) and ::1 (loopback)
  if (h.every((x) => x === 0)) return true;
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true;
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96, excluding the
  // unspecified/loopback forms handled above) — classify the embedded v4.
  const embedV4 =
    (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) ||
    (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0);
  // 6to4 (2002::/16) and Teredo (2001:0::/32) embed a public IPv4 in the
  // address; the tunnel endpoint is only as public as that embedded v4.
  const is6to4 = h[0] === 0x2002;
  const isTeredo = h[0] === 0x2001 && h[1] === 0x0000;
  if (embedV4 || is6to4 || isTeredo) {
    let a: number, b: number, c: number, d: number;
    if (embedV4) {
      a = h[6] >> 8; b = h[6] & 0xff; c = h[7] >> 8; d = h[7] & 0xff;
    } else if (is6to4) {
      a = h[1] >> 8; b = h[1] & 0xff; c = h[2] >> 8; d = h[2] & 0xff;
    } else {
      // Teredo: the client IPv4 is the LAST 32 bits, XORed with 0xffffffff.
      a = (h[6] >> 8) ^ 0xff; b = (h[6] & 0xff) ^ 0xff; c = (h[7] >> 8) ^ 0xff; d = (h[7] & 0xff) ^ 0xff;
    }
    if (isPrivateIpv4(`${a}.${b}.${c}.${d}`)) return true;
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if (h[0] === 0x2001 && (h[1] & 0xffff) === 0x0db8) return true; // docs 2001:db8::/32
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
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
