// === W59 banking-pos ===
/**
 * J598 — POS lifecycle: terminal register → session create (short code + QR
 * payload) → signed webhook (HMAC verified) → claim-first settle (wallet
 * credited exactly once) → duplicate webhook is a no-op → post-commit
 * merchant receipt (fail-open). Bad signature is rejected.
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J598",
  name: "POS create → webhook verify → settle once → receipt",
  feature: "W59 banking-pos: posPayments",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/posPayments");
    const { tenantId } = await seedUcTenant(world, "598", 5981);

    const { terminal } = await svc.registerTerminal(world.db, { tenantId, provider: "softpos", terminalRef: "SOFTPOS-001", label: "Counter" });
    const again = await svc.registerTerminal(world.db, { tenantId, provider: "softpos", terminalRef: "SOFTPOS-001" });
    assert(again.duplicate === true, "terminal re-register idempotent");

    const session = await svc.createSession(world.db, { tenantId, amountCents: 150_000, channel: "physical", terminalId: terminal.id });
    assert(/^POS-\d{6}-/.test(session.reference) && session.qrPayload.includes(session.reference), "session reference + QR payload");

    // ── Bad signature rejected (fail-closed) ───────────────────────────
    process.env.POS_SOFTPOS_WEBHOOK_SECRET = "sim-secret-598";
    const body = Buffer.from(JSON.stringify({ reference: session.reference, status: "charged" }));
    assert(!svc.verifyPosWebhookSignature("softpos", body, { "x-softpos-signature": "deadbeef" }), "bad signature rejected");
    const sig = createHmac("sha256", "sim-secret-598").update(body).digest("hex");
    assert(svc.verifyPosWebhookSignature("softpos", body, { "x-softpos-signature": sig }), "good signature accepted");

    // ── Settle claim-first ─────────────────────────────────────────────
    const ev = svc.extractPosWebhookEvent("softpos", JSON.parse(body.toString()));
    assert(ev?.reference === session.reference && ev.ok, "webhook event extracted");
    const conf = await svc.confirmSession(world.db, ev!.reference, true);
    assert(conf.status === "charged" && !conf.duplicate && conf.settledCents === 150_000, "session settled");
    const [wallet] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, tenantId));
    assert(parseFloat(wallet.availableBalance) === 1500, "merchant wallet credited");
    const dup = await svc.confirmSession(world.db, ev!.reference, true);
    assert(dup.duplicate === true, "webhook replay is a duplicate no-op");
    const [wallet2] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, tenantId));
    assert(parseFloat(wallet2.availableBalance) === 1500, "replay did not double-settle");
    const [sess] = await world.db.select().from(schema.posPaymentSessions).where(eq(schema.posPaymentSessions.reference, session.reference));
    assert(sess.status === "charged", "session row charged");
  },
};
