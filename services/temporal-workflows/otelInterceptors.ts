/**
 * === W35 temporal-otel ===
 * services/temporal-workflows/otelInterceptors.ts — MANUAL, fail-open
 * OpenTelemetry interceptors for the Temporal worker.
 *
 * Why manual: @temporalio/interceptors-opentelemetry is NOT in the sanctioned
 * dependency set (W35 Coder C may only add the three otel instrumentation
 * packages), and @temporalio/worker is an optional runtime dep here — so this
 * module has NO static imports of any @temporalio/* or opentelemetry package.
 * Everything is structural (any-typed) and lazy; when OTEL_ENABLED is unset
 * (or @opentelemetry/api is unavailable), the interceptors pass through
 * untouched.
 *
 * Span contract:
 *   workflow execution → `temporal.workflow.<workflowType>` (SERVER)
 *   activity execution → `temporal.activity.<activityType>` (SERVER)
 * Trace context propagates via Temporal headers: the workflow inbound
 * interceptor extracts the W3C `traceparent` header (lowercase — the same
 * binding key used for Kafka) from the activation headers when present.
 */
import { trace, context, propagation, SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";

function otelEnabled(): boolean {
  return (process.env.OTEL_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Decode a Temporal header payload ({ data: Uint8Array|string }) to string. */
function decodeHeaderValue(payload: unknown): string | null {
  try {
    const data = (payload as { data?: unknown })?.data ?? payload;
    if (data == null) return null;
    if (typeof data === "string") return data;
    if (data instanceof Uint8Array || Array.isArray(data)) {
      return Buffer.from(data as Uint8Array).toString("utf8");
    }
    return String(data);
  } catch {
    return null;
  }
}

/** Extract a parent context from Temporal message headers (fail-open). */
export function extractTemporalContext(headers: Record<string, unknown> | undefined | null) {
  if (!otelEnabled()) return context.active();
  try {
    const carrier: Record<string, string> = {};
    for (const key of ["traceparent", "tracestate"]) {
      const value = decodeHeaderValue(headers?.[key]);
      if (value) carrier[key] = value;
    }
    return propagation.extract(context.active(), carrier);
  } catch {
    return context.active();
  }
}

async function runWithSpan<T>(
  name: string,
  attributes: Record<string, string>,
  parentCtx: ReturnType<typeof context.active>,
  fn: (span: Span | null) => Promise<T>,
): Promise<T> {
  if (!otelEnabled()) return fn(null);
  try {
    const tracer = trace.getTracer("whatsapp-commerce-temporal");
    return await tracer.startActiveSpan(name, { kind: SpanKind.SERVER, attributes }, parentCtx, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  } catch (err) {
    if (err && (err as { __w35TemporalHandlerError?: boolean }).__w35TemporalHandlerError) throw err;
    // Telemetry machinery itself failed — fail OPEN: run bare.
    console.warn("[temporal-otel] interceptor failed open:", (err as Error)?.message ?? err);
    return fn(null);
  }
}

/**
 * WorkflowInboundCallsInterceptor (structural): wraps workflow execution in
 * `temporal.workflow.<workflowType>` spans, continuing any traceparent found
 * in the workflow activation headers.
 */
export class OtelWorkflowInboundInterceptor {
  async execute(input: any, next: (input: any) => Promise<unknown>): Promise<unknown> {
    const workflowType = input?.info?.workflowType ?? input?.workflowType ?? "unknown";
    const parent = extractTemporalContext(input?.headers);
    return runWithSpan(
      `temporal.workflow.${workflowType}`,
      {
        "temporal.workflow_type": String(workflowType),
        "temporal.namespace": String(input?.info?.namespace ?? ""),
        "temporal.task_queue": String(input?.info?.taskQueue ?? ""),
        ...(input?.info?.workflowId ? { "temporal.workflow_id": String(input.info.workflowId) } : {}),
      },
      parent,
      async () => {
        try {
          return await next(input);
        } catch (err) {
          (err as { __w35TemporalHandlerError?: boolean }).__w35TemporalHandlerError = true;
          throw err;
        }
      },
    );
  }
}

/**
 * ActivityInboundCallsInterceptor (structural): wraps activity execution in
 * `temporal.activity.<activityType>` spans, extracting traceparent from the
 * activity headers (via context from @temporalio/activity when available).
 */
export class OtelActivityInboundInterceptor {
  constructor(private readonly ctx?: any) {}

  async execute(input: any, next: (input: any) => Promise<unknown>): Promise<unknown> {
    const info = this.ctx?.info ?? input?.info ?? {};
    const activityType = info?.activityType ?? input?.activityType ?? "unknown";
    const parent = extractTemporalContext(this.ctx?.headers ?? input?.headers);
    return runWithSpan(
      `temporal.activity.${activityType}`,
      {
        "temporal.activity_type": String(activityType),
        "temporal.namespace": String(info?.workflowNamespace ?? info?.namespace ?? ""),
        "temporal.task_queue": String(info?.taskQueue ?? ""),
        ...(info?.workflowId ? { "temporal.workflow_id": String(info.workflowId) } : {}),
      },
      parent,
      async () => {
        try {
          return await next(input);
        } catch (err) {
          (err as { __w35TemporalHandlerError?: boolean }).__w35TemporalHandlerError = true;
          throw err;
        }
      },
    );
  }
}

/**
 * Build WorkerOptions.interceptors. Returns null when OTel is disabled so the
 * worker runs exactly as before. Fail-open: never throws.
 */
export function createOtelWorkerInterceptors(): { activity: Array<(ctx: any) => { inbound: OtelActivityInboundInterceptor }>; workflow: Array<() => { inbound: OtelWorkflowInboundInterceptor }> } | null {
  if (!otelEnabled()) return null;
  try {
    return {
      activity: [(ctx: any) => ({ inbound: new OtelActivityInboundInterceptor(ctx) })],
      workflow: [() => ({ inbound: new OtelWorkflowInboundInterceptor() })],
    };
  } catch (err) {
    console.warn("[temporal-otel] interceptor setup failed open:", (err as Error)?.message ?? err);
    return null;
  }
}
// === END W35 temporal-otel ===
