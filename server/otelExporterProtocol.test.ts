/**
 * QA-042: an OTLP exporter and the endpoint it is pointed at must speak the same protocol. The collector exposes gRPC on
 * 4317 and HTTP on 4318; the four Rust services build their exporter with `.with_tonic()` (gRPC) but were pointed at 4318,
 * so every export failed with "transport error" — silently, at ERROR level with an empty message — and the bridge, recon-worker
 * and event-processor never showed up in Jaeger. Nothing failed anywhere else, so nothing noticed for weeks.
 *
 * The protocol is read from each service's SOURCE, so changing the exporter without the manifest (or the reverse) fails here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "js-yaml";

const ROOT = join(__dirname, "..");
const GRPC_PORT = "4317";
const HTTP_PORT = "4318";

const endpointOf = (svc: string) => {
  const dep = (loadAll(readFileSync(join(ROOT, `k8s-flux/${svc}-deployment.yaml`), "utf8")) as any[]).find((d) => d?.kind === "Deployment");
  return (dep.spec.template.spec.containers[0].env as any[]).find((e) => e.name === "OTEL_EXPORTER_OTLP_ENDPOINT")?.value as string | undefined;
};
const protocolOf = (svc: string) => {
  const src = readFileSync(join(ROOT, `rust/${svc}/src/main.rs`), "utf8").split("#[cfg(test)]")[0];
  const grpc = /\.with_tonic\(\)/.test(src), http = /\.with_http\(\)/.test(src);
  expect(grpc !== http, `${svc}: expected exactly one of with_tonic()/with_http()`).toBe(true);
  return grpc ? "grpc" : "http";
};

describe.each(["ledger-bridge", "recon-worker", "event-processor", "hermes-router"])("%s: OTLP endpoint matches the exporter's protocol", (svc) => {
  it("points at the collector's port for the protocol its code speaks", () => {
    const url = new URL(endpointOf(svc)!);
    expect(url.hostname).toBe("otel-collector.otel.svc.cluster.local");
    expect(url.port, `${svc} exports ${protocolOf(svc)}`).toBe(protocolOf(svc) === "grpc" ? GRPC_PORT : HTTP_PORT);
  });
});

describe("the protocol detector is not vacuous", () => {
  it("finds gRPC in the Rust services (it is what they use today)", () => {
    for (const s of ["ledger-bridge", "recon-worker", "event-processor", "hermes-router"]) expect(protocolOf(s)).toBe("grpc");
  });
});
