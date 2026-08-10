/**
 * scripts/staging-e2e.ts — real-credentials smoke against a DEPLOYED staging
 * instance (w10). NOT part of vitest; run explicitly:
 *
 *   npx tsx scripts/staging-e2e.ts
 *
 * Reads credentials from the environment (see docs/STAGING_E2E.md for the
 * full matrix). Prints a PASS/FAIL/SKIP matrix and exits non-zero on any
 * FAIL. Any integration whose env is unset is SKIPPED with a message, never
 * failed — so partial credential sets still give signal.
 *
 * Steps:
 *   1. Health/ready probe of STAGING_BASE_URL.
 *   2. Meta: credential check + send a marker text via Graph to the staging
 *      tenant's test number, then poll the admin notifications tRPC endpoint
 *      for the webhook round-trip (requires STAGING_ADMIN_TOKEN).
 *   3. Paystack: initialize a N100 test charge and verify the reference via
 *      the Paystack API. The payment is NEVER auto-completed — completing the
 *      test card flow and delivering the webhook is a manual step (doc §5).
 *   4. Odoo/Twenty/Medusa: reuse the existing onboarding validation checks
 *      from server/services/onboarding.ts.
 */

import {
  checkIntegrationConnection,
  checkWhatsAppCredentials,
  checkWabaAccess,
  type ValidationCheckResult,
} from "../server/services/onboarding";

// ── Env parsing ──────────────────────────────────────────────────────────────

export interface StagingEnv {
  baseUrl?: string;
  adminToken?: string;
  stagingTenantId?: string;
  metaPhoneNumberId?: string;
  metaAccessToken?: string;
  metaWabaId?: string;
  metaRecipient?: string;
  paystackSecretKey?: string;
  paystackEmail?: string;
  odooUrl?: string;
  twentyUrl?: string;
  twentyApiKey?: string;
  medusaUrl?: string;
  medusaApiKey?: string;
  /** ms to poll for the Meta webhook round-trip before giving up. */
  pollTimeoutMs: number;
}

export function parseEnv(env: NodeJS.ProcessEnv = process.env): StagingEnv {
  const nz = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  return {
    baseUrl: nz(env.STAGING_BASE_URL)?.replace(/\/+$/, ""),
    adminToken: nz(env.STAGING_ADMIN_TOKEN),
    stagingTenantId: nz(env.STAGING_TENANT_ID),
    metaPhoneNumberId: nz(env.META_TEST_PHONE_NUMBER_ID),
    metaAccessToken: nz(env.META_TEST_ACCESS_TOKEN),
    metaWabaId: nz(env.META_TEST_WABA_ID),
    metaRecipient: nz(env.META_TEST_RECIPIENT),
    paystackSecretKey: nz(env.PAYSTACK_TEST_SECRET_KEY),
    paystackEmail: nz(env.PAYSTACK_TEST_EMAIL),
    odooUrl: nz(env.ODOO_URL),
    twentyUrl: nz(env.TWENTY_URL),
    twentyApiKey: nz(env.TWENTY_API_KEY),
    medusaUrl: nz(env.MEDUSA_URL),
    medusaApiKey: nz(env.MEDUSA_API_KEY),
    pollTimeoutMs: Number(env.STAGING_POLL_TIMEOUT_MS ?? 90_000) || 90_000,
  };
}

// ── Result model ─────────────────────────────────────────────────────────────

export type StepStatus = "PASS" | "FAIL" | "SKIP";
export interface StepResult {
  step: string;
  status: StepStatus;
  detail?: string;
}

/** True when the run has at least one FAIL (exit code input). */
export function hasFailure(results: StepResult[]): boolean {
  return results.some((r) => r.status === "FAIL");
}

export function renderMatrix(results: StepResult[]): string {
  const width = Math.max(...results.map((r) => r.step.length), 4);
  const lines = results.map((r) => {
    const detail = r.detail ? ` — ${r.detail}` : "";
    return `${r.step.padEnd(width)}  ${r.status}${detail}`;
  });
  const counts = {
    PASS: results.filter((r) => r.status === "PASS").length,
    FAIL: results.filter((r) => r.status === "FAIL").length,
    SKIP: results.filter((r) => r.status === "SKIP").length,
  };
  return [...lines, "", `PASS=${counts.PASS} FAIL=${counts.FAIL} SKIP=${counts.SKIP}`].join("\n");
}

const fromCheck = (step: string, c: ValidationCheckResult): StepResult =>
  c.ok ? { step, status: "PASS" } : { step, status: "FAIL", detail: c.detail };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FetchFn = typeof fetch;

// ── Step 1: health / ready ───────────────────────────────────────────────────

