/**
 * Vitest wrapper for the WhatsApp simulation so CI (`vitest run`) executes
 * the full 52-journey suite alongside the unit tests.
 *
 * Run directly with:  npm run simulate
 * Or a subset:        npx tsx simulation/runner.ts j03 j18
 */
import { describe, expect, it } from "vitest";
import { loadJourneys, runAll } from "./runner";

// W13: the simulation journeys draw on credit immediately after facility
// approval — disable the first-draw tenure gate (default 7d) for the sim.
process.env.CREDIT_TENURE_GATE_DAYS = "0";

describe("WhatsApp feature simulation (66 journeys)", () => {
  it(
    "runs every journey against the real webhook handlers with Meta mocked",
    async () => {
      const journeys = await loadJourneys();
      expect(journeys.length).toBe(66);
      const results = await runAll();
      const failed = results.filter((r) => !r.pass);
      expect(
        failed.map((f) => `${f.id}: ${f.error}`),
        `${failed.length} journeys failed`,
      ).toEqual([]);
    },
    20 * 60 * 1000, // 20 min — boots PGlite + server once, then all 44
  );
});
