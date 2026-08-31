/**
 * J219 — W34 otel-stack: Alertmanager → WhatsApp ops bridge unit path.
 *
 * 1. Webhook payload → formatted WhatsApp message (alertname/severity/summary).
 * 2. Delivery invokes the platform send (mock fetch) with the ops number.
 * 3. Fail-open: send error is swallowed, alert counted as dropped, no throw.
 * 4. Disabled-default honesty: with ALERTMANAGER_WA_BRIDGE_ENABLED unset the
 *    HTTP server answers /alerts with 404 bridge-disabled; /health always
 *    reports enabled:false.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const SAMPLE = {
  status: "firing",
  alerts: [
    { status: "firing", labels: { alertname: "Elevated5xx", severity: "critical" }, annotations: { summary: "Elevated 5xx rate (>5% for 5m)" } },
    { status: "firing", labels: { alertname: "CronFailure", severity: "warning" }, annotations: { summary: "Cron job failure" } },
  ],
};

export const journey: Journey = {
  id: "J219",
  name: "alertmanager WhatsApp bridge: format → deliver, fail-open, disabled-default",
  feature: "W34 otel-stack: WhatsApp ops bridge",
  async run(_world: World) {
    const bridgePath = path.resolve(process.cwd(), "deploy", "otel", "alertmanager-wa-bridge.mjs");
    const bridge = await import(pathToFileURL(bridgePath).href);

    // 1+2. Format + deliver via mock platform send.
    const calls: Array<{ url: string; body: any; headers: any }> = [];
    const okFetch = async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { ok: true } as any;
    };
    const res1 = await bridge.handleAlertmanagerPayload(SAMPLE, {
      fetch: okFetch, to: "+1555000111", platformUrl: "http://platform.test", internalToken: "tok",
    });
    assert(res1.delivered === true, "delivery should succeed with healthy mock");
    assert(res1.message.includes("Elevated5xx") && res1.message.includes("critical"), `message missing alert content: ${res1.message}`);
    assert(res1.message.includes("FIRING"), "message missing status header");
    assert(calls.length === 1, "platform send invoked exactly once");
    assert(calls[0].url === "http://platform.test/api/internal/wa-ops-alert", `unexpected send URL ${calls[0].url}`);
    assert(calls[0].body.to === "+1555000111", "ops number not passed through");
    assert(calls[0].headers["X-Internal-Token"] === "tok", "internal token header missing");
    assert(typeof calls[0].body.body === "string" && calls[0].body.body.includes("Elevated5xx"), "WA body not forwarded");

    // 3. Fail-open: send throws → no exception escapes, delivered=false.
    const badFetch = async () => { throw new Error("connection refused"); };
    const res2 = await bridge.handleAlertmanagerPayload(SAMPLE, { fetch: badFetch, to: "+1555000111" });
    assert(res2.delivered === false, "failed send must report delivered=false");
    assert(res2.error?.includes("connection refused"), "error must be surfaced honestly");

    // HTTP-level: platform 500 also fails open.
    const errFetch = async () => ({ ok: false, status: 500 }) as any;
    const res3 = await bridge.handleAlertmanagerPayload(SAMPLE, { fetch: errFetch, to: "+1555000111" });
    assert(res3.delivered === false && res3.error?.includes("500"), "HTTP 500 must fail open");

    // 4. Disabled-default honest 404 + /health.
    delete process.env.ALERTMANAGER_WA_BRIDGE_ENABLED;
    const server = bridge.createBridgeServer({ fetch: okFetch, to: "+1555000111", platformUrl: "http://platform.test" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      const disabled = await fetch(`http://127.0.0.1:${port}/alerts`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(SAMPLE),
      });
      assert(disabled.status === 404, `disabled bridge must 404, got ${disabled.status}`);
      const disabledBody = await disabled.json() as any;
      assert(disabledBody.error === "bridge-disabled", "honest bridge-disabled error expected");
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      const healthBody = await health.json() as any;
      assert(health.status === 200 && healthBody.enabled === false, "/health must report enabled:false when disabled");
      assert(typeof healthBody.dropped === "number", "/health must expose drop counter");

      // Enabled path through the real HTTP server.
      process.env.ALERTMANAGER_WA_BRIDGE_ENABLED = "true";
      const before = calls.length;
      const enabled = await fetch(`http://127.0.0.1:${port}/alerts`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(SAMPLE),
      });
      assert(enabled.status === 200, `enabled bridge must 200, got ${enabled.status}`);
      const enabledBody = await enabled.json() as any;
      assert(enabledBody.delivered === true, "enabled bridge should deliver via mock");
      assert(calls.length === before + 1, "server path must invoke platform send");
    } finally {
      delete process.env.ALERTMANAGER_WA_BRIDGE_ENABLED;
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
};