export async function stepHealth(cfg: StagingEnv, fetchFn: FetchFn = fetch): Promise<StepResult[]> {
  if (!cfg.baseUrl) return [{ step: "health.ready", status: "SKIP", detail: "STAGING_BASE_URL unset" }];
  const out: StepResult[] = [];
  try {
    const res = await fetchFn(`${cfg.baseUrl}/health/ready`, { signal: AbortSignal.timeout(10_000) });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) {
      out.push({ step: "health.ready", status: "FAIL", detail: `HTTP ${res.status}` });
    } else if (body && typeof body === "object" && "components" in body) {
      const bad = Object.entries(body.components as Record<string, { ok: boolean; error?: string }>)
        .filter(([, c]) => !c.ok)
        .map(([name, c]) => `${name}(${c.error ?? "not-ok"})`);
      out.push(
        bad.length === 0
          ? { step: "health.ready", status: "PASS", detail: "all components ok" }
          : { step: "health.ready", status: "FAIL", detail: `components not ready: ${bad.join(", ")}` },
      );
    } else {
      out.push({ step: "health.ready", status: "PASS", detail: `HTTP ${res.status}` });
    }
  } catch (e: any) {
    out.push({ step: "health.ready", status: "FAIL", detail: `unreachable: ${e?.message ?? e}` });
  }
  return out;
}

// ── Step 2: Meta round-trip ─────────────────────────────────────────────────

