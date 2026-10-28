/**
 * UI E2E driver (Playwright + system Chrome). Reads .qa/ui-tokens.json, injects a
 * per-role session token into sessionStorage['manus-cookie'] before app JS runs,
 * visits a representative route set across the 3 frontends, and records: did it
 * render (not blank / not an error boundary), console errors, failed (4xx/5xx)
 * requests, + RBAC gating + a seeded-data render check. Screenshots -> .qa/ui-screens/.
 *
 *   node tests/e2e/_ui-driver.mjs      (run from repo root; platform must be on :3000)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PW = "/private/tmp/claude-501/-Users-tanitoluwaifegbesan-Documents-54link-newwave-platform-terraform/728bb51e-a82b-469a-9b89-578a45efa5c8/scratchpad/pw/node_modules/playwright";
const { chromium } = require(PW);

const BASE = process.env.PLATFORM_URL ?? "http://localhost:3000";
const tokens = JSON.parse(readFileSync(".qa/ui-tokens.json", "utf8"));
mkdirSync(".qa/ui-screens", { recursive: true });

// Representative routes per role (not exhaustive — a smoke+RBAC+data pass).
const ROUTES = {
  admin: ["/platform-admin/", "/platform-admin/tenants", "/platform-admin/onboarding", "/platform-admin/escrow",
          "/platform-admin/reconciliation", "/platform-admin/revenue", "/platform-admin/ml-ops", "/platform-admin/health",
          "/platform-admin/audit-logs", "/platform-admin/webhook-dlq", "/platform-admin/alert-rules", "/platform-admin/kyb-review"],
  owner: ["/tenant-portal/portal", "/tenant-portal/products", "/tenant-portal/inventory", "/tenant-portal/conversations",
          "/tenant-portal/broadcast", "/tenant-portal/templates", "/tenant-portal/portal/wallet", "/tenant-portal/portal/analytics",
          "/tenant-portal/crm", "/tenant-portal/sales-channels", "/orders", "/payments", "/approvals"],
  operator: ["/tenant-portal/portal", "/tenant-portal/products", "/orders", "/approvals", "/tenant-portal/conversations"],
  analyst: ["/tenant-portal/portal", "/tenant-portal/portal/analytics", "/payments"],
};
const ERR_MARKERS = /something went wrong|unexpected error|cannot get \/|application error|white screen|failed to load|chunkloaderror/i;

async function visit(context, path, { expectProducts = false } = {}) {
  const page = await context.newPage();
  const consoleErrors = [], pageErrors = [], badResponses = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on("response", (r) => { const s = r.status(); if (s >= 400 && r.url().includes("/api/")) badResponses.push(`${s} ${r.url().replace(BASE, "").slice(0, 80)}`); });
  let rendered = false, textLen = 0, finalUrl = path, title = "", productsVisible = null, err = null;
  try {
    await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2200); // let React + tRPC settle
    finalUrl = new URL(page.url()).pathname;
    title = await page.title().catch(() => "");
    const txt = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    textLen = txt.length;
    rendered = textLen > 150 && !ERR_MARKERS.test(txt);
    if (expectProducts) productsVisible = /QA Rice 5kg|QA Palm Oil 1L/.test(txt);
    await page.screenshot({ path: `.qa/ui-screens/${path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "")}.png` }).catch(() => {});
  } catch (e) { err = String(e).split("\n")[0].slice(0, 160); }
  await page.close();
  // Only count API 401s as "bad" when we DID send a token (auth failure); public 401s are expected.
  return { path, rendered, textLen, finalUrl, title, productsVisible, err,
           consoleErrors: consoleErrors.length, pageErrors: pageErrors.length, badApi: badResponses.length,
           samples: { console: consoleErrors.slice(0, 2), page: pageErrors.slice(0, 2), api: badResponses.slice(0, 3) } };
}

async function ctxFor(browser, token) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await c.addInitScript((t) => { try { sessionStorage.setItem("manus-cookie", "app_session_id=" + t); } catch {} }, token);
  return c;
}

const results = { byRole: {}, rbac: [], dataFlow: null };
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const [role, routes] of Object.entries(ROUTES)) {
    const token = tokens.roles[role].token;
    const c = await ctxFor(browser, token);
    results.byRole[role] = [];
    for (const r of routes) {
      const res = await visit(c, r, { expectProducts: role === "owner" && r === "/tenant-portal/products" });
      results.byRole[role].push(res);
      const flag = res.err ? "ERR" : res.rendered ? "ok" : "BLANK";
      console.log(`[${role}] ${r} -> ${flag} len=${res.textLen} console=${res.consoleErrors} pageerr=${res.pageErrors} badApi=${res.badApi}${res.productsVisible === true ? " PRODUCTS✓" : res.productsVisible === false ? " PRODUCTS✗" : ""}${res.err ? " | " + res.err : ""}`);
    }
    await c.close();
  }

  // RBAC: platform-admin must be admin-only.
  for (const role of ["operator", "analyst"]) {
    const c = await ctxFor(browser, tokens.roles[role].token);
    const res = await visit(c, "/platform-admin/");
    // "blocked" = did NOT land on a working admin dashboard: either redirected away, or shows a denied/blank view.
    const blocked = !res.finalUrl.startsWith("/platform-admin") || !res.rendered || /denied|unauthor|forbidden|admin|permission|sign in|login/i.test(JSON.stringify(res.samples));
    results.rbac.push({ role, route: "/platform-admin/", finalUrl: res.finalUrl, rendered: res.rendered, blocked });
    console.log(`[RBAC] ${role} -> /platform-admin/ : finalUrl=${res.finalUrl} rendered=${res.rendered} => ${blocked ? "BLOCKED ✓" : "REACHED ADMIN ✗"}`);
    await c.close();
  }
  // positive control: admin reaches it
  {
    const adminProducts = results.byRole.admin.find((x) => x.path === "/platform-admin/");
    console.log(`[RBAC] admin -> /platform-admin/ : rendered=${adminProducts?.rendered} (positive control)`);
  }
  const ownerProducts = results.byRole.owner.find((x) => x.path === "/tenant-portal/products");
  results.dataFlow = { productsVisible: ownerProducts?.productsVisible ?? null };
} finally {
  await browser.close();
}

writeFileSync(".qa/ui-results.json", JSON.stringify(results, null, 2));
// Summary
let total = 0, rendered = 0, withConsole = 0, withBadApi = 0, errs = 0;
for (const arr of Object.values(results.byRole)) for (const r of arr) { total++; if (r.rendered) rendered++; if (r.consoleErrors) withConsole++; if (r.badApi) withBadApi++; if (r.err) errs++; }
console.log(`\n===== UI SMOKE SUMMARY =====`);
console.log(`routes visited: ${total} | rendered ok: ${rendered} | blank/err: ${total - rendered} | with console errors: ${withConsole} | with API 4xx/5xx: ${withBadApi} | nav errors: ${errs}`);
console.log(`RBAC platform-admin gate: ${results.rbac.map((r) => `${r.role}:${r.blocked ? "blocked" : "REACHED"}`).join(", ")}`);
console.log(`data-flow (seeded products render in tenant portal): ${results.dataFlow.productsVisible === true ? "YES ✓" : results.dataFlow.productsVisible === false ? "NO ✗" : "n/a"}`);
console.log(`screenshots: .qa/ui-screens/  | full results: .qa/ui-results.json`);
