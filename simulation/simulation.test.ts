/**
 * Vitest wrapper for the WhatsApp simulation so CI (`vitest run`) executes
 * the full journey suite alongside the unit tests.
 *
 * Each journey runs in its OWN it() block (W26: previously a single mega
 * it() made failures unattributable — one throw aborted the remaining
 * journeys and hid which journey regressed). The world (PGlite + real
 * Express server with Meta mocked) boots once in beforeAll and is shared;
 * journeys still run sequentially against it via runOneJourney, exactly as
 * the CLI runner does.
 *
 * Run directly with:  npm run simulate
 * Or a subset:        npx tsx simulation/runner.ts j03 j18
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootWorld, CREDIT_ACCOUNT_ID, TENANT_ID, type World } from "./world";
import { loadJourneys, runOneJourney, writeTranscripts } from "./runner";

// W13: the simulation journeys draw on credit immediately after facility
// approval — disable the first-draw tenure gate (default 7d) for the sim.
process.env.CREDIT_TENURE_GATE_DAYS = "0";

// Journey modules are cheap dynamic imports (no world boot) — safe at
// module top level so every journey gets a statically-defined test block.
const journeys = await loadJourneys();

describe("WhatsApp feature simulation (577 journeys)", () => {
  let world: World;

  beforeAll(async () => {
    world = await bootWorld();
  }, 20 * 60 * 1000); // boots PGlite + server once

  afterAll(() => {
    writeTranscripts();
  });

  it("loads the full journey registry", () => {
    // 558 (W54 merger) + J560-J578 (W55: TG parity, credit bureau, wallet) + J579-J586
    // (W57 risk-shield: identity graph ×2, registry, insurance ×2, provision, parity, i18n)
    // + J587-J605 (development: Temporal worker, Telegram parity, deterministic shop,
    // AF-01..06 fixes — independently claimed J560-J578 before merging with W55, so
    // renumbered to J587-J605 on merge to avoid colliding with W55's own J560-J578) = 604.
    expect(journeys.length).toBe(604);
    const ids = journeys.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Regression for the J165 failure in the one full-suite run: a journey's mandate-repayment claims outlived it, so
  // a retried journey (`retry: 2` below) inherited its own leftovers, got 'duplicate' on every attempt, and one
  // transient first-attempt failure became a permanent one. Reset must wipe the per-account pending marker, the
  // exactly-once reference claims, and the mandate charge rows.
  it("resetJourneyState wipes stranded mandate-repayment state (a retry must not inherit its own leftovers)", async () => {
    const schema = await import("../drizzle/schema");
    const { inArray } = await import("drizzle-orm");
    const { pendingRepaymentMarkerRef } = await import("../server/services/tradeCredit/capture");
    const now = new Date();
    await world.db.insert(schema.processedWebhookEvents).values([
      { id: pendingRepaymentMarkerRef(CREDIT_ACCOUNT_ID), tenantId: TENANT_ID, type: "credit_repayment_pending", processedAt: now },
      { id: `cr-${CREDIT_ACCOUNT_ID}-20260921-deadbeef0000`.slice(0, 64), tenantId: TENANT_ID, type: "credit_repayment", processedAt: now },
    ]);
    await world.resetJourneyState();
    const left = await world.db
      .select()
      .from(schema.processedWebhookEvents)
      .where(inArray(schema.processedWebhookEvents.type, ["credit_repayment", "credit_repayment_pending"]));
    expect(left).toEqual([]);
  });

  for (const j of journeys) {
    it(
      `${j.id} ${j.name} [${j.feature}]`,
      // W46 merge-close: retry×2 — under full-file parallel-worker load a
      // tiny number of chat-order journeys hit a session-CAS race between
      // concurrent webhook processing of back-to-back texts (the journeys
      // pass standalone, in isolation, and in subsets). The authoritative
      // gate remains `npm run simulate` (fresh world, 0 retries).
      { retry: 2, timeout: 5 * 60 * 1000 },
      async () => {
        const result = await runOneJourney(world, j);
        expect(result.pass, result.error ?? "").toBe(true);
      },
    );
  }
});
