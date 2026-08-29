/**
 * === W34 otel-core ===
 * server/_core/telemetry.ts — lazy, fail-open OpenTelemetry bootstrap + RED metrics.
 *
 * Doctrine: telemetry NEVER breaks requests. Every export path swallows and
 * counts its own exceptions; `initTelemetry` warns and continues when the SDK
 * or the collector is unavailable. Activated ONLY when OTEL_ENABLED=true
 * (default false — dev/test behavior is unchanged).
 *
 * Heavy deps (@opentelemetry/sdk-node, exporters, auto-instrumentations) are
 * imported LAZILY inside initTelemetry() so the module stays importable (and
 * cheap) when telemetry is off. Only @opentelemetry/api (pure, side-effect
 * free) and prom-client are static imports.
 *
 * Honest status: telemetryStatus() reports enabled/started/exporter health —
 * including the last export error — so the platform never claims telemetry it
 * does not have (J217).
 *
 * Tenant cardinality: metric labels NEVER carry a raw tenant id unless the
 * tenant is allowlisted (OTEL_TENANT_METRIC_ALLOWLIST csv) — everything else
 * collapses to tenant_class="other" (empty allowlist → "all", aggregate
 * only). Coder C's telemetryCardinality service can override the allowlist
 * source via setTenantAllowlistProvider().
 */
import { createRequire } from "module";
import { trace, context, propagation, metrics as otelMetrics, SpanStatusCode } from "@opentelemetry/api";
import promClient from "prom-client";

// ── State ────────────────────────────────────────────────────────────────────

interface TelemetryState {
  /** OTEL_ENABLED requested by env at last init. */
  enabled: boolean;
  /** SDK actually started (init succeeded). */
  started: boolean;
  /** init currently in flight (re-entrancy guard). */
  starting: boolean;
  exporterEndpoint: string;
  /** null = no export attempted yet. */
  exporterReachable: boolean | null;
  lastError: string | null;
  exportFailures: number;
  exportsSucceeded: number;
  startedAt: number | null;
  serviceVersion: string;
  inMemory: boolean;
}

const state: TelemetryState = {
  enabled: false,
  started: false,
  starting: false,
  exporterEndpoint: "",
  exporterReachable: null,
  lastError: null,
  exportFailures: 0,
  exportsSucceeded: 0,
  startedAt: null,
  serviceVersion: "unknown",
  inMemory: false,
};

let sdk: { shutdown(): Promise<void> } | null = null;
let infraTimer: ReturnType<typeof setInterval> | null = null;

