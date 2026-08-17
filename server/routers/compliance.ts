import { z } from "zod";
import { and, desc, eq, gte, or } from "drizzle-orm";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  taxFilings, cacRegistrations, procurementBids, governmentContracts,
  users, tenantMemberships, sessionRevocations, incidents, anomalyAlerts,
  customers, orders, conversations, channelMessages, creditAccounts,
} from "../../drizzle/schema";
import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import { appendAuditEventTx, verifyAuditChain } from "../services/auditChain";
import { scanAuditAnomaliesTx } from "../services/auditAnomaly";
import {
  listRetentionPolicies, purgeExecute, purgePreview,
  UnknownEntityError, upsertRetentionPolicy,
} from "../services/retention";

// Stateless JWT sessions (12h TTL, see server/_core/auth.ts): a user counts
// as having an active session when they signed in within the TTL window and
// no unexpired revoke-all marker exists in session_revocations.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const incidentStatusEnum = z.enum(["open", "investigating", "mitigated", "resolved"]);
const incidentSeverityEnum = z.enum(["low", "medium", "high", "critical"]);
const anomalyAlertStatusEnum = z.enum(["open", "acknowledged", "dismissed"]);

export const complianceRouter = router({
  // ── FIRS Tax Filings ─────────────────────────────────────────────────────
  listTaxFilings: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const conds = [eq(taxFilings.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(taxFilings.status, input.status as "draft" | "submitted" | "accepted" | "rejected" | "under_review"));
      return db.select().from(taxFilings).where(and(...conds)).orderBy(desc(taxFilings.createdAt)).limit(input.limit);
    }),

  createTaxFiling: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      filingType: z.string().default("vat"),
      taxAuthority: z.string().default("firs"),
      periodStart: z.string(),
      periodEnd: z.string(),
      grossRevenue: z.string(),
      taxableAmount: z.string(),
      taxAmount: z.string(),
      currency: z.string().default("NGN"),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      await db.insert(taxFilings).values({
        id, ...input,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        status: "draft", documents: [], createdAt: now, updatedAt: now,
      });
      return { id };
    }),

  submitTaxFiling: protectedProcedure
    .input(z.object({ id: z.string(), referenceNumber: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [filing] = await db.select().from(taxFilings).where(eq(taxFilings.id, input.id)).limit(1);
      if (!filing) throw new TRPCError({ code: "NOT_FOUND", message: "Tax filing not found" });
      assertTenantAccess(ctx.user, filing.tenantId);
      await db.update(taxFilings).set({
        status: "submitted",
        referenceNumber: input.referenceNumber ?? `FIRS-${Date.now().toString(36).toUpperCase()}`,
        submittedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(taxFilings.id, input.id));
      return { ok: true };
    }),

  // ── CAC Business Registration ────────────────────────────────────────────
  listCacRegistrations: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      return db.select().from(cacRegistrations).where(eq(cacRegistrations.tenantId, input.tenantId)).orderBy(desc(cacRegistrations.createdAt)).limit(input.limit);
    }),

  createCacRegistration: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      businessName: z.string().min(2),
      businessType: z.string().default("sole_proprietorship"),
      rcNumber: z.string().optional(),
      tinNumber: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      await db.insert(cacRegistrations).values({ id, ...input, status: "pending", documents: [], createdAt: now, updatedAt: now });
      return { id };
    }),

  updateCacStatus: protectedProcedure
    .input(z.object({ id: z.string(), status: z.string(), rcNumber: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [cac] = await db.select().from(cacRegistrations).where(eq(cacRegistrations.id, input.id)).limit(1);
      if (!cac) throw new TRPCError({ code: "NOT_FOUND", message: "CAC registration not found" });
      assertTenantAccess(ctx.user, cac.tenantId);
      await db.update(cacRegistrations).set({
        status: input.status,
        rcNumber: input.rcNumber,
        approvedAt: input.status === "approved" ? new Date() : undefined,
        updatedAt: new Date(),
      }).where(eq(cacRegistrations.id, input.id));
      return { ok: true };
    }),

  // ── B2G Procurement Bids ─────────────────────────────────────────────────
  listProcurementBids: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const conds = [eq(procurementBids.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(procurementBids.status, input.status as "draft" | "submitted" | "shortlisted" | "awarded" | "rejected" | "withdrawn"));
      return db.select().from(procurementBids).where(and(...conds)).orderBy(desc(procurementBids.createdAt)).limit(input.limit);
    }),

  createProcurementBid: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      contractTitle: z.string().min(5),
      procuringEntity: z.string().min(2),
      contractValue: z.string(),
      currency: z.string().default("NGN"),
      deadline: z.string().optional(),
      technicalProposal: z.string().optional(),
      financialProposal: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      await db.insert(procurementBids).values({
        id, ...input,
        deadline: input.deadline ? new Date(input.deadline) : undefined,
        status: "draft", documents: [], createdAt: now, updatedAt: now,
      });
      return { id };
    }),

  submitProcurementBid: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [bid] = await db.select().from(procurementBids).where(eq(procurementBids.id, input.id)).limit(1);
      if (!bid) throw new TRPCError({ code: "NOT_FOUND", message: "Bid not found" });
      assertTenantAccess(ctx.user, bid.tenantId);
      await db.update(procurementBids).set({ status: "submitted", submittedAt: new Date(), updatedAt: new Date() }).where(eq(procurementBids.id, input.id));
      return { ok: true };
    }),

  // ── Government Contracts ─────────────────────────────────────────────────
  listGovernmentContracts: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      return db.select().from(governmentContracts).where(eq(governmentContracts.tenantId, input.tenantId)).orderBy(desc(governmentContracts.createdAt)).limit(input.limit);
    }),

  // ── Compliance Summary ───────────────────────────────────────────────────
  complianceSummary: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const [filings, cacs, bids] = await Promise.all([
        db.select().from(taxFilings).where(eq(taxFilings.tenantId, input.tenantId)),
        db.select().from(cacRegistrations).where(eq(cacRegistrations.tenantId, input.tenantId)),
        db.select().from(procurementBids).where(eq(procurementBids.tenantId, input.tenantId)),
      ]);
      return {
        taxFilings: { total: filings.length, submitted: filings.filter(f => f.status !== "draft").length, accepted: filings.filter(f => f.status === "accepted").length },
        cacRegistrations: { total: cacs.length, approved: cacs.filter(c => c.status === "approved").length },
        procurementBids: { total: bids.length, submitted: bids.filter(b => b.status !== "draft").length, awarded: bids.filter(b => b.status === "awarded").length },
      };
    }),

  // ── W19 SOC2: tamper-evident audit chain ─────────────────────────────────
  verifyAuditChain: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      return verifyAuditChain(db, { tenantId: input.tenantId });
    }),

  // ── W19 SOC2: access review ──────────────────────────────────────────────
  accessReview: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const now = Date.now();
      const [homeUsers, memberships, revocations] = await Promise.all([
        db.select().from(users).where(eq(users.tenantId, input.tenantId)),
        db.select().from(tenantMemberships).where(eq(tenantMemberships.tenantId, input.tenantId)),
        db.select().from(sessionRevocations).where(gte(sessionRevocations.expiresAt, new Date())),
      ]);
      const memberRole = new Map(memberships.map((m: any) => [String(m.userId), m.role as string]));
      const memberIds = new Set(memberships.map((m: any) => String(m.userId)));
      const revokedNow = new Set(
        revocations
          .filter((r: any) => r.jti?.startsWith("user:"))
          .map((r: any) => String(r.jti).slice("user:".length)),
      );
      const seen = new Set<string>();
      const out: Array<{ userId: string; name: string | null; phone: string | null; role: string; lastLoginAt: string | null; activeSessions: number }> = [];
      for (const u of homeUsers as any[]) {
        const key = String(u.id);
        seen.add(key);
        const last = u.lastSignedIn ? new Date(u.lastSignedIn) : null;
        const active = last && now - last.getTime() < SESSION_TTL_MS && !revokedNow.has(key) ? 1 : 0;
        out.push({
          userId: key,
          name: u.name ?? null,
          phone: u.phone ?? null,
          role: memberRole.get(key) ?? u.role,
          lastLoginAt: last ? last.toISOString() : null,
          activeSessions: active,
        });
      }
      // Membership-only users (home tenant elsewhere) still appear with their membership role.
      for (const mid of Array.from(memberIds)) {
        if (seen.has(mid)) continue;
        const [u] = await db.select().from(users).where(eq(users.id, Number(mid))).limit(1);
        const last = u?.lastSignedIn ? new Date(u.lastSignedIn) : null;
        const active = u && last && now - last.getTime() < SESSION_TTL_MS && !revokedNow.has(mid) ? 1 : 0;
        out.push({
          userId: mid,
          name: u?.name ?? null,
          phone: u?.phone ?? null,
          role: memberRole.get(mid)!,
          lastLoginAt: last ? last.toISOString() : null,
          activeSessions: active,
        });
      }
      return out;
    }),

  // ── W19 SOC2: retention policies + purge ─────────────────────────────────
  retentionPolicies: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const rows = await listRetentionPolicies(db, input.tenantId);
      return rows.map((r: any) => ({
        entity: r.entity,
        retentionDays: r.retentionDays,
        legalHold: r.legalHold,
        updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
      }));
    }),

  upsertRetentionPolicy: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      entity: z.string().min(1),
      retentionDays: z.number().int().min(0),
      legalHold: z.boolean().default(false),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      try {
        const row = await upsertRetentionPolicy(db, input, String(ctx.user.id));
        return { ok: true, id: row.id as string };
      } catch (e) {
        if (e instanceof UnknownEntityError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
    }),

  purgePreview: protectedProcedure
    .input(z.object({ tenantId: z.string(), entity: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      try {
        return await purgePreview(db, input.tenantId, input.entity);
      } catch (e) {
        if (e instanceof UnknownEntityError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
    }),

  purgeExecute: protectedProcedure
    .input(z.object({ tenantId: z.string(), entity: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      try {
        return await purgeExecute(db, input.tenantId, { entity: input.entity, actorId: String(ctx.user.id) });
      } catch (e) {
        if (e instanceof UnknownEntityError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
    }),

  // ── W19 SOC2: customer data export (GDPR/NDPR portability) ──────────────
  exportCustomerData: protectedProcedure
    .input(z.object({ tenantId: z.string(), customerId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const [customer] = await db.select().from(customers)
        .where(and(eq(customers.id, input.customerId), eq(customers.tenantId, input.tenantId))).limit(1);
      if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
      const [customerOrders, customerConversations, credit] = await Promise.all([
        db.select().from(orders).where(and(eq(orders.customerId, input.customerId), eq(orders.tenantId, input.tenantId))),
        db.select().from(conversations).where(and(eq(conversations.customerId, input.customerId), eq(conversations.tenantId, input.tenantId))),
        db.select().from(creditAccounts).where(eq(creditAccounts.buyerTenantId, input.tenantId)),
      ]);
      const phone = (customer as any).whatsappPhone as string | undefined;
      const messages = phone
        ? await db.select().from(channelMessages).where(and(eq(channelMessages.tenantId, input.tenantId), or(eq(channelMessages.fromAddress, phone), eq(channelMessages.toAddress, phone))))
        : [];
      // Audit the export itself — sensitive event for W20 anomaly detection.
      await appendAuditEventTx(db, {
        tenantId: input.tenantId,
        eventType: "customer_data_export",
        actorId: String(ctx.user.id),
        payload: { customerId: input.customerId },
      });
      return {
        exportedAt: new Date().toISOString(),
        customer,
        orders: customerOrders,
        conversations: customerConversations,
        messages,
        credit,
      };
    }),

  // ── W19 SOC2: incident log ───────────────────────────────────────────────
  listIncidents: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: incidentStatusEnum.optional(), limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const conds = [eq(incidents.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(incidents.status, input.status));
      return db.select().from(incidents).where(and(...conds)).orderBy(desc(incidents.openedAt)).limit(input.limit);
    }),

  createIncident: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      severity: incidentSeverityEnum.default("low"),
      title: z.string().min(1),
      description: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const inserted = await db.insert(incidents).values({
        tenantId: input.tenantId,
        severity: input.severity,
        title: input.title,
        description: input.description ?? null,
        status: "open",
        openedAt: new Date(),
      }).returning();
      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      await appendAuditEventTx(db, {
        tenantId: input.tenantId,
        eventType: "incident_created",
        actorId: String(ctx.user.id),
        payload: { incidentId: row.id, severity: input.severity, title: input.title },
      });
      return row;
    }),

  updateIncident: protectedProcedure
    .input(z.object({
      incidentId: z.string(),
      status: incidentStatusEnum.optional(),
      severity: incidentSeverityEnum.optional(),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [incident] = await db.select().from(incidents).where(eq(incidents.id, input.incidentId)).limit(1);
      if (!incident) throw new TRPCError({ code: "NOT_FOUND", message: "Incident not found" });
      assertTenantAccess(ctx.user, incident.tenantId);
      const set: Record<string, unknown> = {};
      if (input.status) set.status = input.status;
      if (input.severity) set.severity = input.severity;
      if (input.title) set.title = input.title;
      if (input.description !== undefined) set.description = input.description;
      if (input.status === "resolved") set.resolvedAt = new Date();
      if (input.status && input.status !== "resolved") set.resolvedAt = null;
      await db.update(incidents).set(set).where(eq(incidents.id, input.incidentId));
      await appendAuditEventTx(db, {
        tenantId: incident.tenantId,
        eventType: "incident_updated",
        actorId: String(ctx.user.id),
        payload: { incidentId: input.incidentId, ...set, resolvedAt: set.resolvedAt instanceof Date ? set.resolvedAt.toISOString() : (set.resolvedAt ?? null) },
      });
      return { ok: true };
    }),

  // ── W20: audit-stream anomaly detection ──────────────────────────────────
  anomalyScan: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      windowMs: z.number().int().min(60_000).optional(),
      now: z.string().optional(), // ISO override for deterministic tests/journeys
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      return scanAuditAnomaliesTx(db, input.tenantId, {
        windowMs: input.windowMs,
        now: input.now ? new Date(input.now) : undefined,
      });
    }),

  anomalyAlerts: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: anomalyAlertStatusEnum.optional(),
      limit: z.number().default(50),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const conds = [eq(anomalyAlerts.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(anomalyAlerts.status, input.status));
      return db.select().from(anomalyAlerts).where(and(...conds)).orderBy(desc(anomalyAlerts.createdAt)).limit(input.limit);
    }),

  updateAnomalyAlert: protectedProcedure
    .input(z.object({
      alertId: z.string(),
      status: z.enum(["acknowledged", "dismissed"]),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [alert] = await db.select().from(anomalyAlerts).where(eq(anomalyAlerts.id, input.alertId)).limit(1);
      if (!alert) throw new TRPCError({ code: "NOT_FOUND", message: "Anomaly alert not found" });
      assertTenantAccess(ctx.user, alert.tenantId);
      await db.update(anomalyAlerts).set({ status: input.status }).where(eq(anomalyAlerts.id, input.alertId));
      return { ok: true };
    }),

  incidentStatus: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const rows = await db.select().from(incidents).where(eq(incidents.tenantId, input.tenantId)).orderBy(desc(incidents.openedAt));
      const rollup = { open: 0, investigating: 0, mitigated: 0, resolved: 0 };
      for (const r of rows as any[]) {
        if (r.status in rollup) rollup[r.status as keyof typeof rollup] += 1;
      }
      return {
        ...rollup,
        recent: (rows as any[]).slice(0, 10).map((r) => ({
          id: r.id,
          title: r.title,
          severity: r.severity,
          status: r.status,
          openedAt: r.openedAt instanceof Date ? r.openedAt.toISOString() : r.openedAt,
        })),
      };
    }),
});

