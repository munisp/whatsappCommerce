/**
 * === W33 embedded-api (Coder C) — embedded client admin router ===
 *
 * Platform-admin lifecycle for Embedded AP-as-a-feature clients
 * (create/suspend/rotate/list). Key material contract:
 *   - createClient/rotateKey return the ONE-TIME plaintext API key; only the
 *     SHA-256 digest is ever stored (server/services/embeddedApi.ts).
 *   - listClients NEVER returns key digests.
 * All procedures are adminProcedure (platform-admin only, Permify-backed in
 * production). The runtime /api/embedded/v1/* surface is Express
 * (server/_core/index.ts, W33 banner), not tRPC — it authenticates by API
 * key, not session, and derives the tenant from the client binding.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { EMBEDDED_SCOPES, createClient, listClients, rotateKey, suspendClient } from "../services/embeddedApi";

const scopeEnum = z.enum([...EMBEDDED_SCOPES] as [string, ...string[]]);

export const embeddedRouter = router({
  /**
   * Create an embedded client bound to ONE tenant. Returns the plaintext API
   * key exactly once — it is not recoverable afterwards (rotate instead).
   */
  createClient: adminProcedure
    .input(z.object({
      partnerName: z.string().min(1).max(160),
      tenantId: z.string().min(1),
      scopes: z.array(scopeEnum).min(1),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, input.tenantId));
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: `Tenant ${input.tenantId} not found` });
      const { client, apiKey } = await createClient(db, {
        partnerName: input.partnerName,
        tenantId: input.tenantId,
        scopes: input.scopes,
        createdBy: `admin:${ctx.user.id}`,
      });
      return {
        clientId: client.id,
        partnerName: client.partnerName,
        tenantId: client.tenantId,
        scopes: client.scopes,
        status: client.status,
        /** ONE-TIME plaintext key — store it now; only its SHA-256 digest persists. */
        apiKey,
      };
    }),

  /** Suspend a client: its key immediately fails authentication (401). */
  suspendClient: adminProcedure
    .input(z.object({ clientId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const row = await suspendClient(db, input.clientId);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Embedded client not found" });
      return { clientId: row.id, status: row.status };
    }),

  /** Rotate the API key: the old key stops working immediately. Returns the new plaintext key once. */
  rotateKey: adminProcedure
    .input(z.object({ clientId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const res = await rotateKey(db, input.clientId);
      if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "Embedded client not found" });
      return { clientId: res.client.id, status: res.client.status, apiKey: res.apiKey };
    }),

  /** List clients (optionally per tenant). Key digests are never returned. */
  listClients: adminProcedure
    .input(z.object({ tenantId: z.string().optional() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const rows = await listClients(db, input.tenantId);
      return { clients: rows };
    }),
});
