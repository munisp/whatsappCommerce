// === W66 learning ===
/**
 * J626 — R8(a) intent-miss learning loop (services/intentMisses.ts):
 *   1. isIntentMiss flags low-confidence + unknown-intent classifications.
 *   2. captureIntentMiss records a pending row; the same message re-sent the
 *      same day is deduped.
 *   3. Admin review (learning.reviewIntentMiss) approves with a correction →
 *      the few-shot JSONL gains an example and buildFewShotPromptBlock
 *      injects it for NLP prompts; a double review is a CONFLICT.
 *   4. The nlp router is wired (few-shot injection + capture call sites).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J626",
  name: "intent-miss capture, dedupe, admin review → few-shot prompt examples",
  feature: "W66 R8(a) NLP intent-miss loop",
  async run(world: World) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j626-fewshot-"));
    process.env.INTENT_FEWSHOT_PATH = path.join(dir, "fewshot.jsonl");
    try {
      const svc = await import("../../server/services/intentMisses");

      assert(svc.isIntentMiss("unknown", 0), "unknown is a miss");
      assert(svc.isIntentMiss("search", 0.3), "low confidence is a miss");
      assert(!svc.isIntentMiss("search", 0.9), "confident match is not a miss");

      // ── Capture + same-day dedupe ──────────────────────────────────────
      const c1 = await svc.captureIntentMiss(world.db, {
        tenantId: TENANT_ID, sessionId: "nlp-j626", channel: "whatsapp",
        message: "abeg i wan buy dat tin wey dey red", detectedIntent: "unknown", confidence: 0,
      });
      assert(c1.captured && c1.id, "first capture");
      const c2 = await svc.captureIntentMiss(world.db, {
        tenantId: TENANT_ID, message: "abeg i wan buy dat tin wey dey red", detectedIntent: "unknown", confidence: 0,
      });
      assert(!c2.captured, "same-day dedupe");

      // ── Admin review via router: approve → few-shot appended ──────────
      const admin = await adminCaller();
      const queue = await admin.learning.intentMisses({ tenantId: TENANT_ID, status: "pending" });
      assert(queue.some((m: any) => m.id === c1.id), "miss in pending queue");
      const reviewed = await admin.learning.reviewIntentMiss({
        id: c1.id!, decision: "approved", correctedIntent: "browse",
      });
      assert(reviewed.status === "approved" && reviewed.correctedIntent === "browse", "approved with correction");

      const lines = fs.readFileSync(process.env.INTENT_FEWSHOT_PATH!, "utf8").trim().split("\n");
      assert(lines.length === 1, `few-shot lines ${lines.length}`);
      const ex = JSON.parse(lines[0]);
      assert(ex.intent === "browse" && ex.tenantId === TENANT_ID, "few-shot content");
      const block = svc.buildFewShotPromptBlock(TENANT_ID);
      assert(block.includes('intent "browse"'), "prompt block includes correction");

      // ── Double review → CONFLICT (claim-first) ─────────────────────────
      let conflict = false;
      try {
        await admin.learning.reviewIntentMiss({ id: c1.id!, decision: "approved", correctedIntent: "search" });
      } catch (e: any) {
        conflict = /already_reviewed/i.test(e?.message ?? "");
      }
      assert(conflict, "second review conflicts");
      const linesAfter = fs.readFileSync(process.env.INTENT_FEWSHOT_PATH!, "utf8").trim().split("\n");
      assert(linesAfter.length === 1, "no double append");

      // ── nlp.ts wiring: few-shot injection + capture call site ─────────
      const nlpSrc = fs.readFileSync(path.join(ROOT, "server/routers/nlp.ts"), "utf8");
      assert(nlpSrc.includes("buildFewShotPromptBlock"), "few-shot injected into system prompt");
      assert(nlpSrc.includes("captureIntentMiss"), "capture call site present");
    } finally {
      delete process.env.INTENT_FEWSHOT_PATH;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};
