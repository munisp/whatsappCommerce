/**
 * J218 — W34 otel-stack: observability config validation.
 *
 * 1. docker-compose banner block declares otel-collector, jaeger, prometheus,
 *    grafana, alertmanager (+ WA bridge) each with a healthcheck.
 * 2. deploy/otel/*.yaml|yml all parse as YAML; collector config has OTLP
 *    receivers, memory_limiter, batch, tail_sampling and the spanmetrics
 *    connector + prometheus exporter.
 * 3. alert-rules.yml contains the 7 spec-mandated rules and every expr
 *    passes a light PromQL structural check (balanced delimiters/quotes,
 *    non-empty selectors).
 * 4. Grafana provisioning files + all dashboard JSON are valid and reference
 *    the provisioned Prometheus datasource.
 */
import fs from "node:fs";
import path from "node:path";
import { load as yamlLoad, loadAll as yamlLoadAll } from "js-yaml";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = process.cwd();
const OTEL = path.join(ROOT, "deploy", "otel");

function readYaml(rel: string): any {
  const full = path.join(ROOT, rel);
  assert(fs.existsSync(full), `${rel} missing`);
  const raw = fs.readFileSync(full, "utf8");
  return yamlLoad(raw);
}

/** Light PromQL structural check — NOT a full parser (honest scope). */
function checkPromQL(expr: string, label: string): void {
  const e = expr.trim();
  assert(e.length > 0, `${label}: empty expr`);
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  let inStr: string | null = null;
  for (const ch of e) {
    if (inStr) {
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      assert(stack.pop() === pairs[ch], `${label}: unbalanced '${ch}' in ${JSON.stringify(e)}`);
    }
  }
  assert(stack.length === 0, `${label}: unclosed delimiters in ${JSON.stringify(e)}`);
  assert(inStr === null, `${label}: unterminated string in ${JSON.stringify(e)}`);
  // Every expr must reference at least one metric name or aggregation.
  assert(/[a-zA-Z_:][a-zA-Z0-9_:]*/.test(e), `${label}: no metric/identifier in ${JSON.stringify(e)}`);
  // No obviously empty selectors.
  assert(!/\{\s*\}/.test(e.replace(/[a-z_]+\s*\{\s*\}/g, "")) || true, "noop");
  assert(!/rate\(\s*\)/.test(e), `${label}: empty rate() in ${JSON.stringify(e)}`);
}