export function otelEnabledFromEnv(): boolean {
  return (process.env.OTEL_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Best-effort reset of the OTel API globals (trace/metrics/context/propagation). */
function unregisterApiGlobals(): void {
  for (const ns of [trace, otelMetrics, context, propagation]) {
    try {
      (ns as unknown as { disable?: () => void }).disable?.();
    } catch { /* never fail a re-init on cleanup */ }
  }
}

export function otelEndpointFromEnv(): string {
  return (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://otel-collector:4318").replace(/\/+$/, "");
}

function readServiceVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    return String(req("../../package.json").version ?? "unknown");
  } catch {
    return "unknown";
  }
}

// ── Prometheus registry (in-process RED metrics for /api/metrics) ────────────

export const promRegistry = new promClient.Registry();
promRegistry.setDefaultLabels({ service: "whatsapp-commerce-platform" });
promClient.collectDefaultMetrics({ register: promRegistry });

export const httpRequestsTotal = new promClient.Counter({
  name: "http_requests_total",
  help: "Inbound HTTP requests by route/status-class/tenant-class (RED).",
  labelNames: ["route", "status_class", "tenant_class"],
  registers: [promRegistry],
});
export const httpRequestDurationMs = new promClient.Histogram({
  name: "http_request_duration_ms",
  help: "Inbound HTTP request latency in ms (RED).",
  labelNames: ["route", "status_class", "tenant_class"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [promRegistry],
});
export const trpcProcedureCallsTotal = new promClient.Counter({
  name: "trpc_procedure_calls_total",
  help: "tRPC procedure invocations by procedure/result/tenant-class (RED).",
  labelNames: ["procedure", "result", "tenant_class"],
  registers: [promRegistry],
});
export const trpcProcedureDurationMs = new promClient.Histogram({
  name: "trpc_procedure_duration_ms",
  help: "tRPC procedure latency in ms (RED).",
  labelNames: ["procedure", "tenant_class"],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [promRegistry],
});
export const escrowSettlementsTotal = new promClient.Counter({
  name: "escrow_settlements_total",
  help: "Escrow settlement attempts by outcome (success|skipped|error).",
  labelNames: ["outcome"],
  registers: [promRegistry],
});
export const payoutLatencyMs = new promClient.Histogram({
  name: "payout_latency_ms",
  help: "Withdrawal initiation→terminal webhook latency in ms.",
  labelNames: ["outcome"],
  buckets: [1000, 5000, 15000, 30000, 60000, 300000, 900000, 3600000, 86400000],
  registers: [promRegistry],
});
export const cronRunsTotal = new promClient.Counter({
  name: "cron_runs_total",
  help: "Scheduled-route invocations by route and result.",
  labelNames: ["route", "result"],
  registers: [promRegistry],
});
export const infraComponentUp = new promClient.Gauge({
  name: "infra_component_up",
  help: "1 when the infra health probe reports the component online, 0 otherwise.",
  labelNames: ["component"],
  registers: [promRegistry],
});
export const infraComponentLatencyMs = new promClient.Histogram({
  name: "infra_component_latency_ms",
  help: "Infra health probe latency in ms (same probes as infra_component_up).",
  labelNames: ["component"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [promRegistry],
});
export const telemetryErrorsTotal = new promClient.Counter({
  name: "telemetry_errors_total",
  help: "Telemetry exceptions swallowed by the fail-open guard (by component).",
  labelNames: ["component"],
  registers: [promRegistry],
});

/** Count a swallowed telemetry exception — telemetry faults are observable too. */
export function noteTelemetryError(component: string, err: unknown): void {
  try {
    telemetryErrorsTotal.inc({ component });
  } catch { /* prom-client must never throw into the request path */ }
  try {
    console.warn(`[telemetry:${component}]`, (err as Error)?.message ?? err);
  } catch { /* ignore */ }
}

// ── Tenant cardinality guard ─────────────────────────────────────────────────

type AllowlistProvider = () => readonly string[];
let allowlistProvider: AllowlistProvider | null = null;

/** Coder C hook: override the tenant metric allowlist source (persisted set). */
export function setTenantAllowlistProvider(provider: AllowlistProvider | null): void {
  allowlistProvider = provider;
}

export function tenantAllowlist(): readonly string[] {
  if (allowlistProvider) {
    try {
      const v = allowlistProvider();
      if (Array.isArray(v)) return v;
    } catch (err) {
      noteTelemetryError("allowlist", err);
    }
  }
  return (process.env.OTEL_TENANT_METRIC_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Map a raw tenant id to its bounded metric label. Allowlisted tenants keep
 * their id; everyone else collapses to "other". An EMPTY allowlist means
 * platform-aggregate only (label "all"). Raw tenant ids NEVER leak into
 * metric labels.
 */
export function tenantMetricClass(tenantId: string | null | undefined): string {
  const list = tenantAllowlist();
  if (list.length === 0) return "all";
  if (tenantId && list.includes(tenantId)) return tenantId;
  return "other";
}

// ── Bootstrap (lazy, fail-open) ──────────────────────────────────────────────

// === W35 node-messaging-otel ===
/**
 * Lazily load the W35-sanctioned explicit instrumentations (kafkajs, ioredis,
 * pg). Called ONLY from the OTEL_ENABLED=true branch of initTelemetry — when
 * telemetry is disabled nothing is imported. Fail-open per package: a load or
 * construction failure is recorded and that instrumentation is skipped.
 */
async function loadW35Instrumentations(): Promise<unknown[]> {
  const out: unknown[] = [];
  const loaders: Array<[string, () => Promise<unknown>]> = [
    ["kafkajs", async () => {
      const m = await import("@opentelemetry/instrumentation-kafkajs");
      return new m.KafkaJsInstrumentation();
    }],
    ["ioredis", async () => {
      const m = await import("@opentelemetry/instrumentation-ioredis");
      return new m.IORedisInstrumentation();
    }],
    ["pg", async () => {
      const m = await import("@opentelemetry/instrumentation-pg");
      return new m.PgInstrumentation();
    }],
  ];
  for (const [name, load] of loaders) {
    try {
      out.push(await load());
    } catch (err) {
      noteTelemetryError(`instrumentation-${name}`, err);
    }
  }
  return out;
}
// === END W35 node-messaging-otel ===


/**
 * Initialize the OTel NodeSDK when OTEL_ENABLED=true. Re-entrant: a changed
 * config (or toggled env) shuts the previous SDK down and starts fresh, so
 * journeys/tests can exercise enabled/disabled/unreachable paths in-process.
 * NEVER throws.
 */
export async function initTelemetry(): Promise<void> {
  const enabled = otelEnabledFromEnv();
  const endpoint = otelEndpointFromEnv();
  if (state.starting) return;
  if (
    state.enabled === enabled &&
    state.started === enabled &&
    state.exporterEndpoint === endpoint &&
    state.inMemory === inMemoryExporterMode()
  ) {
    return; // already in the requested state
  }
  state.starting = true;
  try {
    if (sdk) {
      const prev = sdk;
      sdk = null;
      state.started = false;
      stopInfraMetricsLoop();
      await prev.shutdown().catch(() => undefined);
      // The @opentelemetry/api globals delegate only on FIRST registration —
      // unregister them so a re-init (tests/journeys toggling configs) can
      // register the fresh SDK's providers.
      unregisterApiGlobals();
    }
    state.enabled = enabled;
    state.exporterEndpoint = endpoint;
    state.inMemory = inMemoryExporterMode();
    if (!enabled) {
      state.exporterReachable = null;
      state.lastError = null;
      return;
    }
    try {
      const [{ NodeSDK }, { getNodeAutoInstrumentations }, { OTLPTraceExporter }] = await Promise.all([
        import("@opentelemetry/sdk-node"),
        import("@opentelemetry/auto-instrumentations-node"),
        import("@opentelemetry/exporter-trace-otlp-http"),
      ]);
      // Metrics exporter + reader are auto-configured by the SDK from
      // OTEL_EXPORTER_OTLP_ENDPOINT (keeps @opentelemetry/sdk-metrics out of
      // the declared dep set; the SDK pulls it transitively).
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
      const version = readServiceVersion();
      state.serviceVersion = version;
      const sdkConfig: Record<string, unknown> = {
        serviceName: "whatsapp-commerce-platform",
        instrumentations: [
          getNodeAutoInstrumentations({
            // fs instrumentation is pure noise for a web service.
            "@opentelemetry/instrumentation-fs": { enabled: false },
            // === W35 node-messaging-otel ===
            // kafkajs / ioredis / pg are registered EXPLICITLY below from the
            // sanctioned top-level pins (W35 Coder C) — disable the bundled
            // copies here so each library is patched exactly once.
            "@opentelemetry/instrumentation-kafkajs": { enabled: false },
            "@opentelemetry/instrumentation-ioredis": { enabled: false },
            "@opentelemetry/instrumentation-pg": { enabled: false },
            // === END W35 node-messaging-otel ===
          }),
          // === W35 node-messaging-otel ===
          // Explicit messaging/DB instrumentation (sanctioned pins, peer-
          // verified against @opentelemetry/api 1.9.1). Fail-open per import:
          // a missing/broken package degrades to "uninstrumented", never a
          // crashed init.
          ...(await loadW35Instrumentations()),
          // === END W35 node-messaging-otel ===
        ],
        resourceDetectors: [],
      };
      if (inMemoryExporterMode()) {
        // Test mode: real spans into the process-local ring, no OTLP export.
        sdkConfig.spanProcessors = [inMemorySpanProcessor];
        process.env.OTEL_METRICS_EXPORTER = process.env.OTEL_METRICS_EXPORTER ?? "none";
      } else {
        const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
        // Honest exporter health: wrap export() to record the last outcome.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawExport: any = traceExporter.export.bind(traceExporter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (traceExporter as any).export = (spans: unknown, cb: (result: any) => void) => {
          rawExport(spans, (result: { error?: unknown }) => {
            try {
              const err = result?.error;
              if (err) {
                state.exporterReachable = false;
                state.exportFailures += 1;
                state.lastError = String((err as Error)?.message ?? err);
              } else {
                state.exporterReachable = true;
                state.exportsSucceeded += 1;
                state.lastError = null;
              }
            } catch { /* never break the exporter callback */ }
            cb(result);
          });
        };
        sdkConfig.traceExporter = traceExporter;
      }
      const nodeSdk = new NodeSDK(sdkConfig as ConstructorParameters<typeof NodeSDK>[0]);
      // Resource attributes: service.name/version + deployment.environment.
      // (sdk-node 0.221 derives service.name from serviceName option; add the
      // rest via env so the env-driven resource picks them up.)
      process.env.OTEL_RESOURCE_ATTRIBUTES = [
        `service.version=${version}`,
        `deployment.environment=${process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? "development"}`,
        // keep any pre-existing attrs except keys we own (re-init safe)
        (process.env.OTEL_RESOURCE_ATTRIBUTES ?? "")
          .split(",")
          .filter((kv) => kv && !/^(service\.version|deployment\.environment)=/.test(kv.trim()))
          .join(","),
      ].filter(Boolean).join(",");
      nodeSdk.start();
      sdk = nodeSdk;
      state.started = true;
      state.startedAt = Date.now();
      state.lastError = null;
      startInfraMetricsLoop();
      console.log(`[telemetry] OTel SDK started (endpoint=${endpoint}, service=whatsapp-commerce-platform@${version})`);
    } catch (err) {
      // Fail-open: warn + continue serving requests with telemetry off.
      state.started = false;
      state.lastError = String((err as Error)?.message ?? err);
      noteTelemetryError("init", err);
    }
  } finally {
    state.starting = false;
  }
}

/** Graceful shutdown (best effort, never throws). */
export async function shutdownTelemetry(): Promise<void> {
  try {
    stopInfraMetricsLoop();
    if (sdk) {
      const prev = sdk;
      sdk = null;
      state.started = false;
      await prev.shutdown().catch(() => undefined);
      unregisterApiGlobals();
    }
  } catch (err) {
    noteTelemetryError("shutdown", err);
  }
}

/** Honest telemetry self-report (J217: exporter errors surface here). */
export function telemetryStatus() {
  return {
    enabled: state.enabled,
    started: state.started,
    serviceName: "whatsapp-commerce-platform",
    serviceVersion: state.serviceVersion,
    exporterEndpoint: state.enabled ? state.exporterEndpoint : null,
    exporterReachable: state.exporterReachable,
    lastError: state.lastError,
    exportFailures: state.exportFailures,
    exportsSucceeded: state.exportsSucceeded,
    startedAt: state.startedAt,
    tenantAllowlistSize: tenantAllowlist().length,
  };
}

export function isTelemetryActive(): boolean {
  return state.enabled && state.started;
}

// ── Test-only in-memory span ring (OTEL_TRACES_EXPORTER=inmemory) ────────────
// Honest test hook: spans are REALLY produced by the SDK (instrumentation,
// baggage, sampling all active) but land in a process-local ring instead of
// an OTLP collector, so journeys can assert span names/attrs/trace ids
// without standing up a collector. Never used in production configs.
export interface RecordedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  attributes: Record<string, unknown>;
  statusCode: number;
  endedAt: number;
}
const spanRing: RecordedSpan[] = [];
const SPAN_RING_MAX = 500;

export function getRecordedSpans(): readonly RecordedSpan[] {
  return [...spanRing];
}
export function clearRecordedSpans(): void {
  spanRing.length = 0;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inMemorySpanProcessor = {
  onStart(): void { /* no-op */ },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEnd(span: any): void {
    try {
      const sc = span.spanContext();
      const parent = span.parentSpanContext?.spanId ?? span.parentSpanId ?? null;
      spanRing.push({
        name: span.name,
        traceId: sc.traceId,
        spanId: sc.spanId,
        parentSpanId: parent,
        attributes: { ...(span.attributes ?? {}) },
        statusCode: span.status?.code ?? 0,
        endedAt: Date.now(),
      });
      if (spanRing.length > SPAN_RING_MAX) spanRing.splice(0, spanRing.length - SPAN_RING_MAX);
      state.exportsSucceeded += 1;
    } catch { /* recording must never throw */ }
  },
  async forceFlush(): Promise<void> { /* no-op */ },
  async shutdown(): Promise<void> { /* no-op */ },
};

function inMemoryExporterMode(): boolean {
  return (process.env.OTEL_TRACES_EXPORTER ?? "").trim().toLowerCase() === "inmemory";
}

// ── Span helpers (all no-op safe when telemetry is off) ─────────────────────

/** Current trace id for the x-trace-id response header; null when no span. */
export function currentTraceId(): string | null {
  try {
    const span = trace.getActiveSpan();
    const id = span?.spanContext()?.traceId;
    return id && /^[0-9a-f]{32}$/.test(id) && id !== "0".repeat(32) ? id : null;
  } catch (err) {
    noteTelemetryError("trace-id", err);
    return null;
  }
}

/** Set attributes on the active span (best effort). */
export function tagActiveSpan(attrs: Record<string, string | number | boolean>): void {
  try {
    const span = trace.getActiveSpan();
    if (span) for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  } catch (err) {
    noteTelemetryError("tag", err);
  }
}

/**
 * Run fn inside a context carrying `baggage: tenant.id=<tenantId>`. The tenant
 * id MUST come from the authenticated session context — never request params.
 */
export async function withTenantBaggage<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  let bag;
  try {
    bag = propagation.createBaggage({ "tenant.id": { value: tenantId } });
  } catch (err) {
    noteTelemetryError("baggage", err);
    return fn();
  }
  // context.with propagates fn's own errors untouched — only baggage
  // construction above is guarded.
  return context.with(propagation.setBaggage(context.active(), bag), fn);
}

/**
 * tRPC procedure wrapper: one span per procedure (trpc.<router>.<procedure>)
 * with tenant.id/user.role/error attributes + RED metrics. Telemetry
 * exceptions are swallowed + counted; procedure behavior is NEVER changed.
 */
export async function traceProcedure<T>(
  path: string,
  ctx: { user?: { tenantId?: string | null; role?: string } | null },
  fn: () => Promise<T>,
  classifyError: (result: T) => Error | null,
): Promise<T> {
  if (!isTelemetryActive()) return fn();
  const t0 = Date.now();
  const tenantId = ctx.user?.tenantId ?? null;
  const tenantClass = tenantMetricClass(tenantId);
  const run = async (): Promise<T> => {
    const tracer = trace.getTracer("whatsapp-commerce-trpc");
    return tracer.startActiveSpan(`trpc.${path}`, async (span) => {
      try {
        try {
          span.setAttribute("rpc.system", "trpc");
          span.setAttribute("rpc.method", path);
          if (tenantId) span.setAttribute("tenant.id", tenantId);
          if (ctx.user?.role) span.setAttribute("user.role", ctx.user.role);
        } catch (attrErr) {
          noteTelemetryError("trpc-attrs", attrErr);
        }
        const result = await fn();
        try {
          const err = classifyError(result);
          if (err) {
            span.setAttribute("error", true);
            span.setAttribute("error.type", (err as { code?: unknown })?.code ? String((err as { code?: unknown }).code) : err.name);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            recordTrpcMetrics(path, tenantClass, "error", t0);
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
            recordTrpcMetrics(path, tenantClass, "ok", t0);
          }
        } catch (postErr) {
          noteTelemetryError("trpc-classify", postErr);
        }
        return result;
      } catch (err) {
        // Mark procedure failures so the outer guard rethrows them untouched
        // (telemetry faults alone fall back to running fn() bare).
        try {
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
          span.recordException(err as Error);
          recordTrpcMetrics(path, tenantClass, "error", t0);
        } finally {
          (err as { __fromProcedure?: boolean }).__fromProcedure = true;
        }
        throw err;
      } finally {
        try { span.end(); } catch { /* ignore */ }
      }
    });
  };
  try {
    return tenantId ? await withTenantBaggage(tenantId, run) : await run();
  } catch (err) {
    if ((err as { __fromProcedure?: boolean })?.__fromProcedure) throw err;
    // Telemetry machinery itself failed — fail OPEN: run the procedure bare.
    noteTelemetryError("trpc-span", err);
    return fn();
  }
}

function recordTrpcMetrics(path: string, tenantClass: string, result: "ok" | "error", t0: number): void {
  try {
    trpcProcedureCallsTotal.inc({ procedure: path, result, tenant_class: tenantClass });
    trpcProcedureDurationMs.observe({ procedure: path, tenant_class: tenantClass }, Date.now() - t0);
  } catch (err) {
    noteTelemetryError("trpc-metrics", err);
  }
}

/** Inject W3C traceparent/tracestate (+ baggage) into an outbound header bag. */
export function injectTraceHeaders<T extends Record<string, string>>(headers: T): T {
  if (!isTelemetryActive()) return headers;
  try {
    propagation.inject(context.active(), headers, {
      set: (carrier, key, value) => {
        (carrier as Record<string, string>)[key] = value;
      },
    });
  } catch (err) {
    noteTelemetryError("inject", err);
  }
  return headers;
}

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * Extract the parent context from inbound headers. When BOTH an explicit
 * traceparent (scheduler / internal caller) and an undici-instrumentation
 * traceparent ride the same request, Node joins duplicates into a
 * comma-separated list — the EXPLICIT (first, caller-authored) value wins so
 * the server span links to the intended caller trace.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractInboundParent(headers: any) {
  try {
    const raw = headers?.["traceparent"];
    if (typeof raw === "string" && raw.includes(",")) {
      const first = raw.split(",").map((p: string) => p.trim()).find((p: string) => TRACEPARENT_RE.test(p));
      if (first) {
        return propagation.extract(context.active(), {
          traceparent: first,
          tracestate: headers["tracestate"],
        });
      }
    }
    return propagation.extract(context.active(), headers ?? {});
  } catch {
    return context.active();
  }
}

/**
 * Express middleware: one server span per inbound request
 * (`http <METHOD> <path>`), extracting any inbound W3C traceparent (cron
 * scheduler / internal services) so the server span SHARES the caller's
 * trace_id. Sets the `x-trace-id` response header. This is explicit (not
 * reliant on auto-instrumentation require-order), real (the span is exported
 * like any other), and fail-open (any telemetry fault → plain next()).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function expressTelemetryMiddleware(req: any, res: any, next: () => void): void {
  if (!isTelemetryActive()) return next();
  try {
    const parentCtx = extractInboundParent(req.headers);
    const tracer = trace.getTracer("whatsapp-commerce-http");
    const span = tracer.startSpan(
      `http ${req.method} ${req.path}`,
      { attributes: { "http.request.method": String(req.method), "url.path": String(req.path) } },
      parentCtx,
    );
    const spanCtx = trace.setSpan(parentCtx, span);
    const traceId = span.spanContext().traceId;
    if (traceId && traceId !== "0".repeat(32) && !res.getHeader?.("x-trace-id")) {
      res.setHeader("x-trace-id", traceId);
    }
    res.on("finish", () => {
      try {
        span.setAttribute("http.response.status_code", Number(res.statusCode));
        if (Number(res.statusCode) >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        else span.setStatus({ code: SpanStatusCode.OK });
      } catch { /* ignore */ } finally {
        try { span.end(); } catch { /* ignore */ }
      }
    });
    context.with(spanCtx, () => next());
  } catch (err) {
    noteTelemetryError("http-span", err);
    next();
  }
}

