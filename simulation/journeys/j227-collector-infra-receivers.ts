/**
 * === W35 infra-receivers (Coder D) ===
 * J227 — collector config + infra receiver wiring validation.
 *
 *  1. deploy/otel/collector-config.yaml parses (js-yaml) and contains the
 *     W35 prometheus scrape receiver with keycloak/apisix/permify/opensearch
 *     jobs, the metrics/infra-scrape pipeline, AND the intact W34 surface
 *     (otlp receivers, tail_sampling policies, spanmetrics connector).
 *  2. Temporal scrape honestly skipped: documented comment present, no
 *     temporal target invented.
 *  3. k8s/otel-stack.yaml collector ConfigMap is byte-in-sync with the
 *     deploy file (same receiver set).
 *  4. Dapr tracing (services/dapr/config.yaml) points at otel-collector:4317.
 *  5. APISIX otel wiring: opentelemetry in plugins + plugin_attr in BOTH
 *     services/middleware/apisix_conf/config.yaml and k8s/apisix.yaml.
 *  6. Keycloak: KC_METRICS_ENABLED=true in k8s/keycloak.yaml.
 */
import fs from "node:fs";
import path from "node:path";
import { load as yamlLoad, loadAll as yamlLoadAll } from "js-yaml";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const ROOT = process.cwd();

export const journey: Journey = {
  id: "J227",
  name: "W35 collector infra receivers + dapr/apisix/keycloak wiring",
  feature: "W35 infra-receivers: prometheus scrape receiver, dapr/apisix/keycloak otel",
  async run(_world: World) {
    // 1. Collector config structure.
    const raw = fs.readFileSync(path.join(ROOT, "deploy/otel/collector-config.yaml"), "utf8");
    assert(raw.includes("=== W35 infra-receivers"), "collector: W35 banner missing");
    const col = yamlLoad(raw) as any;
    // W34 surface intact.
    assert(col.receivers?.otlp?.protocols?.grpc, "collector: OTLP gRPC receiver missing");
    assert(col.processors?.tail_sampling?.policies?.length >= 3, "collector: W34 tail_sampling policies regressed");
    assert(col.connectors?.spanmetrics, "collector: spanmetrics connector missing");
    // W35 prometheus receiver + jobs.
    const jobs = (col.receivers?.prometheus?.config?.scrape_configs ?? []).map((j: any) => j.job_name);
    for (const j of ["keycloak", "apisix", "permify", "opensearch"]) {
      assert(jobs.includes(j), `collector: scrape job ${j} missing (have ${jobs.join(",")})`);
    }
    assert(!jobs.includes("temporal"), "collector: temporal must be skipped+documented, not scraped");
    const pipes = col.service?.pipelines ?? {};
    assert(pipes["metrics/infra-scrape"]?.receivers?.includes("prometheus"), "collector: metrics/infra-scrape pipeline missing");
    assert(pipes["traces"]?.processors?.includes("tail_sampling"), "collector: W34 traces pipeline regressed");

    // 2. Temporal skip + openappsec filelog honestly documented.
    assert(raw.includes("TEMPORAL: SKIPPED"), "collector: temporal skip must be documented");
    assert(raw.includes("filelog/openappsec"), "collector: openappsec filelog snippet missing");
    assert(raw.includes("contrib"), "collector: filelog distro-support note missing");

    // 3. k8s collector ConfigMap in sync (same receiver + job set).
    const docs = yamlLoadAll(fs.readFileSync(path.join(ROOT, "k8s", "otel-stack.yaml"), "utf8")) as any[];
    const cm = docs.find((d) => d?.kind === "ConfigMap" && d?.metadata?.name === "otel-collector-config");
    assert(cm, "k8s: otel-collector-config ConfigMap missing");
    const inner = yamlLoad(cm.data["config.yaml"]) as any;
    const innerJobs = (inner.receivers?.prometheus?.config?.scrape_configs ?? []).map((j: any) => j.job_name);
    for (const j of ["keycloak", "apisix", "permify", "opensearch"]) {
      assert(innerJobs.includes(j), `k8s collector: scrape job ${j} missing`);
    }
    assert(inner.service?.pipelines?.["metrics/infra-scrape"], "k8s collector: metrics/infra-scrape pipeline missing");

    // 4. Dapr tracing → collector gRPC :4317.
    const daprRaw = fs.readFileSync(path.join(ROOT, "services", "dapr", "config.yaml"), "utf8");
    assert(daprRaw.includes("=== W35 infra-receivers"), "dapr: W35 banner missing");
    const dapr = yamlLoad(daprRaw) as any;
    assert(dapr.spec?.tracing?.otel?.endpointAddress === "otel-collector:4317", "dapr: otel tracing endpoint must be otel-collector:4317");
    assert(dapr.spec?.tracing?.zipkin, "dapr: existing zipkin block must be preserved (additive)");

    // 5. APISIX otel plugin in compose conf + k8s configmap.
    const composeConf = yamlLoad(fs.readFileSync(path.join(ROOT, "services/middleware/apisix_conf/config.yaml"), "utf8")) as any;
    assert((composeConf.plugins ?? []).includes("opentelemetry"), "apisix compose conf: opentelemetry plugin missing");
    assert(composeConf.plugin_attr?.opentelemetry?.collector?.address === "otel-collector:4318", "apisix compose conf: otel collector address wrong");
    assert(composeConf.plugin_attr?.prometheus, "apisix compose conf: existing prometheus plugin_attr regressed");
    const apisixDocs = yamlLoadAll(fs.readFileSync(path.join(ROOT, "k8s", "apisix.yaml"), "utf8")) as any[];
    const apisixCm = apisixDocs.find((d) => d?.kind === "ConfigMap" && d?.metadata?.name === "apisix-standalone-config");
    const k8sConf = yamlLoad(apisixCm.data["config.yaml"]) as any;
    assert((k8sConf.plugins ?? []).includes("opentelemetry"), "apisix k8s conf: opentelemetry plugin missing");
    assert(k8sConf.plugin_attr?.opentelemetry?.collector?.address === "otel-collector:4318", "apisix k8s conf: otel collector address wrong");
    const k8sRoutes = yamlLoad(apisixCm.data["apisix.yaml"]) as any;
    const routePlugins = JSON.stringify(k8sRoutes.routes ?? []);
    assert(routePlugins.includes("opentelemetry"), "apisix k8s routes: opentelemetry not attached to platform-api route");

    // 6. Keycloak metrics enabled.
    const kcDocs = yamlLoadAll(fs.readFileSync(path.join(ROOT, "k8s", "keycloak.yaml"), "utf8")) as any[];
    const kcDep = kcDocs.find((d) => d?.kind === "Deployment" && d?.metadata?.name === "keycloak");
    const env = kcDep?.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const kcMetrics = env.find((e: any) => e.name === "KC_METRICS_ENABLED");
    assert(kcMetrics?.value === "true", "keycloak: KC_METRICS_ENABLED=true missing");
  },
};
