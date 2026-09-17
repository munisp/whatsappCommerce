// === W45 go-rust-services ===
/**
 * J382 — hermes-bridge PO approval contract (MSG-15): pending approvals are
 * persisted in Redis with TTL + reminder/expiry sweep (no restart-lossy
 * sync.Map), and the merchant notification is an approved WhatsApp template
 * with quick-reply buttons (24h-window safe). Source-level contract checks
 * against the Go service plus the TS-visible config surface (env.example.txt,
 * k8s manifest) — lazy imports only, no Go process is booted.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const journey: Journey = {
  id: "J382",
  name: "hermes PO approval persistence + template buttons",
  feature: "go-rust services: MSG-15 approval durability",
  async run() {
    const main = await readFile(`${repoRoot}/services/hermes-bridge/main.go`, "utf8");
    const approvals = await readFile(`${repoRoot}/services/hermes-bridge/approvals.go`, "utf8");

    // ── sync.Map pendingApprovals is gone ──────────────────────────────────
    assert(!main.includes("pendingApprovals sync.Map"), "in-memory pendingApprovals sync.Map must be gone");
    assert(!main.includes("sync.Map"), "no sync.Map anywhere in main.go");

    // ── Durable store: Redis SETEX + expiry/reminder sorted sets ───────────
    assertIncludes(approvals, "hermes:approval:", "Redis approval key namespace");
    assertIncludes(approvals, "hermes:approvals:expiry", "expiry sorted set");
    assertIncludes(approvals, "hermes:approvals:reminder", "reminder sorted set");
    assertIncludes(approvals, "StartApprovalSweep", "reminder/expiry sweep entrypoint");
    assertIncludes(approvals, "REDIS_URL is required in production", "fail-closed without Redis in prod");
    assertIncludes(approvals, `Decision:      "expired"`, "expiry notifies platform");

    // ── Store is wired into the processor and decision path ────────────────
    assertIncludes(main, "approvals ApprovalStore", "EventProcessor carries the durable store");
    assertIncludes(main, "ep.approvals.Save(ctx, po", "po_draft callback persists before send");
    assertIncludes(main, "ep.approvals.Get(ctx, reply.ApprovalToken)", "merchant decision resolves from store");
    assertIncludes(main, "unknown or expired", "expired tokens rejected honestly");

    // ── 24h-window-safe template with quick-reply buttons ──────────────────
    assertIncludes(main, '"type":              "template"', "approval send uses a template message");
    assertIncludes(main, '"sub_type":  "quick_reply"', "quick-reply buttons");
    assertIncludes(main, '"APPROVE " + po.ApprovalToken', "approve button payload carries token");
    assertIncludes(main, '"REJECT " + po.ApprovalToken', "reject button payload carries token");
    assert(!main.includes('"type":              "text"'), "free-form text approval send removed");

    // ── TS-visible config surface is documented ────────────────────────────
    const envExample = await readFile(`${repoRoot}/env.example.txt`, "utf8");
    assertIncludes(envExample, "WA_PO_APPROVAL_TEMPLATE", "env.example documents approval template");
    assertIncludes(envExample, "APPROVAL_TTL_MINUTES", "env.example documents approval TTL");

    // ── k8s manifest injects REDIS_URL (approvals survive restarts) ────────
    const k8s = await readFile(`${repoRoot}/k8s/hermes-bridge.yaml`, "utf8");
    assertIncludes(k8s, "REDIS_URL", "k8s hermes-bridge gets REDIS_URL");
    assertIncludes(k8s, 'value: "production"', "k8s runs hermes-bridge in production mode (fail-closed)");
  },
};
