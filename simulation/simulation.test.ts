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
import { bootWorld, type World } from "./world";
import { loadJourneys, runOneJourney, writeTranscripts } from "./runner";

// W13: the simulation journeys draw on credit immediately after facility
// approval — disable the first-draw tenure gate (default 7d) for the sim.
process.env.CREDIT_TENURE_GATE_DAYS = "0";

// Journey modules are cheap dynamic imports (no world boot) — safe at
// module top level so every journey gets a statically-defined test block.
const journeys = await loadJourneys();

describe("WhatsApp feature simulation (181 journeys)", () => {
  let world: World;

  beforeAll(async () => {
    world = await bootWorld();
  }, 20 * 60 * 1000); // boots PGlite + server once

  afterAll(() => {
    writeTranscripts();
  });

  it("loads the full journey registry", () => {
    expect(journeys.length).toBe(214); // W33 merger: 205 + J206-J208 (tax-statements) + J209-J211 (ai-qa-forecast) + J212-J214 (embedded-api)
    const ids = journeys.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const j of journeys) {
    it(
      `${j.id} ${j.name} [${j.feature}]`,
      async () => {
        const result = await runOneJourney(world, j);
        expect(result.pass, result.error ?? "").toBe(true);
      },
      5 * 60 * 1000,
    );
  }
});
