/**
 * simulation/runner.ts — executes every journey and prints the result matrix.
 *
 * Usage:  npm run simulate        (tsx simulation/runner.ts)
 *         tsx simulation/runner.ts J03 J17   (subset)
 *
 * Exit code 0 when every journey passes. The vitest wrapper
 * (simulation/simulation.test.ts) calls runAll() so CI runs the same suite.
 */
import { bootWorld, type World } from "./world";
import { recorder } from "./transcript";

export interface Journey {
  id: string;
  name: string;
  feature: string;
  run: (world: World) => Promise<void>;
}

export interface JourneyResult {
  id: string;
  name: string;
  feature: string;
  pass: boolean;
  durationMs: number;
  error?: string;
}

export async function loadJourneys(): Promise<Journey[]> {
  const mods = await Promise.all([
    import("./journeys/j01-consent"),
    import("./journeys/j02-menu"),
    import("./journeys/j03-nlp-order"),
    import("./journeys/j04-menu-shop"),
    import("./journeys/j05-delivery-location"),
    import("./journeys/j06-promo"),
    import("./journeys/j07-payment-confirm"),
    import("./journeys/j08-receipt-screenshot"),
    import("./journeys/j09-order-action-card"),
    import("./journeys/j10-shipment-pin-reaction"),
    import("./journeys/j11-tracking-token"),
    import("./journeys/j12-smart-reorder"),
    import("./journeys/j13-abandoned-cart"),
    import("./journeys/j14-faq"),
    import("./journeys/j15-voice-note"),
    import("./journeys/j16-multilingual"),
    import("./journeys/j17-visual-search"),
    import("./journeys/j18-stock-guard"),
    import("./journeys/j19-restock-notify"),
    import("./journeys/j20-broadcast"),
    import("./journeys/j21-templates"),
    import("./journeys/j22-ctwa"),
    import("./journeys/j23-window-expiry"),
    import("./journeys/j24-delivery-status-pipeline"),
    import("./journeys/j25-read-receipts"),
    import("./journeys/j26-webhook-dedupe"),
    import("./journeys/j27-dispute"),
    import("./journeys/j28-ussd"),
    import("./journeys/j29-meta-catalog"),
    import("./journeys/j30-contact-provisioning"),
    import("./journeys/j31-procurement-menu"),
    import("./journeys/j32-po-submit"),
    import("./journeys/j33-approve-credit-draw"),
    import("./journeys/j34-overdraw-refusal"),
    import("./journeys/j35-paynow-po"),
    import("./journeys/j36-partial-repayment"),
    import("./journeys/j37-dunning"),
    import("./journeys/j38-default-freeze"),
    import("./journeys/j39-whatsapp-full-onboarding"),
    import("./journeys/j40-edit-path"),
    import("./journeys/j41-checkpoint-enforcement"),
    import("./journeys/j42-validation-repair"),
    import("./journeys/j43-idempotency-resume-restart"),
    import("./journeys/j44-admin-channel"),
    import("./journeys/j45-secrets-roundtrip"),
    import("./journeys/j46-observability-capture"),
  ]);
  return mods.map((m) => m.journey as Journey);
}

export async function runAll(only?: string[]): Promise<JourneyResult[]> {
  const world = await bootWorld();
  const all = await loadJourneys();
  const selected = only?.length
    ? all.filter((j) => only.some((o) => j.id.toLowerCase() === o.toLowerCase() || j.id.toLowerCase() === `j${o.padStart(2, "0")}`))
    : all;

  const results: JourneyResult[] = [];
  for (const j of selected) {
    const start = Date.now();
    await world.resetJourneyState();
    recorder.begin(j.id, j.name, j.feature);
    try {
      await j.run(world);
      await world.settle(300);
      recorder.end(true);
      results.push({ id: j.id, name: j.name, feature: j.feature, pass: true, durationMs: Date.now() - start });
    } catch (e: any) {
      recorder.end(false);
      results.push({
        id: j.id, name: j.name, feature: j.feature, pass: false, durationMs: Date.now() - start,
        error: String(e?.stack ?? e?.message ?? e),
      });
    }
  }
  if (process.env.SIM_TRANSCRIPTS !== "off") {
    const dir = recorder.writeAll();
    if (!process.env.VITEST) console.log(`\ntranscripts → ${dir}`);
  }
  return results;
}

export function printMatrix(results: JourneyResult[]): void {
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  console.log("\n╔════════╦══════════════════════════════╦════════════════════════════╦════════╦═════════╗");
  console.log("║ ID     ║ Journey                      ║ Feature                    ║ Result ║ ms      ║");
  console.log("╠════════╬══════════════════════════════╬════════════════════════════╬════════╬═════════╣");
  for (const r of results) {
    console.log(
      `║ ${pad(r.id, 6)} ║ ${pad(r.name, 28)} ║ ${pad(r.feature, 26)} ║ ${r.pass ? "PASS  " : "FAIL  "} ║ ${String(r.durationMs).padEnd(7)} ║`,
    );
    if (!r.pass && r.error) {
      const lines = r.error.split("\n").slice(0, 8);
      for (const line of lines) console.log(`║        ↳ ${line.slice(0, 120)}`);
    }
  }
  console.log("╚════════╩══════════════════════════════╩════════════════════════════╩════════╩═════════╝");
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} journeys PASS`);
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const results = await runAll(only);
  printMatrix(results);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

const isMain = !!process.argv[1] && /runner\.ts$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  main().catch((e) => {
    console.error("runner crashed:", e);
    process.exit(2);
  });
}
