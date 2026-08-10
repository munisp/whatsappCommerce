/**
 * J46 — Observability capture (w10 server/services/observability.ts).
 *
 * Drives the REAL integration-outbox dispatcher (cron route → processOutbox →
 * deliverOutboxEvent → OdooClient) against fault-injected fetch and asserts:
 *
 * (a) A non-retriable failure (400) marks the event 'failed' with an 'error'
 *     capture; a retriable failure (502) exhausts 5 attempts → DLQ ('dead')
 *     with a 'critical' capture — observed BOTH as a structured stdout JSON
 *     line AND via the infra.systemRecentErrors admin procedure (ring buffer)
 *     with service/operation/tenantId/severity/context.
 * (b) No secret material ever lands in a capture: the DLQ record carries none
 *     of the configured Odoo apiKey, and a planted token-ish `extra` key is
 *     redacted to "[redacted]" before storage/egress.
 * (c) With ERROR_WEBHOOK_URL set, a fire-and-forget Slack-style POST hits the
 *     mock endpoint with sanitized text.
 * (d) When that webhook sink itself fails (500), the failure is swallowed —
 *     the capture still lands in the ring/stdout and the outbox dispatcher
 *     keeps working.
 */
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const ODOO_KEY = "odoo-api-key-j46-plaintext";
const ODOO_URL = "https://odoo.sim.local";
const ERRHOOK_URL = "https://errhook.sim.local/ingest";
const PLANTED_TOKEN = "planted-token-j46-must-never-leak";

interface StdoutTap {
  lines: string[];
  restore: () => void;
}

/** Capture process.stdout writes for the duration of the journey. */
function tapStdout(): StdoutTap {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    try {
      lines.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    } catch { /* tap must never break output */ }
    return (orig as any)(chunk, ...rest);
  };
  return { lines, restore: () => { (process.stdout as any).write = orig; } };
}

