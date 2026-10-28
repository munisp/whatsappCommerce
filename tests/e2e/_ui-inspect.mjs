import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/private/tmp/claude-501/-Users-tanitoluwaifegbesan-Documents-54link-newwave-platform-terraform/728bb51e-a82b-469a-9b89-578a45efa5c8/scratchpad/pw/node_modules/playwright");
const BASE = "http://localhost:3000";
const T = JSON.parse(readFileSync(".qa/ui-tokens.json", "utf8")).roles;

const cases = [
  ["operator", T.operator.token, "/platform-admin/"],
  ["analyst", T.analyst.token, "/platform-admin/"],
  ["admin", T.admin.token, "/platform-admin/"],
  ["analyst", T.analyst.token, "/payments"],
  ["admin", T.admin.token, "/platform-admin/revenue"],
  ["owner", T.owner.token, "/tenant-portal/crm"],
];
const b = await chromium.launch({ channel: "chrome", headless: true });
for (const [role, token, path] of cases) {
  const c = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await c.addInitScript((t) => { try { sessionStorage.setItem("manus-cookie", "app_session_id=" + t); } catch {} }, token);
  const p = await c.newPage();
  const bad = [];
  p.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url().replace(BASE, "")}`); });
  await p.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(2500);
  const txt = (await p.evaluate(() => document.body?.innerText ?? "").catch(() => "")).replace(/\s+/g, " ").trim();
  console.log(`\n===== [${role}] ${path} (url now: ${new URL(p.url()).pathname}) =====`);
  console.log("TEXT:", txt.slice(0, 280));
  if (bad.length) console.log("FAILED REQ:", [...new Set(bad)].slice(0, 5).join(" | "));
  await c.close();
}
await b.close();
