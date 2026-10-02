// === W60 persistence ===
/**
 * J606 — W60-A MEDIUM #18: the onboarding EDIT pending-proposal marker is
 * Redis-primary (hash wa:onb:edit, 30-min TTL) with production fail-closed,
 * so it survives a restart. The sim drives the injected store seam
 * (__setOnboardingEditStoreForTest — mirrors cronAuth's CronReplayStore)
 * with a store that OUTLIVES a simulated process restart:
 *
 *   1. WA interactive EDIT reply parks the proposal in the durable store.
 *   2. Simulated restart: the exported in-memory fallback Map is wiped —
 *      the pending edit is still served from the durable store and the
 *      follow-up free text applies the edit (proposal rejected + redrafted).
 *   3. TTL + prod fail-closed source contract is asserted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Durable fake "Redis hash" surviving simulated restarts (with TTL). */
function durableStore() {
  const data = new Map<string, { v: string; exp: number }>();
  return {
    async set(phone: string, proposalId: string, ttlSeconds: number) {
      data.set(phone, { v: proposalId, exp: Date.now() + ttlSeconds * 1000 });
    },
    async get(phone: string) {
      const e = data.get(phone);
      if (!e) return undefined;
      if (e.exp <= Date.now()) { data.delete(phone); return undefined; }
      return e.v;
    },
    async del(phone: string) { data.delete(phone); },
    size: () => data.size,
  };
}

export const journey: Journey = {
  id: "J606",
  name: "onboarding edit proposal survives restart (Redis-primary store)",
  feature: "W60 persistence: waOnboarding pending edit proposals",
  async run(world: World) {
    const mod = await import("../../server/services/waOnboarding");
    const store = durableStore();
    mod.__setOnboardingEditStoreForTest(store);
    const phone = world.newPhone("606");
    try {
      // Scripted copilot: one active session with proposal prop-606.
      const session = { id: "sess-606", state: "drafting" } as any;
      const decisions: Array<{ proposalId: string; approve: boolean }> = [];
      mod.setOnboardingCopilot({
        async findActiveSessionByPhone() { return session; },
        async startSession() { return { greeting: "hi" }; },
        async decideProposal(d: any) { decisions.push(d); return { replies: [{ type: "text", text: "rejected, redrafting" }] }; },
        async postMessage() { return { replies: [{ type: "text", text: "revised proposal" }], state: "drafting" }; },
        async getSession() { return session; },
      } as any);
      // Capture outbound text sends via the module's sender seam: the sim
      // intercepts WA sends globally, so just run the flows.

      // ── 1. Interactive EDIT reply parks the proposal durably ──────────
      const editRes = await mod.handleInbound(
        { type: "interactive", interactive: { button_reply: { id: mod.toWireActionId("edit:prop-606") } } },
        phone,
      );
      assert(editRes.handled && editRes.outcome === "edit_prompt", `edit prompt (got ${editRes.outcome})`);
      assert((await store.get(phone)) === "prop-606", "proposal parked in durable store");

      // ── 2. Simulated restart: wipe ALL in-proc fallback state ─────────
      mod.pendingEditProposals.clear();
      assert(mod.pendingEditProposals.size === 0, "in-proc fallback empty post-restart");

      // Follow-up free text still resolves the pending edit from the store.
      const applied = await mod.handleInbound({ type: "text", text: { body: "change the price to 5000" } }, phone);
      assert(applied.handled && applied.outcome === "edit_applied", `edit applied after restart (got ${applied.outcome})`);
      assert(decisions.some((d) => d.proposalId === "prop-606" && d.approve === false), "stale proposal rejected before redraft");
      assert((await store.get(phone)) === undefined, "pending edit consumed exactly once");

      // ── 3. Source contract: Redis hash + TTL + prod fail-closed ───────
      const src = fs.readFileSync(path.join(ROOT, "server/services/waOnboarding.ts"), "utf-8");
      assert(src.includes('"wa:onb:edit"'), "Redis hash key");
      assert(src.includes("PersistedStateUnavailableError"), "prod fail-closed error");
      assert(/ONB_EDIT_TTL_S = 30 \* 60/.test(src), "30-min proposal TTL");
    } finally {
      mod.__setOnboardingEditStoreForTest(null);
      mod.setOnboardingCopilot(null);
    }
  },
};