export async function stepMeta(cfg: StagingEnv, fetchFn: FetchFn = fetch): Promise<StepResult[]> {
  const out: StepResult[] = [];
  if (!cfg.metaPhoneNumberId || !cfg.metaAccessToken) {
    return [{ step: "meta.credentials", status: "SKIP", detail: "META_TEST_PHONE_NUMBER_ID / META_TEST_ACCESS_TOKEN unset" }];
  }
  out.push(fromCheck("meta.credentials", await checkWhatsAppCredentials(cfg.metaPhoneNumberId, cfg.metaAccessToken, fetchFn)));
  if (cfg.metaWabaId) {
    out.push(fromCheck("meta.waba", await checkWabaAccess(cfg.metaWabaId, cfg.metaAccessToken, fetchFn)));
  }

  if (!cfg.metaRecipient) {
    out.push({ step: "meta.send", status: "SKIP", detail: "META_TEST_RECIPIENT unset (no test number to send to)" });
    return out;
  }
  if (out.some((r) => r.status === "FAIL")) {
    out.push({ step: "meta.send", status: "SKIP", detail: "credential check failed" });
    return out;
  }

  const marker = `staging-e2e ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 8)}`;
  let sent = false;
  try {
    const res = await fetchFn(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.metaPhoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.metaAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: cfg.metaRecipient,
        type: "text",
        text: { body: marker },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: any = await res.json().catch(() => null);
    sent = res.ok && !!body?.messages?.[0]?.id;
    out.push(
      sent
        ? { step: "meta.send", status: "PASS", detail: `wamid=${body.messages[0].id}` }
        : { step: "meta.send", status: "FAIL", detail: `Graph returned ${res.status}: ${JSON.stringify(body).slice(0, 200)}` },
    );
  } catch (e: any) {
    out.push({ step: "meta.send", status: "FAIL", detail: `send failed: ${e?.message ?? e}` });
  }

  // Round-trip: the staging webhook (Echo/inbound pipeline) should surface the
  // inbound echo of our marker via the admin notifications endpoint.
  if (!sent || !cfg.baseUrl || !cfg.adminToken || !cfg.stagingTenantId) {
    out.push({
      step: "meta.roundtrip",
      status: "SKIP",
      detail: !sent
        ? "send failed"
        : "STAGING_BASE_URL / STAGING_ADMIN_TOKEN / STAGING_TENANT_ID unset — round-trip not polled",
    });
    return out;
  }
  const deadline = Date.now() + cfg.pollTimeoutMs;
  let found = false;
  let lastErr = "";
  while (Date.now() < deadline && !found) {
    try {
      const input = encodeURIComponent(JSON.stringify({ json: { tenantId: cfg.stagingTenantId, limit: 50 } }));
      const res = await fetchFn(`${cfg.baseUrl}/api/trpc/notifications.adminList?input=${input}`, {
        headers: { Authorization: `Bearer ${cfg.adminToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const body: any = await res.json().catch(() => null);
        const items: any[] = body?.result?.data?.json?.items ?? body?.result?.data?.json ?? [];
        found = JSON.stringify(items).includes(marker.split(" ").slice(-1)[0]); // unique token
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
    if (!found) await sleep(5_000);
  }
  out.push(
    found
      ? { step: "meta.roundtrip", status: "PASS", detail: "marker observed via admin notifications" }
      : { step: "meta.roundtrip", status: "FAIL", detail: `marker not observed within ${cfg.pollTimeoutMs}ms${lastErr ? ` (last: ${lastErr})` : ""}` },
  );
  return out;
}

// ── Step 3: Paystack ─────────────────────────────────────────────────────────

export async function stepPaystack(cfg: StagingEnv, fetchFn: FetchFn = fetch): Promise<StepResult[]> {
  if (!cfg.paystackSecretKey) {
    return [{ step: "paystack.init", status: "SKIP", detail: "PAYSTACK_TEST_SECRET_KEY unset" }];
  }
  const out: StepResult[] = [];
  const headers = { Authorization: `Bearer ${cfg.paystackSecretKey}`, "content-type": "application/json" };
  let reference = "";
  try {
    const res = await fetchFn("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers,
      body: JSON.stringify({
        amount: 10_000, // N100.00 in kobo
        email: cfg.paystackEmail ?? "staging-e2e@example.com",
        reference: `STG-E2E-${Date.now()}`,
        metadata: { source: "staging-e2e" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: any = await res.json().catch(() => null);
    if (res.ok && body?.status === true && body?.data?.authorization_url) {
      reference = body.data.reference;
      out.push({ step: "paystack.init", status: "PASS", detail: `reference=${reference}` });
    } else {
      out.push({ step: "paystack.init", status: "FAIL", detail: `HTTP ${res.status}: ${(body?.message ?? "").slice(0, 200)}` });
    }
  } catch (e: any) {
    return [{ step: "paystack.init", status: "FAIL", detail: `initialize failed: ${e?.message ?? e}` }];
  }

  // Verify: an untouched test charge must NOT be successful — we never
  // auto-complete real payments. Completing the test-card flow is manual (doc).
  if (!reference) return out;
  try {
    const res = await fetchFn(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers, signal: AbortSignal.timeout(15_000),
    });
    const body: any = await res.json().catch(() => null);
    const status = body?.data?.status;
    if (res.ok && body?.status === true && status && status !== "success") {
      out.push({
        step: "paystack.verify",
        status: "PASS",
        detail: `reference pending (${status}) — manual test-card + webhook step still required`,
      });
    } else {
      out.push({ step: "paystack.verify", status: "FAIL", detail: `unexpected verify state: HTTP ${res.status} status=${status}` });
    }
  } catch (e: any) {
    out.push({ step: "paystack.verify", status: "FAIL", detail: `verify failed: ${e?.message ?? e}` });
  }
  return out;
}

// ── Step 4: integrations (Odoo / Twenty / Medusa) ───────────────────────────

export async function stepIntegrations(cfg: StagingEnv, fetchFn: FetchFn = fetch): Promise<StepResult[]> {
  const out: StepResult[] = [];
  if (!cfg.odooUrl) {
    out.push({ step: "integration.odoo", status: "SKIP", detail: "ODOO_URL unset" });
  } else {
    out.push(fromCheck("integration.odoo", await checkIntegrationConnection(
      "odoo", { url: cfg.odooUrl, apiKey: "n/a", enabled: true }, fetchFn)));
  }
  if (!cfg.twentyUrl || !cfg.twentyApiKey) {
    out.push({ step: "integration.twenty", status: "SKIP", detail: "TWENTY_URL / TWENTY_API_KEY unset" });
  } else {
    out.push(fromCheck("integration.twenty", await checkIntegrationConnection(
      "twenty", { url: cfg.twentyUrl, apiKey: cfg.twentyApiKey, enabled: true }, fetchFn)));
  }
  if (!cfg.medusaUrl || !cfg.medusaApiKey) {
    out.push({ step: "integration.medusa", status: "SKIP", detail: "MEDUSA_URL / MEDUSA_API_KEY unset" });
  } else {
    out.push(fromCheck("integration.medusa", await checkIntegrationConnection(
      "medusa", { url: cfg.medusaUrl, apiKey: cfg.medusaApiKey, enabled: true }, fetchFn)));
  }
  return out;
}

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runStagingE2E(cfg: StagingEnv, fetchFn: FetchFn = fetch): Promise<StepResult[]> {
  const results: StepResult[] = [];
  results.push(...(await stepHealth(cfg, fetchFn)));
  results.push(...(await stepMeta(cfg, fetchFn)));
  results.push(...(await stepPaystack(cfg, fetchFn)));
  results.push(...(await stepIntegrations(cfg, fetchFn)));
  return results;
}

// Only execute when run directly (imported by tests without side effects).
const invokedAs = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (invokedAs.endsWith("staging-e2e.ts") || invokedAs.endsWith("staging-e2e")) {
  (async () => {
    const cfg = parseEnv();
    if (!cfg.baseUrl) {
      console.error("STAGING_BASE_URL is required — see docs/STAGING_E2E.md for the full env matrix.");
      process.exit(2);
    }
    console.log(`staging-e2e against ${cfg.baseUrl}\n`);
    const results = await runStagingE2E(cfg);
    console.log(renderMatrix(results));
    process.exit(hasFailure(results) ? 1 : 0);
  })().catch((e) => {
    console.error("staging-e2e crashed:", e);
    process.exit(1);
  });
}
