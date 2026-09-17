// === W45 messaging-services (Coder A2) ===
/**
 * J361 — Ban circuit breaker (MSG-25): a 403 (restricted/banned sender) on
 * the tenant's phone_number_id trips the circuit — later sends are
 * suppressed LOCALLY (no Graph call, permanent-class log row), ops is
 * alerted OFF-CHANNEL (audit_logs row for the dashboard), and crucially the
 * alert does NOT go out over the banned number. Clearing the circuit
 * restores sending.
 */
import { ADMIN_PHONE, PHONE_NUMBER_ID, TENANT_ID, assert, type World } from "../world";
import { failNextSends } from "../metaMock";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J361",
  name: "ban circuit breaker per phone_number_id",
  feature: "MSG-25 circuit on 401/403/ban codes + off-channel alert",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { isBanCircuitOpen, clearBanCircuit, isBanSignal, extractGraphErrorCodes } =
      await import("../../server/services/banCircuitBreaker");
    const { sendWhatsAppText } = await import("../../server/services/waSender");

    // Signal classification unit checks.
    assert(isBanSignal(403, "{}") && isBanSignal(401, null), "401/403 always trip");
    assert(isBanSignal(400, JSON.stringify({ error: { code: 131031 } })), "ban-class code trips even on 400");
    assert(!isBanSignal(500, "{}") && !isBanSignal(400, JSON.stringify({ error: { code: 131026 } })), "transient/recipient codes do not trip");
    assert(extractGraphErrorCodes(JSON.stringify({ error: { code: 368, error_subcode: 131031 } })).includes(368), "code extraction walks the error payload");

    try {
      // ── Trip: a 403 from Graph on this phone_number_id ────────────────
      const phone = world.newPhone("j361");
      await world.grantConsent(phone);
      world.llm.when("ban trigger hello", {
        reply: "This send hits a restricted sender.",
        intent: "greeting",
        nextState: "browse",
        extractedItems: [],
        extractedProduct: null,
        extractedQuantity: null,
        extractedAddress: null,
        confidence: 0.9,
      });
      assert(!(await isBanCircuitOpen(PHONE_NUMBER_ID)), "circuit closed before the trip");
      failNextSends(403, 1, (b) => b?.to === phone);
      await world.text(phone, "ban trigger hello");
      assert(await isBanCircuitOpen(PHONE_NUMBER_ID), "403 tripped the circuit for the sender");

      // ── Off-channel alert: dashboard audit row, NO WhatsApp alert ─────
      const audit: any[] = (await world.db.execute(
        `SELECT action, entity_id FROM audit_logs WHERE action = 'wa.ban_circuit_tripped' AND tenant_id = '${TENANT_ID}'`,
      )) as any;
      assert(audit.some((r) => r.entity_id === PHONE_NUMBER_ID), "ban trip recorded in audit_logs (dashboard-visible)");
      const adminAlerts = world.outbound.toPhone(ADMIN_PHONE)
        .filter((c) => JSON.stringify(c.body ?? {}).toLowerCase().includes("circuit"));
      assert(adminAlerts.length === 0, "the ban alert was NOT sent over the (banned) WhatsApp number");

      // ── Later sends are suppressed locally, no Graph call ─────────────
      const phone2 = world.newPhone("j361b");
      const graphBase = world.outbound.waMessages().length;
      let threw = false;
      await sendWhatsAppText(TENANT_ID, phone2, "are you there?").catch(() => { threw = true; });
      assert(threw, "send through a circuit-broken sender rejects");
      assert(world.outbound.waMessages().length === graphBase, "suppressed send never reached the Graph API");
      const { desc, eq } = await import("drizzle-orm");
      const [logRow] = await world.db.select().from(schema.whatsappNotificationLog)
        .where(eq(schema.whatsappNotificationLog.phone, phone2))
        .orderBy(desc(schema.whatsappNotificationLog.createdAt)).limit(1);
      assert(logRow?.failReason?.includes("ban_circuit_open"), `suppression logged as permanent local failure (got ${logRow?.failReason})`);

      // ── Retry sweep pushes back instead of hammering the banned number ─
      const retryId = crypto.randomUUID();
      const phone3r = world.newPhone("j361c");
      await world.grantConsent(phone3r); // consent gate precedes the circuit gate
      await world.db.insert(schema.whatsappNotificationLog).values({
        id: retryId,
        tenantId: TENANT_ID,
        phone: phone3r,
        notifType: "conversation_reply",
        status: "failed",
        payload: { type: "text", text: { preview_url: true, body: "retry while banned" } },
        attempts: 1,
        nextRetryAt: new Date(Date.now() - 60_000),
      });
      const graphBase2 = world.outbound.waMessages().length;
      const { runWaSendRetries } = await import("../../server/services/waSender");
      await runWaSendRetries({ now: new Date() });
      const [retryRow] = await world.db.select().from(schema.whatsappNotificationLog)
        .where(eq(schema.whatsappNotificationLog.id, retryId));
      assert(retryRow.status === "failed" && retryRow.nextRetryAt != null, "retry pushed back while the circuit is open");
      assert(world.outbound.waMessages().length === graphBase2, "no Graph call from the retry sweep either");
    } finally {
      // Never leak an open circuit into later journeys (in-memory fallback is
      // process-wide in the simulation).
      await clearBanCircuit(PHONE_NUMBER_ID);
    }

    // ── Circuit cleared → sends flow again ──────────────────────────────
    assert(!(await isBanCircuitOpen(PHONE_NUMBER_ID)), "circuit cleared");
    const phone3 = world.newPhone("j361d");
    const res = await sendWhatsAppText(TENANT_ID, phone3, "we are back");
    assert(res.sent === true, "send succeeds after the circuit is cleared");
  },
};
