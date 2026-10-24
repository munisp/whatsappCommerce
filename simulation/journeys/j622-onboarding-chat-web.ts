// === W65 conversational ===
/**
 * J622 — R2 chat-first web onboarding: drives the NEW onboardingChat tRPC
 * facade (start → step → decide cards → goLive) end-to-end. The facade runs
 * the SAME copilot agent/tools as WhatsApp onboarding; go-live creates the
 * tenant through the EXISTING path (KYB-gated, W47). Settings restored at
 * the end so the suite is unaffected.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, approveKyb, tenantRowById } from "./helpers";

export const journey: Journey = {
  id: "J622",
  name: "onboardingChat web facade: start → steps → confirm cards → tenant live",
  feature: "W65 R2 chat-first web onboarding (tRPC facade over onboardingCopilot)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const settingsBefore = await world.tenantSettings();
    try {
      const caller = await adminCaller();

      // ── start: greeting + intake state ───────────────────────────────────
      const started: any = await caller.onboardingChat.start({ tenantId: TENANT_ID });
      assert(started.sessionId, "start returns a session id");
      assert(typeof started.greeting === "string" && started.greeting.length > 0, "greeting returned");
      assert(started.state === "intake", `fresh session in intake (got ${started.state})`);
      const sessionId = started.sessionId as string;

      // ── step: free-text intake → proposal cards ──────────────────────────
      const stepped: any = await caller.onboardingChat.step({
        sessionId,
        text: "I run Sim Chat Store in Lagos, groceries + fashion, delivery within Lagos, bank transfer",
      });
      assert(stepped.state === "approving", `proposals awaiting approval (got ${stepped.state})`);
      const pending = (stepped.proposals as any[]).filter((p) => p.status === "pending");
      assert(pending.length >= 3, `confirmable proposal cards returned (got ${pending.length})`);

      // ── confirm every card through the facade ────────────────────────────
      for (const p of pending) {
        const after: any = await caller.onboardingChat.decide({ sessionId, proposalId: p.id, approve: true });
        assert(after.sessionId === sessionId, "decide returns the session snapshot");
      }
      // After approvals the copilot configures + validates → validating
      // (decideProposal runs the configuration phase, per J44). Resume via
      // the facade's start({resume:true}) to fetch the fresh snapshot.
      const live: any = await caller.onboardingChat.start({ tenantId: TENANT_ID });
      const goLive = (live.proposals as any[]).find((p) => p.kind === "goLive" && p.status === "pending");
      assert(goLive, `goLive proposal emitted (state ${live.state})`);

      // ── go live through the existing path (KYB gate, W47) ────────────────
      await approveKyb(world, TENANT_ID);
      const goLived: any = await caller.onboardingChat.decide({ sessionId, proposalId: goLive.id, approve: true });
      assert(goLived.state === "live", `session live after goLive approval (got ${goLived.state})`);
      const tenant = await tenantRowById(world, TENANT_ID);
      assert(tenant?.status === "active", `tenant active (got ${tenant?.status})`);

      // ── reset: abandons (terminal sessions pass through) and starts fresh ─
      const fresh: any = await caller.onboardingChat.reset({ sessionId });
      assert(fresh.sessionId && fresh.sessionId !== sessionId, "reset starts a fresh session");
    } finally {
      await world.db
        .update(schema.tenants)
        .set({ settings: settingsBefore, updatedAt: new Date() })
        .where(eq(schema.tenants.id, TENANT_ID));
    }
  },
};
