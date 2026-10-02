// === W59 banking-pos ===
/**
 * J601 — softpos integration doc contract + route/scheduler registration:
 * docs/softpos-integration.md asserts the no-PAN contract; the POS webhook
 * route and /api/scheduled/pos-expiry are registered with the scheduler
 * allowlist (J178 parity).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J601",
  name: "softpos doc contract + POS route/scheduler registration",
  feature: "W59 banking-pos: docs/softpos-integration.md",
  async run(_world: World) {
    const doc = fs.readFileSync(path.join(ROOT, "docs/softpos-integration.md"), "utf-8");
    for (const frag of [
      "SoftPOS SDK",
      "NEVER transit or persist on the platform",
      "POST /api/webhooks/pos/:provider",
      "x-softpos-signature",
      "claim-first",
      "/api/scheduled/pos-expiry",
      "expresspay://pos/pay",
    ]) assert(doc.includes(frag), `softpos doc missing: ${frag}`);

    const indexSrc = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
    assert(indexSrc.includes('"/api/webhooks/pos/:provider"'), "POS webhook route registered");
    assert(indexSrc.includes('app.post("/api/scheduled/pos-expiry"'), "pos-expiry route registered");
    const scheduler = await import("../../services/scheduler/scheduler.mjs");
    assert(scheduler.SCHEDULE.some((r: { path: string }) => r.path === "/api/scheduled/pos-expiry"),
      "scheduler allowlist has pos-expiry");

    // paymentConfirm.ts is byte-locked (soc2-check): POS settles via the
    // adjacent webhook seam, never that file.
    const { createHash } = await import("node:crypto");
    const md5 = createHash("md5").update(fs.readFileSync(path.join(ROOT, "server/services/paymentConfirm.ts"))).digest("hex");
    assert(md5 === "b360df289b9f62e17d48a3d209a4b88f", "paymentConfirm.ts md5 unchanged");
  },
};
