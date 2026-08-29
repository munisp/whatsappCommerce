/**
 * === W34 wa-ops-alert (merger seam) ===
 * J222 — platform receiver route for the Alertmanager→WhatsApp ops bridge.
 *
 *   1. Auth: missing/wrong X-Internal-Token → 401; endpoint fail-closed
 *      (503) when INTERNAL_API_KEY is unset.
 *   2. Zod validation: bad payloads → 400.
 *   3. Honest 503 when WhatsApp env credentials are not configured.
 *   4. Valid alert → REAL WhatsApp send pipeline (waSender → Meta Graph,
 *      intercepted by the sim fetch mock) and 200 with wamids.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const INTERNAL = "j222-internal-secret";

export const journey: Journey = {
  id: "J222",
  name: "wa-ops-alert receiver: internal-token gate + zod + real WA send",
  feature: "W34 merger seam: /api/internal/wa-ops-alert for the ops bridge",
  async run(world: World) {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${world.baseUrl}/api/internal/wa-ops-alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body ?? {}),
      });
    const payload = { to: "2348099900000", body: "[W34] TestAlert critical: Elevated5xx on platform", kind: "ops-alert" };

    // ── 1. Auth gate ───────────────────────────────────────────────────
    delete process.env.INTERNAL_API_KEY;
    const disabled = await post(payload, { "X-Internal-Token": INTERNAL });
    assert(disabled.status === 503, `unset INTERNAL_API_KEY must fail closed 503 (got ${disabled.status})`);

    process.env.INTERNAL_API_KEY = INTERNAL;
    const noAuth = await post(payload);
    assert(noAuth.status === 401, `missing token must 401 (got ${noAuth.status})`);
    const wrongAuth = await post(payload, { "X-Internal-Token": "wrong" });
    assert(wrongAuth.status === 401, `wrong token must 401 (got ${wrongAuth.status})`);

    // ── 2. Zod validation ──────────────────────────────────────────────
    const bad1 = await post({ body: "x", kind: "ops-alert" }, { "X-Internal-Token": INTERNAL });
    assert(bad1.status === 400, `missing 'to' must 400 (got ${bad1.status})`);
    const bad2 = await post({ ...payload, kind: "marketing" }, { "X-Internal-Token": INTERNAL });
    assert(bad2.status === 400, `wrong kind must 400 (got ${bad2.status})`);

    // ── 3. Honest 503 when WhatsApp is not configured ──────────────────
    const savedToken = process.env.WHATSAPP_TOKEN;
    const savedPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WAC_WHATSAPP_TOKEN;
    delete process.env.WAC_WHATSAPP_PHONE_ID;
    const unconfigured = await post(payload, { "X-Internal-Token": INTERNAL });
    assert(unconfigured.status === 503, `WA unconfigured must 503 honestly (got ${unconfigured.status})`);
    const unconfiguredBody = await unconfigured.json().catch(() => null);
    assert(unconfiguredBody?.error === "whatsapp-not-configured", `honest error code (got ${JSON.stringify(unconfiguredBody)})`);

    // ── 4. Configured → real send pipeline (Meta intercepted by sim) ───
    process.env.WHATSAPP_TOKEN = "sim-wa-access-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "pn_sim_001";
    const ok = await post(payload, { "X-Internal-Token": INTERNAL });
    const okBody = await ok.json().catch(() => null);
    assert(ok.status === 200 && okBody?.sent === true, `alert send must succeed (got ${ok.status}: ${JSON.stringify(okBody)})`);
    const { outbound } = await import("../metaMock");
    const sent = outbound.ofType("text", "2348099900000");
    assert(sent.some((c: any) => String(c.body?.text?.body ?? "").includes("TestAlert")),
      "alert text went through the real WA send pipeline");

    // Restore env for later journeys.
    if (savedToken === undefined) delete process.env.WHATSAPP_TOKEN; else process.env.WHATSAPP_TOKEN = savedToken;
    if (savedPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = savedPhone;
  },
};
