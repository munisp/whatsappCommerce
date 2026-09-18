/**
 * === W42 workflows (Coder C / PLT-15) ===
 * J318 — The real-PG money-path integration profile is honestly gated:
 * without PG_INTEGRATION=1 it reports a SKIP with enable instructions (never
 * a fabricated pass); with PG_INTEGRATION=1 it enables against a real URL.
 * The docker-compose postgres:16 service is the documented target.
 */
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J318",
  name: "PG integration profile honest-skip",
  feature: "PG_INTEGRATION=1 gate: honest skip without real PG, never fake pass",
  async run() {
    const { pgIntegrationGate } = await import("../../scripts/pg-integration-money-paths");

    // Disabled by default → honest skip with actionable instructions.
    const off = pgIntegrationGate({} as NodeJS.ProcessEnv);
    assert(off.enabled === false, "gate disabled without PG_INTEGRATION=1");
    assertIncludes(off.reason, "PG_INTEGRATION", "skip reason names the opt-in flag");
    assertIncludes(off.reason, "docker compose up -d postgres", "skip reason tells how to enable real PG");

    // Explicit opt-in → enabled, pointing at a real PG URL.
    const on = pgIntegrationGate({ PG_INTEGRATION: "1" } as NodeJS.ProcessEnv);
    assert(on.enabled === true, "gate enabled with PG_INTEGRATION=1");
    assert(typeof on.databaseUrl === "string" && on.databaseUrl.startsWith("postgres"), "enabled gate carries a postgres URL");

    // The compose stack really ships a postgres:16 service (the profile target).
    const fs = await import("node:fs");
    const compose = fs.readFileSync("docker-compose.yml", "utf8");
    assertIncludes(compose, "postgres:16", "docker-compose ships postgres:16 for the integration profile");

    // The runner script exists, is registered, and targets the W38 suite.
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    assertIncludes(pkg.scripts["test:pg-integration"], "pg-integration-money-paths", "npm script wired");
    const script = fs.readFileSync("scripts/pg-integration-money-paths.ts", "utf8");
    for (const j of ["J247", "J250", "J253"]) {
      assertIncludes(script, j, `integration suite covers W38 money journey ${j}`);
    }
  },
};
