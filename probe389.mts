import { bootWorld } from "./simulation/world";
const world = await bootWorld();
const { tenantCaller } = await import("./simulation/journeys/helpers");
const c = await tenantCaller("sim-tenant", { userId: 3891 });
try {
  await (c as any).payments2.cancel({ tenantId: "sim-tenant", id: "11111111-1111-4111-8111-111111111111" });
  console.log("PROBE cancel resolved");
} catch (e: any) { console.log("PROBE cancel err:", e?.message); }
process.exit(0);
