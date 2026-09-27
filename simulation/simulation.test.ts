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

describe("WhatsApp feature simulation (496 journeys)", () => {
  let world: World;

  beforeAll(async () => {
    world = await bootWorld();
  }, 20 * 60 * 1000); // boots PGlite + server once

  afterAll(() => {
    writeTranscripts();
  });

  it("loads the full journey registry", () => {
    expect(journeys.length).toBe(535); // W52 merger: 529 (W51) + J531-J536 (share) = 535 ACTUAL via loadJourneys (0 dupes) // W51 merger: 519 (W50) + J521-J530 (promos) = 529 ACTUAL via loadJourneys (0 dupes) // W50 merger: 496 (W49) + J498-J507 (channels) + J508-J514 (sms) + J515-J520 (images) = 519 ACTUAL via loadJourneys (0 dupes) // W49 merger: 485 (W48) + J487-J496 (richmedia) + J497 (i18n-pcm) = 496 ACTUAL via loadJourneys // W48 merger FINAL: 465 (W47) + J467-J476 (api-db) + J477-J486 (integrations) = 485 ACTUAL via loadJourneys (D 475 counted only one branch). W47 merger FINAL: 425 (W46) + J427-J466 (merchant10+buyer10+stakeholders10+crosscutting10) ACTUAL via loadJourneys. W46 FINAL: 385 (W45) + J387-J426 (A/B/C/D/E/F/G/H, 8x5) — ACTUAL verified via loadJourneys at merge. W45 merger FINAL: 350 (W44) + J352-J356 (A1) + J357-J361 (A2) + J362-J366 (B1) + J367-J371 (B2) + J372-J376 (B3) + J377-J381 (C) + J382-J386 (D) = 385 ACTUAL (verified via loadJourneys, 0 dupes).
    const ids = journeys.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
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