/** Structured capture lines emitted by observability.stdoutSink. */
function captureLines(tap: StdoutTap): any[] {
  return tap.lines
    .flatMap((l) => l.split("\n"))
    .filter((l) => l.startsWith('{"level"'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

async function outboxEventRow(world: World, id: string): Promise<any | null> {
  const schema = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await world.db
    .select()
    .from(schema.integrationEvents)
    .where(eq(schema.integrationEvents.id, id))
    .limit(1)
    .catch(() => []);
  return row ?? null;
}

export const journey: Journey = {
  id: "J46",
  name: "observability capture",
  feature: "outbox DLQ → critical capture, redaction, error webhook sink",
  async run(world) {
    const { enqueueIntegrationEvent, MAX_OUTBOX_ATTEMPTS } = await import("../../server/services/integrations/outbox");
    const { captureException } = await import("../../server/services/observability");
    const caller = await adminCaller();
    const tap = tapStdout();

    try {
      // Odoo integration configured (apiKey encrypted at rest — J45 territory);
      // the host is fault-injected below so delivery really fails.
      await caller.integrations.setConfig({
        tenantId: TENANT_ID,
        system: "odoo",
        url: ODOO_URL,
        apiKey: ODOO_KEY,
        enabled: true,
        extras: { database: "simdb", username: "simuser" },
      });

      // ── (a.1) non-retriable 400 → 'failed' on the first attempt ─────────
      world.meta.hostStatus.set("odoo.sim.local", 400);
      const evFailed = await enqueueIntegrationEvent(world.db, {
        tenantId: TENANT_ID,
        system: "odoo",
        entity: "order",
        entityId: "order-j46-400",
        action: "created",
        data: { customerEmail: "j46@sim.local", items: [] },
      });
      assert(evFailed, "outbox event (400 case) enqueued");
      const r400 = await world.runCron("/api/scheduled/integration-outbox-dispatch");
      assert(r400.status === 200, `dispatcher cron answered 200 (got ${r400.status})`);
      const row400 = await outboxEventRow(world, evFailed!);
      assert(row400?.status === "failed", `(a.1) non-retriable event is 'failed' (got ${row400?.status})`);
      assert((row400?.attempts ?? 0) === 1, `(a.1) exactly one attempt (got ${row400?.attempts})`);

      // ── (a.2) retriable 502 → retry exhaustion → DLQ 'dead' ─────────────
      world.meta.hostStatus.set("odoo.sim.local", 502);
      const evDlq = await enqueueIntegrationEvent(world.db, {
        tenantId: TENANT_ID,
        system: "odoo",
        entity: "order",
        entityId: "order-j46-dlq",
        action: "created",
        data: { customerEmail: "j46@sim.local", items: [] },
      });
      assert(evDlq, "outbox event (DLQ case) enqueued");
      for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i++) {
        await world.runCron("/api/scheduled/integration-outbox-dispatch");
      }
      const rowDlq = await outboxEventRow(world, evDlq!);
      assert(rowDlq?.status === "dead", `(a.2) exhausted event reached the DLQ (got ${rowDlq?.status})`);
      assert(rowDlq?.attempts === MAX_OUTBOX_ATTEMPTS, `(a.2) attempts exhausted (got ${rowDlq?.attempts})`);

      // Ring buffer via the REAL admin procedure.
      const { errors } = await caller.infra.systemRecentErrors({ limit: 100 });
      const dlqCap = errors.find(
        (e: any) => e.service === "integrations/outbox" && e.operation === "dispatch.dlq",
      );
      assert(dlqCap, "(a.2) critical DLQ capture present in infra.systemRecentErrors");
      assert(dlqCap.severity === "critical", `(a.2) severity critical (got ${dlqCap.severity})`);
      assert(dlqCap.tenantId === TENANT_ID, "(a.2) capture carries the tenantId");
      assert(dlqCap.extra?.eventId === evDlq && dlqCap.extra?.system === "odoo",
        "(a.2) capture context identifies event/system");
      const failedCap = errors.find(
        (e: any) => e.service === "integrations/outbox" && e.operation === "dispatch.failed",
      );
      assert(failedCap && failedCap.severity === "error", "(a.1) non-retriable failure captured at 'error' severity");

      // Stdout structured JSON line for the DLQ transition.
      const dlqLine = captureLines(tap).find(
        (l) => l.service === "integrations/outbox" && l.operation === "dispatch.dlq",
      );
      assert(dlqLine, "(a.2) structured stdout JSON line emitted for the DLQ transition");
      assert(dlqLine.level === "critical" && dlqLine.severity === "critical", "(a.2) stdout line is critical");
      assert(typeof dlqLine.timestamp === "string" && typeof dlqLine.message === "string",
        "(a.2) stdout line is machine-parseable (timestamp + message)");

      // ── (b) no secret material in any capture; extra keys redacted ──────
      assert(
        !JSON.stringify(dlqCap).includes(ODOO_KEY) && !JSON.stringify(dlqLine).includes(ODOO_KEY),
        "(b) DLQ capture contains no integration secret material",
      );
      captureException(new Error("j46 redaction probe"), {
        service: "sim/j46",
        operation: "redactionProbe",
        tenantId: TENANT_ID,
        severity: "error",
        extra: { accessToken: PLANTED_TOKEN, webhookSecret: PLANTED_TOKEN, note: "visible-context" },
      });
      const afterPlant = await caller.infra.systemRecentErrors({ limit: 5 });
      const planted = afterPlant.errors.find((e: any) => e.operation === "redactionProbe");
      assert(planted, "(b) redaction probe captured");
      assert(planted.extra?.accessToken === "[redacted]" && planted.extra?.webhookSecret === "[redacted]",
        "(b) token-ish extra keys are redacted before storage");
      assert(planted.extra?.note === "visible-context", "(b) non-sensitive context survives");
      assert(!JSON.stringify(planted).includes(PLANTED_TOKEN), "(b) planted token never stored");

      // ── (c) ERROR_WEBHOOK_URL fire-and-forget POST, sanitized ───────────
      process.env.ERROR_WEBHOOK_URL = ERRHOOK_URL;
      world.meta.hostStatus.set("errhook.sim.local", 200);
      captureException(new Error("j46 webhook probe"), {
        service: "sim/j46",
        operation: "webhookProbe",
        tenantId: TENANT_ID,
        severity: "critical",
        extra: { accessToken: PLANTED_TOKEN },
      });
      await world.waitFor(
        () => world.outbound.all().some((c) => c.url.startsWith(ERRHOOK_URL) && c.method === "POST"),
        8000,
        "error-webhook POST",
      );
      const hookCall = world.outbound.all().find((c) => c.url.startsWith(ERRHOOK_URL));
      const hookText = String(hookCall?.body?.text ?? "");
      assert(hookText.includes("[CRITICAL] sim/j46/webhookProbe"), `(c) webhook text carries severity+service (got ${hookText.slice(0, 120)}…)`);
      assert(hookText.includes(`tenant=${TENANT_ID}`), "(c) webhook text carries the tenant");
      assert(hookText.includes("[redacted]"), "(c) webhook text is redacted");
      assert(!hookText.includes(PLANTED_TOKEN), "(c) planted token never left the process");

      // ── (d) webhook sink failure is swallowed; pipeline unaffected ──────
      world.meta.hostStatus.set("errhook.sim.local", 500);
      captureException(new Error("j46 webhook outage probe"), {
        service: "sim/j46",
        operation: "webhookOutageProbe",
        severity: "error",
      });
      await world.waitFor(
        () => world.outbound.all().filter((c) => c.url.startsWith(ERRHOOK_URL)).length >= 2,
        8000,
        "failing error-webhook POST",
      );
      const afterOutage = await caller.infra.systemRecentErrors({ limit: 5 });
      assert(
        afterOutage.errors.some((e: any) => e.operation === "webhookOutageProbe"),
        "(d) capture still lands in the ring buffer when the webhook sink is down",
      );
      assert(
        captureLines(tap).some((l) => l.operation === "webhookOutageProbe"),
        "(d) stdout sink unaffected by the webhook outage",
      );
      // The outbox dispatcher itself is unaffected by the sink outage.
      const sweep = await world.runCron("/api/scheduled/integration-outbox-dispatch");
      assert(sweep.status === 200 && sweep.json?.ok === true, "(d) outbox sweep healthy after webhook outage");
    } finally {
      tap.restore();
      delete process.env.ERROR_WEBHOOK_URL;
    }
  },
};
