// === W66 learning ===
/**
 * intentMisses.ts — R8(a) NLP intent-miss learning loop.
 *
 * 1. CAPTURE: the NLP router records low-confidence / unmatched messages
 *    (confidence below INTENT_MISS_CONFIDENCE_THRESHOLD or the "unknown"
 *    fallback intent) into intent_misses (0184). Fail-open, deduped per
 *    (tenant, message-hash, UTC day) so a chatty buyer cannot flood the
 *    review queue.
 * 2. REVIEW: an admin lists pending misses and approves a correction (the
 *    intent the message SHOULD have matched) or rejects it. Claim-first
 *    guarded UPDATE — a double-review is a CONFLICT, never a double append.
 * 3. RETRAIN: approved corrections are appended as JSONL few-shot examples
 *    (server/data/intent-fewshot-examples.jsonl) which buildSystemPrompt
 *    injects into the NLP classifier prompt — the in-repo mirror of the
 *    activeLearning.ts → Label Studio correction loop.
 *
 * Fail-open everywhere: capture/review never break the chat path.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { intentMisses } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const INTENT_MISS_CONFIDENCE_THRESHOLD = 0.5;
export const INTENT_MISS_STATUSES = ["pending", "approved", "rejected"] as const;

function fewshotPath(): string {
  return process.env.INTENT_FEWSHOT_PATH
    ?? path.resolve(process.cwd(), "server/data/intent-fewshot-examples.jsonl");
}

export interface FewShotExample {
  tenantId: string;
  message: string;
  intent: string;
  language?: string | null;
  approvedAt: string;
}

/** Load approved few-shot examples (fail-open: missing/corrupt file → []). */
export function loadFewShotExamples(tenantId?: string, limit = 50): FewShotExample[] {
  try {
    const file = fewshotPath();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    const out: FewShotExample[] = [];
    // Latest-first so recent corrections win the prompt budget.
    for (const line of lines.reverse()) {
      try {
        const ex = JSON.parse(line) as FewShotExample;
        if (!ex.message || !ex.intent) continue;
        if (tenantId && ex.tenantId !== tenantId && out.length >= limit / 2) continue;
        out.push(ex);
        if (out.length >= limit) break;
      } catch { /* skip corrupt line */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Prompt fragment consumed by nlp.ts buildSystemPrompt. */
export function buildFewShotPromptBlock(tenantId?: string, limit = 12): string {
  const examples = loadFewShotExamples(tenantId, limit);
  if (examples.length === 0) return "";
  const lines = examples.map((e) => `"${e.message.slice(0, 120)}" → intent "${e.intent}"`);
  return `\nLEARNED CORRECTIONS (human-reviewed; treat these phrasings as the given intent):\n${lines.join("\n")}\n`;
}

/** Should this classification be captured as a miss? */
export function isIntentMiss(intent: string | null | undefined, confidence: number | null | undefined): boolean {
  if (!intent || intent === "unknown") return true;
  return typeof confidence === "number" && confidence < INTENT_MISS_CONFIDENCE_THRESHOLD;
}

/**
 * Record a miss. Dedupe per (tenant, sha1(message), UTC day) — the same
 * repeated message is captured once per day. Never throws.
 */
export async function captureIntentMiss(
  db: Db,
  input: {
    tenantId: string;
    sessionId?: string;
    channel?: string;
    message: string;
    detectedIntent?: string | null;
    confidence?: number | null;
    language?: string | null;
  },
): Promise<{ captured: boolean; id?: string }> {
  try {
    const message = input.message.trim().slice(0, 2000);
    if (!message) return { captured: false };
    const hash = crypto.createHash("sha1").update(message.toLowerCase()).digest("hex").slice(0, 16);
    const day = new Date().toISOString().slice(0, 10);
    const existing = await db.execute(sql`
      SELECT id FROM intent_misses
      WHERE tenant_id = ${input.tenantId}
        AND status = 'pending'
        AND created_at > ${day}::date
        AND md5(lower(message)) = md5(lower(${message}))
      LIMIT 1
    `).then((r: any) => (r.rows ?? r)).catch(() => [] as any[]);
    if ((existing as any[]).length > 0) return { captured: false };
    const id = crypto.randomUUID();
    await db.insert(intentMisses).values({
      id,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      channel: input.channel,
      message,
      detectedIntent: input.detectedIntent ?? null,
      confidence: typeof input.confidence === "number" ? input.confidence : null,
      language: input.language ?? null,
      status: "pending",
    });
    return { captured: true, id };
  } catch (e: any) {
    console.warn("[intent-miss] capture failed (fail-open):", e?.message);
    return { captured: false };
  }
}

/** Admin review queue. */
export async function listIntentMisses(
  db: Db,
  opts: { tenantId?: string; status?: (typeof INTENT_MISS_STATUSES)[number]; limit?: number } = {},
) {
  const conds = [];
  if (opts.tenantId) conds.push(eq(intentMisses.tenantId, opts.tenantId));
  if (opts.status) conds.push(eq(intentMisses.status, opts.status));
  return db
    .select()
    .from(intentMisses)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(intentMisses.createdAt))
    .limit(Math.min(200, opts.limit ?? 50));
}

/**
 * Approve/reject a miss. Claim-first: only a pending row can transition, so
 * a concurrent double-review cannot append the few-shot twice. On approve,
 * appends the correction to the few-shot JSONL consumed by nlp prompts.
 */
export async function reviewIntentMiss(
  db: Db,
  input: {
    id: string;
    decision: "approved" | "rejected";
    correctedIntent?: string;
    reviewerNotes?: string;
    reviewedBy: string;
  },
): Promise<{ ok: true; miss: typeof intentMisses.$inferSelect } | { ok: false; reason: "not_found" | "already_reviewed" | "missing_correction" }> {
  if (input.decision === "approved" && !input.correctedIntent?.trim()) {
    return { ok: false, reason: "missing_correction" };
  }
  const now = new Date();
  const claimed = await db
    .update(intentMisses)
    .set({
      status: input.decision,
      correctedIntent: input.correctedIntent?.trim() ?? null,
      reviewerNotes: input.reviewerNotes ?? null,
      reviewedBy: input.reviewedBy,
      reviewedAt: now,
      updatedAt: now,
    })
    .where(and(eq(intentMisses.id, input.id), eq(intentMisses.status, "pending")))
    .returning();
  if (claimed.length === 0) {
    const [existing] = await db.select().from(intentMisses).where(eq(intentMisses.id, input.id)).limit(1);
    return { ok: false, reason: existing ? "already_reviewed" : "not_found" };
  }
  const miss = claimed[0];
  if (input.decision === "approved") {
    // Append few-shot example (fail-open file write; the DB row is truth).
    try {
      const file = fewshotPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const ex: FewShotExample = {
        tenantId: miss.tenantId,
        message: miss.message,
        intent: input.correctedIntent!.trim(),
        language: miss.language,
        approvedAt: now.toISOString(),
      };
      fs.appendFileSync(file, JSON.stringify(ex) + "\n");
    } catch (e: any) {
      console.warn("[intent-miss] few-shot append failed (fail-open):", e?.message);
    }
  }
  return { ok: true, miss };
}
// === END W66 learning ===
