/**
 * Classify the ledger-money webhook "failure": is it a stale test (async-ack
 * refactor) or a real money bug? Drive payment.initiate → signed charge.success
 * webhook, then POLL real TigerBeetle for the post-ack async confirm to land.
 */
import { createHmac, randomUUID } from "node:crypto";
import { CFG, trpcMutation, mintPlatformSession, seedUser, getSql, closeSql, uniqueId } from "./helpers/stack";
import { ledgerAccountId } from "../../server/services/ledgerAccounts";

const TB = process.env.TB_ADAPTER_URL!;
async function tb(id: string) {
  const r = await fetch(`${TB}/api/v1/accounts/${id}`);
  return r.status === 404 ? null : ((await r.json()) as any);
}
const sign = (raw: string) => createHmac("sha512", CFG.paystackWebhookSecret).update(raw).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await seedUser({ openId: "probe-admin", name: "Probe Admin", role: "admin" });
  const adminToken = await mintPlatformSession("probe-admin", "Probe Admin");
  const sql = getSql();

  const TENANT = uniqueId("probe-tenant"), ORDER = uniqueId("probe-order"), CUSTOMER = `+234${Math.floor(1e8 + Math.random() * 9e8)}`;
  const REF = uniqueId("PROBE-REF").toUpperCase();
  await sql`INSERT INTO orders (id,"tenantId","customerId","orderNumber",status,"totalAmount",currency,"paymentStatus","createdAt","updatedAt")
            VALUES (${ORDER},${TENANT},${uniqueId("c")},${"ORD-" + ORDER.slice(-6)},'confirmed','2500.00','NGN','unpaid',NOW(),NOW())`;

  const init = await trpcMutation<{ paymentIntentId: string }>("payment.initiate",
    { tenantId: TENANT, orderId: ORDER, amount: 2500, currency: "NGN", provider: "mojaloop", customerPhone: CUSTOMER }, adminToken);
  console.log("payment.initiate ok:", init.ok);
  if (!init.ok) { console.log("initiate error:", JSON.stringify(init)); process.exit(2); }

  const [intent] = await sql<{ ledgerPendingId: string | null }[]>`SELECT "ledgerPendingId" FROM payment_intents WHERE id=${init.data.paymentIntentId}`;
  const customer = ledgerAccountId("customer", CUSTOMER), escrow = ledgerAccountId("escrow", TENANT);
  const reserved = await tb(customer);
  console.log("AFTER initiate — customer debits_pending:", reserved?.debits_pending, "(expect 250000)");

  await sql`UPDATE payment_intents SET provider='paystack', "providerPaymentId"=${REF} WHERE id=${init.data.paymentIntentId}`;
  const raw = JSON.stringify({ event: "charge.success", data: { reference: REF, amount: 250000, currency: "NGN" } });
  const res = await fetch(`${CFG.platformUrl}/api/webhooks/paystack`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-paystack-signature": sign(raw) }, body: raw,
  });
  console.log(`webhook HTTP ${res.status}, body:`, JSON.stringify(await res.json().catch(() => null)), "(async-ack = {received:true})");

  // POLL for the POST-ACK async confirm to land on real TigerBeetle.
  let posted = 0, jstatus = "";
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const c = await tb(customer);
    const [j] = await sql<{ status: string }[]>`SELECT status FROM ledger_transfers WHERE id=${intent.ledgerPendingId}`;
    posted = c?.debits_posted ?? 0; jstatus = j?.status ?? "";
    if (posted === 250000 && jstatus === "committed") { console.log(`confirm LANDED after ~${(i + 1) * 500}ms`); break; }
  }
  const esc = await tb(escrow);
  console.log("\n==== RESULT ====");
  console.log("customer debits_posted:", posted, "(expect 250000)");
  console.log("escrow credits_posted:", esc?.credits_posted, "(expect 250000)");
  console.log("ledger_transfers journal status:", jstatus, "(expect committed)");
  const moneyMoved = posted === 250000 && esc?.credits_posted === 250000 && jstatus === "committed";
  console.log(moneyMoved
    ? "VERDICT: money DID post to real TigerBeetle (just asynchronously). The ledger-money failure is a STALE TEST vs the W48 async-ack refactor — NOT a money bug."
    : "VERDICT: money did NOT fully post — this would be a REAL bug, investigate.");
  await closeSql();
  process.exit(moneyMoved ? 0 : 1);
}
main().catch((e) => { console.error("PROBE_ERROR", e); process.exit(3); });
