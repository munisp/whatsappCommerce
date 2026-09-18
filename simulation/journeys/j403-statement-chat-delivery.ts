// === W46 uc-docs ===
/**
 * J403 — UC-12 chat document delivery parity: a statement is delivered as a
 * chat document on BOTH channels. A WA-only customer takes the existing
 * waSender document push (simulated honestly — no creds in sim); a
 * telegram-linked customer is routed by channelParity to the telegram
 * sendDocument path (parity category 'customer_statement' registered).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant, seedOrder, bindTelegram } from "./w46-uc-docs-seed";

const WA_PHONE = "2348040000403";
const TG_PHONE = "2348040001413";
const TG_CHAT = "w46tg403";

export const journey: Journey = {
  id: "J403",
  name: "statement delivered as chat document on WA + Telegram",
  feature: "W46 uc-docs: UC-12 document delivery parity",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { generateCustomerStatement, sendCustomerStatement } = await import("../../server/services/customerStatements");
    const { tenantId } = await seedUcTenant(world, "403");

    const from = new Date(Date.now() - 30 * 86400000);
    const to = new Date(Date.now() + 86400000);

    // ── WhatsApp customer ────────────────────────────────────────────────
    await seedOrder(world, tenantId, "403a", WA_PHONE, {});
    const genWa = await generateCustomerStatement(world.db, { tenantId, customerPhone: WA_PHONE, from, to });
    const sentWa = await sendCustomerStatement(world.db, { tenantId, statementId: genWa.statements[0]!.id });
    assert(sentWa.delivery.channel === "whatsapp", "WA-only customer → whatsapp channel");
    assert(sentWa.delivery.simulated === true && sentWa.delivery.sent === false, "WA send honestly simulated (no creds in sim)");
    assert(sentWa.statement.status === "sent" && sentWa.statement.sentAt, "statement flips to sent");
    assert(sentWa.statement.channel === "whatsapp", "channel recorded on the row");

    // ── Telegram-linked customer ─────────────────────────────────────────
    await bindTelegram(world, tenantId, TG_PHONE, TG_CHAT);
    await seedOrder(world, tenantId, "403b", TG_PHONE, {});
    const genTg = await generateCustomerStatement(world.db, { tenantId, customerPhone: TG_PHONE, from, to });
    const sentTg = await sendCustomerStatement(world.db, { tenantId, statementId: genTg.statements[0]!.id });
    assert(sentTg.delivery.channel === "telegram", `telegram-linked customer → telegram (got ${sentTg.delivery.channel})`);
    assert(sentTg.statement.status === "sent", "telegram statement sent");
    // The telegram ROUTE is the parity contract (channelParity resolved the
    // linked identity and channelSender attempted sendDocument; sendDocument
    // is honestly simulated/failed-soft without a bot token in sim).

    // Parity categories registered (J246 subset semantics — never hard-coded counts).
    const { getParityCategory, PARITY_CATEGORY_IDS } = await import("../../server/services/channelParity");
    assert(getParityCategory("customer_statement")?.telegram === "full", "customer_statement parity category registered");
    assert(PARITY_CATEGORY_IDS.includes("proforma_invoice") && PARITY_CATEGORY_IDS.includes("agent_commission"), "uc-docs categories registered");

    // Cross-tenant send refused.
    const [st] = await world.db.select().from(schema.customerStatements).where(eq(schema.customerStatements.id, genWa.statements[0]!.id));
    assert(st.tenantId === tenantId, "statement row is tenant-scoped");
    let forbidden = false;
    try {
      await sendCustomerStatement(world.db, { tenantId: "sim-w46-403-x", statementId: st.id });
    } catch (e: any) {
      forbidden = e?.code === "not-found";
    }
    assert(forbidden, "another tenant cannot send the statement");
  },
};
