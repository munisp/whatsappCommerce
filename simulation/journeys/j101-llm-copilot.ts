/**
 * J101 — W22 LLM copilot: merchant Q&A + SOC2 incident triage.
 *
 * Scenario (fully deterministic — COPILOT_LLM_ENABLED unset, so every call
 * exercises the heuristic fallback; no network LLM calls):
 *   1. Triage: an incident with a sensitive purge/export description +
 *      related anomaly alert is triaged via copilot.triageIncident →
 *      structured suggestion (severitySuggestion=critical, runbook steps,
 *      postmortem draft) with fallbackUsed=true.
 *   2. Redaction: the assembled triage prompt contains neither the phone
 *      number nor the API secret embedded in the incident description.
 *   3. Ask: copilot.ask returns an aggregate-grounded answer (today's
 *      sales in integer cents, order count, top product, credit balance).
 *   4. Audit log: copilot_queries rows written per invocation — sha256
 *      prompt hashes only, no raw prompt/PII persisted.
 *   5. Tenant guards: cross-tenant triage/ask/history are FORBIDDEN, and a
 *      same-tenant triage of another tenant's incident sees no data.
 */
import { assert } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";
// NOTE: the copilot service must be imported LAZILY inside run() — loadJourneys()
// executes before bootWorld() sets the sim env, and server modules snapshot
// process.env at import time (see world.ts "Env FIRST").

