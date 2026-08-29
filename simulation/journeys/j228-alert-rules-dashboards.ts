/**
 * === W35 infra-receivers (Coder D) ===
 * J228 — alert rules + dashboards validation.
 *
 *  1. deploy/otel/alert-rules.yml parses; W34 rules intact; new W35 rules
 *     present (GoServiceDown, RustServiceDown, TemporalWorkflowFailures,
 *     TigerBeetleOpErrors) each with severity + for/expr structurally sane
 *     (balanced delimiters — same light check as J218, honest scope).
 *  2. Kafka consumer lag honestly absent (documented comment, no fake rule).
 *  3. Alertmanager routes cover the new severities via the existing W34
 *     severity routes; critical still hits the WA bridge webhook.
 *  4. New Grafana dashboards (go-services-red, rust-services-red) parse,
 *     have >=3 panels with PromQL targets, and tenant-360 gained the
 *     kafka/temporal panels.
 */
import fs from "node:fs";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = process.cwd();
const OTEL = path.join(ROOT, "deploy", "otel");

/** Light PromQL structural check — NOT a full parser (same scope as J218). */
function checkPromQL(expr: string, label: string): void {
  const e = expr.trim();
  assert(e.length > 0, `${label}: empty expr`);
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  let inStr: string | null = null;
  for (const ch of e) {
    if (inStr) { if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      assert(stack.pop() === pairs[ch], `${label}: unbalanced '${ch}' in ${JSON.stringify(e)}`);
    }
  }
  assert(stack.length === 0, `${label}: unclosed delimiters in ${JSON.stringify(e)}`);
  assert(inStr === null, `${label}: unterminated string in ${JSON.stringify(e)}`);
}

export const journey: Journey = {
  id: "J228",
  name: "W35 alert rules (go/rust down, temporal, tigerbeetle) + dashboards",
  feature: "W35 infra-receivers: alert-rules w35 group + RED dashboards",
  async run(_world: World) {
    // 1. Alert rules.
    const raw = fs.readFileSync(path.join(OTEL, "alert-rules.yml"), "utf8");
    assert(raw.includes("=== W35 infra-receivers"), "alert-rules: W35 banner missing");
    const rules = yamlLoad(raw) as any;
    const byGroup: Record<string, any[]> = {};
    for (const g of rules.groups ?? []) byGroup[g.name] = g.rules ?? [];
    assert(byGroup["w34-platform"]?.length === 7, `W34 group regressed (${byGroup["w34-platform"]?.length})`);
    const w35 = byGroup["w35-infra-otel"] ?? [];
    const names = w35.map((r: any) => r.alert);
    for (const want of ["GoServiceDown", "RustServiceDown", "TemporalWorkflowFailures", "TigerBeetleOpErrors"]) {
      assert(names.includes(want), `W35 rule ${want} missing (have ${names.join(",")})`);
    }
    for (const r of w35) {
      assert(r.labels?.severity === "critical" || r.labels?.severity === "warning", `${r.alert}: severity missing`);
      checkPromQL(r.expr, r.alert);
    }
    const go = w35.find((r: any) => r.alert === "GoServiceDown");
    assert(go.for === "5m" && /up\{.*\} == 0/.test(go.expr), "GoServiceDown must be up{...}==0 for 5m");

    // 2. Kafka lag honest absence.
    assert(raw.toLowerCase().includes("kafka consumer lag"), "kafka lag honest comment missing");
    assert(!names.some((n: string) => /lag/i.test(n)), "no kafka-lag rule may exist without a lag exporter");

    // 3. Alertmanager routing.
    const am = yamlLoad(fs.readFileSync(path.join(OTEL, "alertmanager.yml"), "utf8")) as any;
    const crit = (am.route?.routes ?? []).find((r: any) => JSON.stringify(r.matchers ?? []).includes("critical"));
    assert(crit?.receiver === "critical-all", "critical route must hit critical-all (WA bridge)");
    const critReceiver = (am.receivers ?? []).find((r: any) => r.name === "critical-all");
    assert(JSON.stringify(critReceiver).includes("alertmanager-wa-bridge"), "critical-all must keep the W34 WA bridge webhook");
    assert(fs.readFileSync(path.join(OTEL, "alertmanager.yml"), "utf8").includes("=== W35 infra-receivers"), "alertmanager: W35 banner missing");

    // 4. Dashboards.
    for (const d of ["go-services-red", "rust-services-red"]) {
      const parsed = JSON.parse(fs.readFileSync(path.join(OTEL, "grafana", "dashboards", `${d}.json`), "utf8"));
      assert(parsed.title && parsed.panels?.length >= 3, `${d}: needs title + >=3 panels`);
      assert(String(parsed.description).includes("W35"), `${d}: W35 description banner missing`);
      for (const panel of parsed.panels) {
        for (const t of panel.targets ?? []) if (t.expr) checkPromQL(t.expr, `${d}/${panel.title}`);
      }
    }
    const t360 = JSON.parse(fs.readFileSync(path.join(OTEL, "grafana", "dashboards", "tenant-360.json"), "utf8"));
    const titles = t360.panels.map((p: any) => p.title).join("|").toLowerCase();
    assert(titles.includes("kafka"), "tenant-360: kafka panel missing");
    assert(titles.includes("temporal"), "tenant-360: temporal panel missing");
  },
};
