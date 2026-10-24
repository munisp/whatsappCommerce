// === W65 conversational ===
/**
 * J623 — R7 universal NL command bar:
 *   1. parse "create invoice for Musa ₦45,000" → drafted create_invoice with
 *      amount extracted; execute(confirmToken) runs the REAL
 *      arInvoices.create mutation (row verified in ar_invoices).
 *   2. wallet balance read path through the bar.
 *   3. Missing-fields flow: "add a product" drafts create_product with
 *      missingFields ["name"]; execute → BAD_REQUEST and the token is
 *      RESTORED; execute again with {name} succeeds (real product.create).
 *   4. Admin gating: a non-admin tenant caller cannot execute an adminOnly
 *      draft (suspend_merchant) → FORBIDDEN; admin can.
 *   5. Admin retry_dlq runs the real webhookDlq.retryEvent (dead → received).
 *   6. One-shot tokens: a second execute of the same token → NOT_FOUND.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J623",
  name: "command bar parse → confirm → execute incl. admin gating + missing fields",
  feature: "W65 R7 universal NL command bar",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const tenantUser = await tenantCaller(TENANT_ID, { role: "user" });

    // ── 1. create invoice (real mutation) ──────────────────────────────────
    const parsedInv: any = await admin.commandBar.parse({ text: "create invoice for Musa ₦45,000" });
    assert(parsedInv.intent === "create_invoice", `invoice intent (got ${parsedInv.intent})`);
    assert(Number(parsedInv.params.amount) === 45000, `amount extracted (got ${JSON.stringify(parsedInv.params)})`);
    assert(parsedInv.confirmToken, "confirm token issued");
    const execInv: any = await admin.commandBar.execute({
      confirmToken: parsedInv.confirmToken,
      params: { tenantId: TENANT_ID },
    });
    assert(execInv.intent === "create_invoice", "invoice executed");
    const invoices = await world.db
      .select()
      .from(schema.arInvoices)
      .where(eq(schema.arInvoices.tenantId, TENANT_ID));
    assert(
      invoices.some((i: any) => i.customerName === "Musa" && Number(i.amountCents) === 4_500_000),
      "real ar_invoices row created (integer cents)",
    );

    // ── 2. wallet balance read ─────────────────────────────────────────────
    const parsedBal: any = await admin.commandBar.parse({ text: "wallet balance" });
    assert(parsedBal.intent === "wallet_balance", "balance intent");
    const bal: any = await admin.commandBar.execute({
      confirmToken: parsedBal.confirmToken,
      params: { tenantId: TENANT_ID },
    });
    assert(bal.result !== undefined, "balance result returned (null wallet is honest)");

    // ── 3. missing-fields flow with token restore ──────────────────────────
    const parsedProd: any = await admin.commandBar.parse({ text: "add a product" });
    assert(parsedProd.intent === "create_product", "product intent");
    assert(parsedProd.missingFields.includes("name"), `name missing (got ${parsedProd.missingFields})`);
    await expectTrpcError(
      admin.commandBar.execute({ confirmToken: parsedProd.confirmToken, params: { tenantId: TENANT_ID } }),
      "BAD_REQUEST",
      "execute without name",
    );
    const execProd: any = await admin.commandBar.execute({
      confirmToken: parsedProd.confirmToken,
      params: { tenantId: TENANT_ID, name: "J623 Command Soap", price: 250 },
    });
    assert(execProd.intent === "create_product", "product executed after filling missing field");
    const prods = await world.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.tenantId, TENANT_ID));
    assert(prods.some((p: any) => p.name === "J623 Command Soap"), "real product row created");

    // ── 4. admin gating: tenant caller cannot run adminOnly drafts ─────────
    const parsedSuspend: any = await tenantUser.commandBar.parse({ text: "suspend merchant some-tenant-9" });
    assert(parsedSuspend.intent === "suspend_merchant" && parsedSuspend.adminOnly, "admin-only intent flagged");
    await expectTrpcError(
      tenantUser.commandBar.execute({ confirmToken: parsedSuspend.confirmToken }),
      "FORBIDDEN",
      "non-admin execute of suspend_merchant",
    );
    // …and the token is bound to the drafter: the admin cannot spend it.
    const parsedDlqByTenant: any = await tenantUser.commandBar.parse({ text: "retry dlq event evt-j623-x" });
    await expectTrpcError(
      admin.commandBar.execute({ confirmToken: parsedDlqByTenant.confirmToken }),
      "FORBIDDEN",
      "cross-user token spend",
    );

    // ── 5. admin retry_dlq runs the real mutation ──────────────────────────
    await world.db.insert(schema.waWebhookEvents).values({
      id: "evt-j623-dlq",
      rawPayload: { j: 623 },
      status: "dead",
      retryCount: 5,
      lastError: "simulated permanent failure",
    }).onConflictDoNothing();
    const parsedDlq: any = await admin.commandBar.parse({ text: "retry dlq event evt-j623-dlq" });
    assert(parsedDlq.intent === "retry_dlq" && parsedDlq.adminOnly, "dlq intent flagged admin");
    const dlqRes: any = await admin.commandBar.execute({ confirmToken: parsedDlq.confirmToken });
    assert((dlqRes.result as any)?.ok === true, "retryEvent ok");
    const [evt] = await world.db
      .select()
      .from(schema.waWebhookEvents)
      .where(eq(schema.waWebhookEvents.id, "evt-j623-dlq"));
    assert(evt?.status === "received" && evt.retryCount === 0, "dead-letter event reset for retry");

    // ── 6. one-shot token: replaying the consumed token fails ──────────────
    await expectTrpcError(
      admin.commandBar.execute({ confirmToken: parsedDlq.confirmToken }),
      "NOT_FOUND",
      "consumed token replay",
    );
  },
};
