/**
 * Keeps Permify in step with users.role, because the shared adminProcedure asks Permify as well as the
 * role check, and in production an unset-up Permify refuses every admin. Safe to run on every replica.
 */
import { eq } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { getDb } from "../db";
import { permifyDeleteRelationship, permifyWriteRelationship } from "../permify";

export const PERMIFY_SCHEMA = `entity user {}

entity system {
  relation admin @user

  permission manage = admin
}`;

const SYSTEM = { type: "system", id: "global" };

export function adminChanges(current: readonly string[], wanted: readonly string[]) {
  return {
    add: wanted.filter((id) => !current.includes(id)),
    remove: current.filter((id) => !wanted.includes(id)),
  };
}

async function post(path: string, body: unknown) {
  return fetch(`${ENV.permifyUrl}/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

/** Creates this app's own space and schema if they aren't there. Other apps share this Permify. */
async function ensureSchema(tenant: string) {
  const schemas = await post(`/tenants/${tenant}/schemas/list`, { page_size: 1 });
  const list = schemas.ok ? await schemas.json() : null;
  if (list?.schemas?.length) return;
  await post("/tenants/create", { id: tenant, name: tenant }); // answers "already exists" after the first time
  const written = await post(`/tenants/${tenant}/schemas/write`, { schema: PERMIFY_SCHEMA });
  if (!written.ok) throw new Error(`schema write returned ${written.status}`);
}

async function currentAdmins(tenant: string): Promise<string[]> {
  const res = await post(`/tenants/${tenant}/data/relationships/read`, {
    metadata: { snap_token: "" },
    filter: { entity: { type: SYSTEM.type, ids: [SYSTEM.id] }, relation: "admin", subject: { type: "user", ids: [], relation: "" } },
    page_size: 100,
  });
  if (!res.ok) throw new Error(`relationship read returned ${res.status}`);
  const body = await res.json();
  return (body.tuples ?? []).map((tuple: any) => String(tuple.subject?.id));
}

export async function syncPermifyAdmins(): Promise<{ added: number; removed: number } | null> {
  if (!process.env.PERMIFY_URL) return null;
  const db = await getDb();
  if (!db) return null;
  const tenant = ENV.permifyTenantId;
  await ensureSchema(tenant);
  const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
  const { add, remove } = adminChanges(await currentAdmins(tenant), admins.map((row) => String(row.id)));
  for (const id of add) await permifyWriteRelationship({ entity: SYSTEM, relation: "admin", subject: { type: "user", id } });
  for (const id of remove) await permifyDeleteRelationship({ entity: SYSTEM, relation: "admin", subject: { type: "user", id } });
  if (add.length || remove.length) console.info(`[permifyAdmins] synced: ${add.length} added, ${remove.length} removed`);
  return { added: add.length, removed: remove.length };
}