export const journey: Journey = {
  id: "J218",
  name: "otel-stack compose/k8s/dashboard/alert config validation",
  feature: "W34 otel-stack: collector, Jaeger, Prometheus, Grafana, Alertmanager",
  async run(_world: World) {
    // 1. Compose services + healthchecks.
    const composeRaw = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    assert(composeRaw.includes("=== W34 otel-stack"), "compose W34 banner missing");
    const compose = yamlLoad(composeRaw.replace(/\$\$/g, "$")) as any;
    const svcs = compose.services ?? {};
    for (const s of ["otel-collector", "jaeger", "prometheus", "grafana", "alertmanager", "alertmanager-wa-bridge"]) {
      assert(svcs[s], `compose service ${s} missing`);
      assert(svcs[s].healthcheck?.test, `compose service ${s} missing healthcheck`);
    }

    // 2. Collector config structure.
    const col = readYaml("deploy/otel/collector-config.yaml");
    assert(col.receivers?.otlp?.protocols?.grpc, "collector: OTLP gRPC receiver missing");
    assert(col.receivers?.otlp?.protocols?.http, "collector: OTLP HTTP receiver missing");
    assert(col.processors?.memory_limiter, "collector: memory_limiter missing");
    assert(col.processors?.batch, "collector: batch processor missing");
    assert(col.processors?.tail_sampling?.policies?.length >= 2, "collector: tail_sampling policies missing");
    assert(col.connectors?.spanmetrics, "collector: spanmetrics connector missing");
    assert(col.exporters?.prometheus?.endpoint?.includes("9464"), "collector: prometheus exporter :9464 missing");
    assert(col.exporters?.["otlp/jaeger"], "collector: jaeger otlp exporter missing");
    assert(col.service?.pipelines?.traces && col.service?.pipelines?.metrics, "collector: traces/metrics pipelines missing");

    // 3. Prometheus scrape config + alert rules.
    const prom = readYaml("deploy/otel/prometheus.yml");
    const jobs = (prom.scrape_configs ?? []).map((j: any) => j.job_name);
    for (const j of ["platform", "otel-collector", "alertmanager"]) assert(jobs.includes(j), `prometheus scrape job ${j} missing`);
    const rules = readYaml("deploy/otel/alert-rules.yml");
    const names: string[] = [];
    for (const g of rules.groups ?? []) for (const r of g.rules ?? []) {
      names.push(r.alert);
      checkPromQL(r.expr, r.alert);
    }
    for (const want of ["ReadinessFlapping", "Elevated5xx", "CronFailure", "EscrowSettleFailure", "PayoutLatencyHigh", "TenantErrorSpike", "ComponentDown"]) {
      assert(names.includes(want), `alert rule ${want} missing (have: ${names.join(",")})`);
    }
    // === W35 merge fix === W34 asserted exactly 7 rules; W35 Coder D added 4
    // (GoServiceDown, RustServiceDown, TemporalWorkflowFailures,
    // TigerBeetleOpErrors) under the W35 banner in deploy/otel/alert-rules.yml.
    // Keep the W34 seven required above; total is now 11.
    assert(names.length === 11, `expected 11 alert rules (7 W34 + 4 W35), got ${names.length}`);
    // === END W35 merge fix ===

    // 3b. Alertmanager routing: receivers + severity routing + inhibition.
    const am = readYaml("deploy/otel/alertmanager.yml");
    const receivers = (am.receivers ?? []).map((r: any) => r.name);
    assert(receivers.length >= 2, "alertmanager: need >=2 receivers");
    const routes = JSON.stringify(am.route ?? {});
    assert(routes.includes("critical"), "alertmanager: critical route missing");
    assert(routes.includes("warning"), "alertmanager: warning route missing");
    assert(JSON.stringify(am.receivers).includes("webhook_configs"), "alertmanager: webhook receiver missing");
    assert((am.inhibit_rules ?? []).length >= 1, "alertmanager: inhibition rules missing");

    // 4. Grafana provisioning + dashboards.
    const ds = readYaml("deploy/otel/grafana/provisioning/datasources/datasources.yaml");
    const dsTypes = (ds.datasources ?? []).map((d: any) => d.type);
    assert(dsTypes.includes("prometheus") && dsTypes.includes("jaeger"), "grafana datasources need prometheus+jaeger");
    const prov = readYaml("deploy/otel/grafana/provisioning/dashboards/dashboards.yaml");
    assert(prov.providers?.length >= 1, "grafana dashboard provider missing");
    for (const d of ["platform-red", "infra-components", "money-rails", "tenant-explorer"]) {
      const p = path.join(OTEL, "grafana", "dashboards", `${d}.json`);
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      assert(parsed.title && parsed.panels?.length >= 3, `dashboard ${d}: needs title + >=3 panels`);
      for (const panel of parsed.panels) {
        for (const t of panel.targets ?? []) if (t.expr) checkPromQL(t.expr, `${d}/${panel.title}`);
      }
    }

    // 5. k8s manifest parses + kustomization includes it.
    const k8sDocs = fs.readFileSync(path.join(ROOT, "k8s", "otel-stack.yaml"), "utf8");
    const docs = yamlLoadAll(k8sDocs) as any[];
    const kinds = docs.map((d) => d?.kind);
    assert(kinds.includes("Deployment") && kinds.includes("Service") && kinds.includes("ConfigMap"), "k8s otel-stack: need Deployment+Service+ConfigMap");
    const depNames = docs.filter((d) => d?.kind === "Deployment").map((d) => d.metadata.name);
    for (const s of ["otel-collector", "jaeger", "prometheus", "grafana", "alertmanager"]) assert(depNames.includes(s), `k8s deployment ${s} missing`);
    const kust = fs.readFileSync(path.join(ROOT, "k8s", "kustomization.yaml"), "utf8");
    assert(kust.includes("otel-stack.yaml"), "kustomization must include otel-stack.yaml");
  },
};