export const journey: Journey = {
  id: "J101",
  name: "LLM copilot — incident triage + merchant ask",
  feature: "fallback contract, runbook retrieval, aggregate-grounded answers, prompt redaction, copilot_queries audit log, tenant guards",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { buildTriagePrompt, redactForPrompt } = await import("../../server/services/llmCopilot");
    assert(!process.env.COPILOT_LLM_ENABLED, "J101 requires the LLM disabled (deterministic fallback)");

    const admin = await adminCaller();
    const tenant = (await admin.onboarding.start({ name: "J101 Copilot Tenant" })).tenantId;
    const caller = await tenantCaller(tenant, { userId: 1010 });
    const intruderTenant = (await admin.onboarding.start({ name: "J101 Intruder" })).tenantId;
    const intruder = await tenantCaller(intruderTenant, { userId: 1011 });

    // ── Seed: incident (with PII/secret in description) + anomaly alert ──
    const incidentId = crypto.randomUUID();
    const phone = "+2348012345678";
    const secret = "sk-live-j101secret123";
    await world.db.insert(schema.incidents).values({
      id: incidentId,
      tenantId: tenant,
      severity: "low",
      status: "open",
      title: "Suspicious retention purge of customer data",
      description: `Off-hours export burst by actor ${phone} using api_key=${secret}`,
      openedAt: new Date(),
    });
    await world.db.insert(schema.anomalyAlerts).values({
      tenantId: tenant,
      signal: "sensitive_event_rate",
      score: 0.97,
      detail: { events: 10 },
      status: "open",
      windowBucket: new Date(),
    });

    // ── Seed: merchant data for the ask snapshot ─────────────────────────
    await world.db.insert(schema.orders).values([
      {
        id: crypto.randomUUID(), tenantId: tenant, customerId: "j101-c1",
        orderNumber: "J101-1", totalAmount: "125.50", currency: "NGN",
        items: [{ name: "Rice 50kg", quantity: 2 }],
      },
      {
        id: crypto.randomUUID(), tenantId: tenant, customerId: "j101-c1",
        orderNumber: "J101-2", totalAmount: "74.50", currency: "NGN",
        items: [{ name: "Rice 50kg", quantity: 1 }, { name: "Beans", quantity: 1 }],
      },
    ]);
    await world.db.insert(schema.creditAccounts).values({
      supplierTenantId: "j101-supplier",
      buyerTenantId: tenant,
      limitCents: 500000,
      outstandingCents: 120000,
    });

    // ── 1. Triage via the router (fallback path exercised) ───────────────
    const triage = await caller.copilot.triageIncident({ tenantId: tenant, incidentId });
    assert(triage.fallbackUsed === true, `LLM disabled → fallbackUsed (got ${JSON.stringify(triage.fallbackUsed)})`);
    assert(triage.severitySuggestion === "critical",
      `purge/export incident escalates to critical (got ${triage.severitySuggestion})`);
    assert(Array.isArray(triage.runbookSteps) && triage.runbookSteps.length >= 3,
      `structured runbook steps returned (got ${JSON.stringify(triage.runbookSteps)})`);
    assert(typeof triage.postmortemDraft === "string" && triage.postmortemDraft.length > 40,
      "postmortem draft returned");
    assert(triage.likelyCause.includes("sensitive_event_rate"),
      `likely cause references the anomaly signal (got ${triage.likelyCause})`);

    // ── 2. Redaction: assembled prompt carries no secret / phone ─────────
    const incidentRow = {
      id: incidentId, tenantId: tenant, severity: "low", status: "open",
      title: "Suspicious retention purge of customer data",
      description: `Off-hours export burst by actor ${phone} using api_key=${secret}`,
      openedAt: new Date(), resolvedAt: null,
    } as any;
    const prompt = buildTriagePrompt(incidentRow, [], "Runbook excerpt");
    assert(!prompt.includes(phone), "prompt redacts the actor phone number");
    assert(!prompt.includes(secret), "prompt redacts the API secret");
    assert(redactForPrompt(`call ${phone}`).includes("[REDACTED-PHONE]"), "redactor masks phones");

    // ── 3. Merchant ask: aggregate-grounded template answer ──────────────
    const ask = await caller.copilot.ask({ tenantId: tenant, question: "how much did I sell today and what is my credit balance?" });
    assert(ask.fallbackUsed === true, "ask uses the fallback template when LLM disabled");
    assert(ask.snapshot.salesCentsToday === 20000, `integer-cents sales total (got ${ask.snapshot.salesCentsToday})`);
    assert(ask.snapshot.ordersToday === 2, `order count (got ${ask.snapshot.ordersToday})`);
    assert(ask.snapshot.topProducts[0]?.name === "Rice 50kg" && ask.snapshot.topProducts[0]?.quantity === 3,
      `top product aggregate (got ${JSON.stringify(ask.snapshot.topProducts)})`);
    assert(ask.snapshot.creditOutstandingCents === 120000, "credit outstanding aggregate");
    assert(ask.answer.includes("200.00"), `answer grounded on sales total (got "${ask.answer}")`);
    assert(ask.answer.includes("1200.00"), `answer grounded on credit balance (got "${ask.answer}")`);

    // ── 4. Audit log: copilot_queries rows, hashes only ──────────────────
    const rows = await world.db.select().from(schema.copilotQueries);
    const mine = rows.filter((r: any) => r.tenantId === tenant);
    assert(mine.length >= 2, `triage + ask logged (got ${mine.length})`);
    const kinds = mine.map((r: any) => r.kind).sort();
    assert(kinds.includes("triage") && kinds.includes("ask"), `both kinds logged (got ${kinds})`);
    for (const r of mine) {
      assert(/^[0-9a-f]{64}$/.test(r.promptHash), `prompt stored as sha256 hash (got ${r.promptHash})`);
      assert(r.fallbackUsed === true, "fallback flag logged");
      assert(typeof r.latencyMs === "number" && r.latencyMs >= 0, "latency logged");
      const raw = JSON.stringify(r);
      assert(!raw.includes(phone) && !raw.includes(secret), "no PII/secret persisted in copilot_queries");
    }
    const history = await caller.copilot.history({ tenantId: tenant });
    assert(history.length >= 2, "copilot.history returns the tenant's rows");

    // ── 5. Tenant guards ─────────────────────────────────────────────────
    await expectTrpcError(
      intruder.copilot.triageIncident({ tenantId: tenant, incidentId }),
      "FORBIDDEN", "cross-tenant triage",
    );
    await expectTrpcError(
      intruder.copilot.ask({ tenantId: tenant, question: "sales?" }),
      "FORBIDDEN", "cross-tenant ask",
    );
    await expectTrpcError(
      intruder.copilot.history({ tenantId: tenant }),
      "FORBIDDEN", "cross-tenant history",
    );
    // Same-tenant call against another tenant's incident id sees no data.
    const blind = await intruder.copilot.triageIncident({ tenantId: intruderTenant, incidentId });
    assert(blind.fallbackUsed === true && blind.likelyCause.includes("not found"),
      "cross-tenant incident id is invisible to the intruder");
  },
};
