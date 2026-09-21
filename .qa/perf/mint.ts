// Prints a seeded tenant user's session token for the perf scripts.
import { mintPlatformSession, seedUser, closeSql, uniqueId } from "../../tests/e2e/helpers/stack";
const tenant = uniqueId("perf-tenant");
await seedUser({ openId: "perf-user", name: "Perf User", role: "user", tenantId: tenant });
const token = await mintPlatformSession("perf-user", "Perf User");
console.log(`TENANT=${tenant}\nTOKEN=${token}`);
await closeSql();
