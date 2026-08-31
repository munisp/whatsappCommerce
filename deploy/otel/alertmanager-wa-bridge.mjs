// === W34 otel-stack (Coder B) ===
// alertmanager-wa-bridge — Alertmanager webhook receiver that forwards alerts
// to the ops WhatsApp number via the platform's internal send pipeline.
//
// HARD CONSTRAINTS (wave doctrine):
//   - stdlib ONLY (node:http / global fetch) — package.json/lockfiles frozen
//     for Coder B; no new deps may be introduced here.
//   - FAIL-OPEN: a failed/impossible delivery is logged + counted and the
//     process keeps running. Alertmanager always gets 200 for a parsed
//     webhook so a broken WhatsApp path can never create an Alertmanager
//     retry storm. Delivery health is honestly visible via /health.
//   - DISABLED BY DEFAULT: unless ALERTMANAGER_WA_BRIDGE_ENABLED === "true",
//     POST /alerts returns an honest 404 {error:"bridge-disabled"} (Alertmanager
//     should simply not be configured to route here; email still fires).
//
// Platform send contract: POST ${PLATFORM_API_URL}${WA_BRIDGE_SEND_PATH}
//   headers: X-Internal-Token: INTERNAL_API_KEY (platform internalProcedure
//   shared-secret pattern), Content-Type: application/json
//   body: { to: OPS_ALERT_WHATSAPP, body: <formatted text>, kind: "ops-alert" }
// If the platform endpoint is not yet deployed (404/5xx/network), the alert
// is dropped honestly: logged, counted in /health.dropped, never thrown.
import http from "node:http";
import { pathToFileURL } from "node:url";

const ENABLED = () => process.env.ALERTMANAGER_WA_BRIDGE_ENABLED === "true";
const PORT = () => Number(process.env.WA_BRIDGE_PORT ?? 9099);
const PLATFORM_URL = () => (process.env.PLATFORM_API_URL ?? "http://platform:3000").replace(/\/$/, "");
const SEND_PATH = () => process.env.WA_BRIDGE_SEND_PATH ?? "/api/internal/wa-ops-alert";
const OPS_NUMBER = () => process.env.OPS_ALERT_WHATSAPP ?? "";
const startedAt = new Date().toISOString();

// In-process delivery accounting for honest /health reporting.
const stats = {
  received: 0,
  delivered: 0,
  dropped: 0,
  lastError: null, // string | null
  lastDeliveryAt: null, // ISO string | null
};

/**
 * Format an Alertmanager v4 webhook payload into a single WhatsApp-safe text
 * message (plain text, no markdown tables — WhatsApp renders *bold* only).
 */
export function formatAlertMessage(payload) {
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
  const overall = payload?.status === "resolved" ? "RESOLVED" : "FIRING";
  const lines = [`*${overall}* — ${alerts.length} alert(s)`];
  for (const a of alerts.slice(0, 10)) {
    const name = a?.labels?.alertname ?? "unknown";
    const sev = a?.labels?.severity ?? "?";
    const summary = a?.annotations?.summary ?? "";
    lines.push(`• [${sev}] ${name}${summary ? ` — ${summary}` : ""}`);
  }
  if (alerts.length > 10) lines.push(`…and ${alerts.length - 10} more`);
  const text = lines.join("\n");
  // WhatsApp body cap safety: keep under 4000 chars.
  return text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
}

/**
 * Deliver a formatted message through the platform's internal send pipeline.
 * Throws on transport/HTTP failure — callers must catch (fail-open).
 */
export async function deliverViaPlatform(message, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const to = deps.to ?? OPS_NUMBER();
  if (!to) throw new Error("OPS_ALERT_WHATSAPP not configured");
  const res = await fetchFn(`${deps.platformUrl ?? PLATFORM_URL()}${deps.sendPath ?? SEND_PATH()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": deps.internalToken ?? process.env.INTERNAL_API_KEY ?? "",
    },
    body: JSON.stringify({ to, body: message, kind: "ops-alert" }),
  });
  if (!res.ok) throw new Error(`platform send failed: HTTP ${res.status}`);
  return true;
}

/**
 * Handle one Alertmanager webhook body: format + deliver, fail-open.
 * Returns { delivered: boolean, message } — never throws.
 */
export async function handleAlertmanagerPayload(payload, deps = {}) {
  stats.received++;
  const message = formatAlertMessage(payload);
  try {
    await deliverViaPlatform(message, deps);
    stats.delivered++;
    stats.lastDeliveryAt = new Date().toISOString();
    return { delivered: true, message };
  } catch (err) {
    stats.dropped++;
    stats.lastError = String(err?.message ?? err);
    console.error(`[wa-bridge] delivery failed (fail-open, alert dropped): ${stats.lastError}`);
    console.error(`[wa-bridge] dropped alert body: ${message}`);
    return { delivered: false, message, error: stats.lastError };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

export function createBridgeServer(deps = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        // /health is always available, even when disabled — it is the honest
        // surface that reports whether the bridge is actually on.
        return json(res, 200, {
          ok: true,
          enabled: ENABLED(),
          startedAt,
          ...stats,
        });
      }
      if (req.method === "POST" && req.url === "/alerts") {
        if (!ENABLED()) {
          return json(res, 404, { error: "bridge-disabled", hint: "set ALERTMANAGER_WA_BRIDGE_ENABLED=true to enable" });
        }
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: "invalid-json" });
        }
        const result = await handleAlertmanagerPayload(payload, deps);
        // Always 200 for parsed webhooks (fail-open: Alertmanager must not
        // retry-storm when the WhatsApp path is down). Delivery outcome is
        // in the body + /health.
        return json(res, 200, { ok: true, delivered: result.delivered });
      }
      return json(res, 404, { error: "not-found" });
    } catch (err) {
      // Last-resort fail-open: log and 200 so Alertmanager never loops.
      console.error("[wa-bridge] unhandled error (fail-open):", err);
      return json(res, 200, { ok: true, delivered: false, error: "internal-failopen" });
    }
  });
}

// Start only when executed directly (journeys import functions without a listener).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createBridgeServer();
  server.listen(PORT(), () => {
    console.log(`[wa-bridge] listening on :${PORT()} enabled=${ENABLED()}`);
  });
}
// === END W34 otel-stack ===
