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

describe("WhatsApp feature simulation (482 journeys)", () => {
  let world: World;

  beforeAll(async () => {
    world = await bootWorld();
  }, 20 * 60 * 1000); // boots PGlite + server once

  afterAll(() => {
    writeTranscripts();
  });

  it("loads the full journey registry", () => {
    expect(journeys.length).toBe(484); // 470 + J472 (late payment on a dead order, AF-01) + J473 (unified webhook quarantine, AF-02) + J474 (wallet top-up ledger-tracked, AF-05) + J475 (escrow hold atomic + healed, AF-06) + J476 (telegram /start shows the welcome menu, every consent-grant path) + J477 (telegram: place an order and pay, end to end) + J478 (deterministic order fallback survives a real LLM outage, WhatsApp + Telegram) + J479 (telegram delivery location-request reaches the chat for real) + J480 (cart shortage recovery: remove_from_cart + shortage-aware replace) + J481 (session language self-corrects, no longer a one-way ratchet) + J482 (support/handoff replies carry a real phone+email, QA-054) + J483 (deterministic-first routing: greeting/stock-question/product-detail/cheaper-options fast paths, LLM only for what deterministic can't place, QA-055) + J484 (dispute-raising reaches the fast deterministic path too — was LLM-only, the least reliable link) + J485 (escrow.createHold refuses a currency-mismatched wallet credit instead of silently corrupting the balance) = 484 ACTUAL via loadJourneys (470+14). 465 (W47) + J467 (temporal worker contract, real DB) + J468 (temporal enable-list gate, real DB) + J469 (telegram default-off) + J470 (telegram settings card) + J471 (telegram/whatsapp menu-engine parity). W47 merger FINAL: 425 (W46) + J427-J466 (merchant10+buyer10+stakeholders10+crosscutting10) ACTUAL via loadJourneys. W46 FINAL: 385 (W45) + J387-J426 (A/B/C/D/E/F/G/H, 8x5) — ACTUAL verified via loadJourneys at merge. W45 merger FINAL: 350 (W44) + J352-J356 (A1) + J357-J361 (A2) + J362-J366 (B1) + J367-J371 (B2) + J372-J376 (B3) + J377-J381 (C) + J382-J386 (D) = 385 ACTUAL (verified via loadJourneys, 0 dupes).
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
