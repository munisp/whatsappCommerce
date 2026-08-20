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
    import("./journeys/j47-multi-provider-tenants"),
    import("./journeys/j48-manual-bank-transfer"),
    import("./journeys/j49-custom-gateway"),
    import("./journeys/j50-provider-fallback"),
    import("./journeys/j51-flw-credit-repayment"),
    import("./journeys/j52-unified-webhook-isolation"),
    import("./journeys/j53-keycloak-forgery"),
    import("./journeys/j54-invite-mint"),
    import("./journeys/j55-idor-sweep"),
    import("./journeys/j56-marketplace-abuse"),
    import("./journeys/j57-kyb-golive"),
    import("./journeys/j58-kyb-credit"),
    import("./journeys/j59-supplier-verification"),
    import("./journeys/j60-sessions-memberships"),
    import("./journeys/j61-mandate-gated-approval"),
    import("./journeys/j62-charge-first-repayment"),
    import("./journeys/j63-mandate-charge-fallback"),
    import("./journeys/j64-downward-limit-revision"),
    import("./journeys/j65-tenure-suspension"),
    import("./journeys/j66-supplier-direct-settlement"),
    import("./journeys/j67-bureau-consent-gating"),
    import("./journeys/j68-bureau-event-lifecycle"),
    import("./journeys/j69-bureau-retry-dispute"),
    import("./journeys/j70-loan-book-tape"),
    import("./journeys/j71-facility-utilization-covenants"),
    import("./journeys/j72-credit-hardening-e2e"),
    import("./journeys/j73-multilingual-onboarding-e2e"),
    import("./journeys/j74-language-detection-edge-cases"),
    import("./journeys/j75-photo-catalog-bootstrap"),
    import("./journeys/j76-erp-provisioning-e2e"),
    import("./journeys/j77-copilot-config-intents"),
    import("./journeys/j78-w141-credit-regression"),
    import("./journeys/j79-shopify-oauth-catalog-sync"),
    import("./journeys/j80-shopify-order-bridge"),
    import("./journeys/j81-embedded-signup-e2e"),
    import("./journeys/j82-template-library-lifecycle"),
    import("./journeys/j83-marketplace-lifecycle"),
    import("./journeys/j84-new-tenant-distribution-e2e"),
    import("./journeys/j85-whatsapp-visual-stocktake"),
    import("./journeys/j86-broadcast-journey-lifecycle"),
    import("./journeys/j87-journey-frequency-cap-withdrawal"),
    import("./journeys/j88-cod-chat-order"),
    import("./journeys/j89-cod-delivery-failed"),
    import("./journeys/j90-cod-partial-cash"),
    import("./journeys/j91-crm-winback"),
    import("./journeys/j92-credit-score-credit-history"),
    import("./journeys/j93-manufacturer-credit-program"),
    import("./journeys/j94-soc2-compliance"),
    import("./journeys/j95-ml-lead-scoring"),
    import("./journeys/j96-audit-anomaly"),
    import("./journeys/j97-pd-credit-model"),
    import("./journeys/j98-uplift-broadcast"),
    import("./journeys/j99-graph-collusion"),
    import("./journeys/j100-bandit-limits"),
    import("./journeys/j101-llm-copilot"),
    import("./journeys/j102-merchant-onboarding"),
    import("./journeys/j103-whatsapp-paystack-order"),
    import("./journeys/j121-orchestrated-fullstack"),
    import("./journeys/j105-cod-reconciliation"),
    import("./journeys/j106-visual-stocktake-variance"),
    import("./journeys/j107-trade-credit-application"),
    import("./journeys/j108-manufacturer-program-caps"),
    import("./journeys/j109-credit-dunning-cure"),
    import("./journeys/j110-merchant-uplift-broadcast"),
    import("./journeys/j111-journey-automation-winback"),
    import("./journeys/j112-ml-lead-scoring-winback"),
    import("./journeys/j113-collusion-ring-credit-flag"),
    import("./journeys/j114-bandit-rewards-replay"),
    import("./journeys/j104-catalog-to-delivery"),
    import("./journeys/j115-credit-repay-mandate-retry"),
    import("./journeys/j116-support-escalation"),
    import("./journeys/j117-compliance-incident-response"),
    import("./journeys/j118-retention-hold-export"),
    import("./journeys/j119-payment-failover-reconcile"),
    import("./journeys/j120-offline-sync-stock-conflict"),
    import("./journeys/j122-discover-pin-category"),
    import("./journeys/j123-discover-freetext-order"),
    import("./journeys/j124-merchant-geo-onboarding"),
    import("./journeys/j125-sponsored-placement"),
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
