/**
 * BLACK-BOX robustness probe — hits the platform's external HTTP surface with
 * adversarial / malformed / edge inputs and judges ONLY by observable behavior:
 * correct status codes, JSON error envelopes (no stack-trace/path leaks),
 * fail-closed auth + webhooks, and no crash/hang under junk input.
 * No assertions against internals. Needs a running platform (PLATFORM_URL).
 */
import { SignJWT } from "jose";
const BASE = process.env.PLATFORM_URL ?? "http://localhost:3000";
const WHSEC = process.env.PAYSTACK_WEBHOOK_SECRET ?? "e2e-paystack-webhook-secret";
import { createHmac } from "node:crypto";

let pass = 0, fail = 0;
const leakRe = /(\/Users\/|\/app\/|at Object\.|at async |node_modules|\bError:\s|ECONNREFUSED|stack|drizzle|postgres:\/\/|password)/i;
function judge(label: string, ok: boolean, got: string, bodyText = "") {
  const leak = bodyText && leakRe.test(bodyText);
  const good = ok && !leak;
  console.log(`${good ? "PASS" : "FAIL"}  ${label} — ${got}${leak ? "  ⚠ POSSIBLE INTERNAL LEAK in body" : ""}`);
  good ? pass++ : fail++;
}
async function hit(method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
  try {
    const res = await fetch(`${BASE}${path}`, { method, body: opts.body, headers: opts.headers, signal: AbortSignal.timeout(20000) });
    const text = await res.text().catch(() => "");
    return { status: res.status, text };
  } catch (e: any) {
    return { status: -1, text: `FETCH_ERROR ${e?.name}: ${e?.message}` };
  }
}
const sjGet = (input: unknown) => `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;

async function main() {
  // 1. Unknown route → 404 (not 500, not HTML stack)
  {
    const r = await hit("GET", "/api/this-route-does-not-exist-" + Date.now());
    judge("unknown route → 404", r.status === 404, `HTTP ${r.status}`, r.text);
  }
  // 2. Protected tRPC with NO auth → 401 UNAUTHORIZED
  {
    const r = await hit("GET", "/api/trpc/template.list" + sjGet({ limit: 10 }));
    judge("protected tRPC, no token → 401", r.status === 401, `HTTP ${r.status}`, r.text);
  }
  // 3. Garbage bearer token → 401
  {
    const r = await hit("GET", "/api/trpc/template.list" + sjGet({ limit: 10 }), { headers: { Authorization: "Bearer not.a.jwt" } });
    judge("garbage bearer token → 401", r.status === 401, `HTTP ${r.status}`, r.text);
  }
  // 4. Structurally-valid JWT signed with the WRONG secret → 401 (signature must be verified)
  {
    const forged = await new SignJWT({ openId: "attacker", appId: "wacommerce", name: "x" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime("1h")
      .sign(new TextEncoder().encode("WRONG-SECRET-attacker-controlled"));
    const r = await hit("GET", "/api/trpc/template.list" + sjGet({ limit: 10 }), { headers: { Authorization: `Bearer ${forged}` } });
    judge("JWT with forged signature → 401", r.status === 401, `HTTP ${r.status}`, r.text);
  }
  // 5. Malformed JSON body to a tRPC mutation → 4xx, never 500/stack
  {
    const r = await hit("POST", "/api/trpc/payment.initiate", { headers: { "Content-Type": "application/json" }, body: "{ this is : not json" });
    judge("malformed JSON body → 4xx (no 500/leak)", r.status >= 400 && r.status < 500, `HTTP ${r.status}`, r.text);
  }
  // 6. Wrong content-type (text/plain) to a tRPC mutation → clean 4xx, no crash
  {
    const r = await hit("POST", "/api/trpc/payment.initiate", { headers: { "Content-Type": "text/plain" }, body: "hello" });
    judge("wrong content-type → clean 4xx (no 500/leak)", r.status >= 400 && r.status < 500, `HTTP ${r.status}`, r.text);
  }
  // 7. Oversized body (~6MB) → rejected cleanly (413 or 4xx), must not hang/crash
  {
    const big = JSON.stringify({ json: { blob: "A".repeat(6 * 1024 * 1024) } });
    const r = await hit("POST", "/api/trpc/payment.initiate", { headers: { "Content-Type": "application/json" }, body: big });
    judge("6MB oversized body → rejected, no hang/crash", r.status >= 400 && r.status < 500, `HTTP ${r.status}`, r.text);
  }
  // 8. Webhook with NO signature → fail-closed (401/403/400), never accepted as confirmed
  {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "BB-NOSIG", amount: 1 } });
    const r = await hit("POST", "/api/webhooks/paystack", { headers: { "Content-Type": "application/json" }, body });
    judge("paystack webhook, no signature → rejected (fail-closed)", r.status === 401 || r.status === 403 || r.status === 400, `HTTP ${r.status}`, r.text);
  }
  // 9. Webhook with WRONG signature → rejected
  {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "BB-BADSIG", amount: 1 } });
    const r = await hit("POST", "/api/webhooks/paystack", { headers: { "Content-Type": "application/json", "x-paystack-signature": "deadbeef" }, body });
    judge("paystack webhook, wrong signature → 401", r.status === 401, `HTTP ${r.status}`, r.text);
  }
  // 10. Webhook with VALID signature but unknown/garbage event → acknowledged cleanly, no 500
  {
    const body = JSON.stringify({ event: "totally.unknown.event", data: { junk: "\u0000￿", nested: { a: [1, 2, 3] } } });
    const sig = createHmac("sha512", WHSEC).update(body).digest("hex");
    const r = await hit("POST", "/api/webhooks/paystack", { headers: { "Content-Type": "application/json", "x-paystack-signature": sig }, body });
    judge("paystack webhook, valid sig + unknown event → clean (no 500)", r.status >= 200 && r.status < 300, `HTTP ${r.status}`, r.text);
  }
  // 11. Injection-ish string into a PUBLIC query input → no 500, no injection, clean response
  {
    const evil = "' OR '1'='1'; DROP TABLE orders;-- <script>alert(1)</script>";
    const r = await hit("GET", "/api/trpc/storefront.getBySlug" + sjGet({ slug: evil }));
    judge("SQL/XSS string into public slug → clean (no 500/leak/injection)", r.status >= 200 && r.status < 500, `HTTP ${r.status}`, r.text);
  }
  // 12. Numeric boundary: negative amount into a validated field (unauth path still exercises zod)
  {
    const r = await hit("POST", "/api/trpc/payment.initiate", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json: { tenantId: "x", orderId: "y", amount: -999999, currency: "NGN" } }) });
    judge("negative amount → rejected by validation/auth (4xx, no 500)", r.status >= 400 && r.status < 500, `HTTP ${r.status}`, r.text);
  }
  // 13. Deeply-nested JSON (parser DoS attempt) → handled, no hang/crash
  {
    let nested: any = {}; let cur = nested; for (let i = 0; i < 5000; i++) { cur.a = {}; cur = cur.a; }
    const r = await hit("POST", "/api/trpc/payment.initiate", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json: nested }) });
    judge("deeply-nested JSON → handled (no hang/crash)", r.status >= 400 && r.status < 600, `HTTP ${r.status}`, r.text);
  }

  // 14. AFTER the barrage: platform is still alive (no crash) — the ultimate black-box health check
  {
    const r = await hit("GET", "/api/health/postgres");
    judge("platform still healthy after the barrage (no crash)", r.status === 200 && /"online":true/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 60)}`);
  }

  console.log(`\n================ BLACK-BOX SUMMARY ================`);
  console.log(`${pass}/${pass + fail} probes behaved correctly.`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("BB_ERROR", e); process.exit(2); });