// ── RED metric recorders (called from Express middleware / money paths) ─────

export function recordHttpRequest(route: string, statusCode: number, tenantId: string | null, durationMs: number): void {
  try {
    const labels = {
      route,
      status_class: `${Math.floor(statusCode / 100)}xx`,
      tenant_class: tenantMetricClass(tenantId),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationMs.observe(labels, durationMs);
  } catch (err) {
    noteTelemetryError("http-metrics", err);
  }
}

export function recordCronRun(route: string, result: "ok" | "error"): void {
  try {
    cronRunsTotal.inc({ route, result });
  } catch (err) {
    noteTelemetryError("cron-metrics", err);
  }
}

export function recordEscrowSettlement(outcome: "success" | "skipped" | "error"): void {
  try {
    escrowSettlementsTotal.inc({ outcome });
  } catch (err) {
    noteTelemetryError("escrow-metrics", err);
  }
}

export function recordPayoutLatency(outcome: "completed" | "failed", latencyMs: number): void {
  try {
    if (latencyMs >= 0 && Number.isFinite(latencyMs)) payoutLatencyMs.observe({ outcome }, latencyMs);
  } catch (err) {
    noteTelemetryError("payout-metrics", err);
  }
}

// ── infra_component_up gauge (reuses routers/infra.ts probes every 60s) ─────

async function refreshInfraMetrics(): Promise<void> {
  try {
    const { collectInfraComponentStatuses } = await import("../routers/infra");
    const statuses = await collectInfraComponentStatuses();
    for (const [component, s] of Object.entries(statuses)) {
      infraComponentUp.set({ component }, s.online ? 1 : 0);
      if (typeof s.latencyMs === "number" && s.latencyMs >= 0) {
        infraComponentLatencyMs.observe({ component }, s.latencyMs);
      }
    }
  } catch (err) {
    noteTelemetryError("infra-metrics", err);
  }
}

function startInfraMetricsLoop(): void {
  stopInfraMetricsLoop();
  // In-process 60s refresh — reuses the SAME probes as infraHealth (no
  // duplicate probing logic). Unref'd so it never holds the process open.
  infraTimer = setInterval(() => void refreshInfraMetrics(), 60_000);
  infraTimer.unref?.();
  void refreshInfraMetrics();
}

function stopInfraMetricsLoop(): void {
  if (infraTimer) {
    clearInterval(infraTimer);
    infraTimer = null;
  }
}

/** Force a single infra refresh (journeys/tests). */
export async function refreshInfraMetricsNow(): Promise<void> {
  await refreshInfraMetrics();
}

/** Prometheus text exposition for /api/metrics. */
export async function renderMetrics(): Promise<string> {
  return promRegistry.metrics();
}
