/**
 * === W34 otel-core ===
 * J216 — propagation chain: scheduler cron fire → server cron route span
 *        SHARES the fire's trace_id; internal service-to-service call linked.
 *
 *   1. services/scheduler makeTraceparent(): fresh W3C root per fire, and
 *      TRACEPARENT env reuse (k8s CronJob parent).
 *   2. invokeRoute() really sends the `traceparent` header (mock HTTP server).
 *   3. POST /api/scheduled/sla-scan with cron JWT + traceparent → server-side
 *      spans share the scheduler trace_id and the http span is parented to
 *      the scheduler fire's span id (extracted traceparent).
 *   4. An internalProcedure HTTP call (x-internal-api-key) with its own
 *      traceparent produces a linked trpc span on that trace.
 */
import http from "node:http";
import { SignJWT } from "jose";
import { assert, JWT_SECRET_VALUE, type World } from "../world";
import type { Journey } from "../runner";

const TP_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

export const journey: Journey = {
  id: "J216",
  name: "traceparent propagation: scheduler→cron route + internal service call",
  feature: "W34 otel-core: W3C trace context propagation across services",
  async run(world: World) {
    const telemetry = await import("../../server/_core/telemetry");
    process.env.OTEL_ENABLED = "true";
    process.env.OTEL_TRACES_EXPORTER = "inmemory";
    await telemetry.initTelemetry();
    assert(telemetry.isTelemetryActive(), "telemetry did not activate");
    telemetry.clearRecordedSpans();

    const scheduler = await import("../../services/scheduler/scheduler.mjs");

    // ── 1. makeTraceparent: fresh root / TRACEPARENT reuse ───────────────
    delete process.env.TRACEPARENT;
    const tp1 = scheduler.makeTraceparent();
    assert(TP_RE.test(tp1), `makeTraceparent malformed: ${tp1}`);
    const tp1b = scheduler.makeTraceparent();
    assert(tp1b !== tp1, "makeTraceparent must mint a fresh traceparent per fire");
    process.env.TRACEPARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const tp2 = scheduler.makeTraceparent();
    assert(tp2.split("-")[1] === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "TRACEPARENT env trace id not reused");
    assert(tp2.split("-")[2] !== "bbbbbbbbbbbbbbbb", "TRACEPARENT reuse must mint a fresh span id");
    delete process.env.TRACEPARENT;

    // ── 2. invokeRoute sends the traceparent header ──────────────────────
    const seen: Array<{ traceparent?: string }> = [];
    const mock = http.createServer((req, res) => {
      seen.push({ traceparent: req.headers.traceparent as string | undefined });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    try {
      const port = (mock.address() as { port: number }).port;
      const r = await scheduler.invokeRoute("/api/scheduled/sla-scan", {
        platformUrl: `http://127.0.0.1:${port}`,
        secret: "j216-cron-secret",
      });
      assert(r.status === 200, `scheduler mock invoke failed (${r.status})`);
      // Note: when the CALLER process itself runs OTel fetch instrumentation,
      // a second (instrumentation) traceparent is appended — the explicit
      // scheduler header is the first value and must be well-formed.
      const tpHeader = seen[0]?.traceparent?.split(",")[0]?.trim();
      assert(seen.length === 1 && !!tpHeader && TP_RE.test(tpHeader),
        `scheduler did not send a valid traceparent header (got ${seen[0]?.traceparent ?? "none"})`);
    } finally {
      await new Promise((resolve) => mock.close(resolve));
    }

    // ── 3. Cron fire → server cron route span shares trace_id ────────────
    const cronTp = scheduler.makeTraceparent();
    const cronTraceId = cronTp.split("-")[1];
    const cronFireSpanId = cronTp.split("-")[2];
    const cronToken = await new SignJWT({ openId: "cron_sim", appId: "sim-app", name: "Sim Cron" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(new TextEncoder().encode(JWT_SECRET_VALUE));
    const cronRes = await fetch(`${world.baseUrl}/api/scheduled/sla-scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cronToken}`, traceparent: cronTp },
      body: "{}",
    });
    assert(cronRes.status === 200, `cron route expected 200 (got ${cronRes.status})`);
    assert(cronRes.headers.get("x-trace-id") === cronTraceId,
      `cron response x-trace-id should equal the propagated trace id (got ${cronRes.headers.get("x-trace-id")})`);

    await world.waitFor(() =>
      telemetry.getRecordedSpans().some((s) => s.traceId === cronTraceId && s.parentSpanId === cronFireSpanId),
      8000,
      "server span parented to scheduler fire",
    );
    const cronSpans = telemetry.getRecordedSpans().filter((s) => s.traceId === cronTraceId);
    assert(cronSpans.length > 0, "no server spans on the scheduler trace");
    const linked = cronSpans.find((s) => s.parentSpanId === cronFireSpanId);
    assert(!!linked, `no span parented to scheduler fire span ${cronFireSpanId}`);
    assert(linked!.name.includes("/api/scheduled/sla-scan"), `cron route span misnamed: ${linked!.name}`);

    // ── 4. Internal service-to-service tRPC call linked ──────────────────
    const intTp = scheduler.makeTraceparent();
    const intTraceId = intTp.split("-")[1];
    const intRes = await fetch(`${world.baseUrl}/api/trpc/infra.recordWafEvent?batch=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-api-key": "j216-internal",
        traceparent: intTp,
      },
      body: JSON.stringify({ "0": { json: { severity: "low", attackType: "j216-propagation", sourceIp: "127.0.0.1" } } }),
    });
    assert(intRes.status === 200, `internal procedure call expected 200 (got ${intRes.status}: ${(await intRes.clone().text().catch(() => "")).slice(0, 200)})`);
    const intSpan = telemetry.getRecordedSpans().find((s) => s.name === "trpc.infra.recordWafEvent");
    assert(!!intSpan, "no trpc.infra.recordWafEvent span recorded");
    assert(intSpan!.traceId === intTraceId, `internal call span not linked to caller trace (${intSpan!.traceId} != ${intTraceId})`);
  },
};
