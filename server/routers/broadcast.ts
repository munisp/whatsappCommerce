import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, desc, and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { assertTenantAccess, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  broadcastCampaigns,
  broadcastRecipients,
  whatsappTemplates,
  customers,
  tenants,
} from "../../drizzle/schema";
import { redisIncrExStrict, RateLimitUnavailableError } from "../_core/rateLimit";
import { ENV } from "../_core/env";
import {
  normalizeWaPhone,
  sendWhatsAppTemplate,
  sendWhatsAppText,
} from "../services/waSender";
import {
  getLastInboundMap as getSessionWindowLastInboundMap,
  WA_WINDOW_MS as SESSION_WINDOW_MS,
} from "../services/sessionWindow";
import { applyQualityThrottle } from "../services/waQuality";
import { toMinorUnitsExact } from "../../shared/escrowAmounts";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** WhatsApp customer-service window: free-form text allowed within 24h of last inbound. */
export const WA_WINDOW_MS = SESSION_WINDOW_MS;

/** Default per-tenant broadcast throughput (messages started per minute). */
export const DEFAULT_BROADCAST_RATE_PER_MIN = 30;

interface BroadcastSettings {
  ratePerMin: number;
  templateName: string;
  languageCode: string;
}

/** Read settings.broadcast for a tenant (rate limit + default template). */
export function parseBroadcastSettings(settings: unknown): BroadcastSettings {
  const b = (((settings as Record<string, unknown> | null)?.broadcast ?? {}) as Record<string, unknown>);
  return {
    ratePerMin:
      typeof b.ratePerMin === "number" && Number.isFinite(b.ratePerMin) && b.ratePerMin > 0
        ? Math.floor(b.ratePerMin)
        : DEFAULT_BROADCAST_RATE_PER_MIN,
    templateName: typeof b.templateName === "string" && b.templateName ? b.templateName : "wac_broadcast",
    languageCode: typeof b.languageCode === "string" && b.languageCode ? b.languageCode : "en_US",
  };
}

/**
 * Phones (digits-only) with a GRANTED whatsapp consent row for this tenant.
 * Defensive: the consents table is owned by the compliance module — a missing
 * table/row means NOT consented, so any query error yields an empty set.
 */
export async function getConsentedPhones(db: Db, tenantId: string): Promise<Set<string>> {
  try {
    const res: any = await db.execute(
      sql`SELECT phone FROM consents WHERE tenant_id = ${tenantId} AND channel = 'whatsapp' AND granted = true`,
    );
    const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
    return new Set(
      rows
        .map((r) => normalizeWaPhone(String(r?.phone ?? "")))
        .filter((p) => p.length > 0),
    );
  } catch (e: any) {
    console.warn("[broadcast] consent lookup failed (treating all as NOT consented):", e?.message);
    return new Set();
  }
}

/**
 * Latest inbound WhatsApp reply per phone (digits-only) for 24h-window
 * detection — delegated to the session-window service (same durable source:
 * whatsapp_customer_replies).
 */
export async function getLastInboundMap(db: Db, tenantId: string): Promise<Map<string, Date>> {
  return getSessionWindowLastInboundMap(db, tenantId);
}

export interface BroadcastAudienceMember {
  customerId: string;
  phone: string;
  name: string | null;
  /** True when the customer's last inbound message is inside the 24h window. */
  inWindow: boolean;
}

// ── Segmented broadcasts ─────────────────────────────────────────────────────
/** Structured audience filter stored on campaigns (segmentFilter jsonb). */
export interface SegmentFilter {
  /** Customer must carry at least ONE of these tags. */
  tags?: string[];
  minOrders?: number;
  /** Minimum lifetime spend in integer minor units (kobo/cents). */
  minSpendKobo?: number;
  lastOrderWithinDays?: number;
}

export const segmentFilterSchema = z.object({
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  minOrders: z.number().int().min(0).optional(),
  minSpendKobo: z.number().int().min(0).optional(),
  lastOrderWithinDays: z.number().int().min(1).max(3650).optional(),
});

interface SegmentCustomerRow {
  id: string;
  whatsappPhone: string;
  name: string | null;
  tags: unknown;
  totalOrders: number;
  totalSpent: string;
  lastOrderAt: Date | null;
}

/** Pure segment matcher — exported for tests. Spend math in minor units. */
export function matchesSegment(
  c: SegmentCustomerRow,
  segment: SegmentFilter,
  now: Date = new Date(),
): boolean {
  if (segment.tags && segment.tags.length > 0) {
    const owned = new Set(
      (Array.isArray(c.tags) ? (c.tags as unknown[]) : [])
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.toLowerCase()),
    );
    if (!segment.tags.some((t) => owned.has(t.toLowerCase()))) return false;
  }
  if (segment.minOrders != null && (c.totalOrders ?? 0) < segment.minOrders) return false;
  if (segment.minSpendKobo != null) {
    let spentMinor = 0;
    try {
      spentMinor = toMinorUnitsExact(c.totalSpent ?? "0");
    } catch {
      spentMinor = 0;
    }
    if (spentMinor < segment.minSpendKobo) return false;
  }
  if (segment.lastOrderWithinDays != null) {
    if (!c.lastOrderAt) return false;
    const cutoff = now.getTime() - segment.lastOrderWithinDays * 24 * 60 * 60 * 1000;
    if (new Date(c.lastOrderAt).getTime() < cutoff) return false;
  }
  return true;
}

/** Normalize an unknown segmentFilter jsonb value into a SegmentFilter. */
export function normalizeSegmentFilter(raw: unknown): SegmentFilter | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const parsed = segmentFilterSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const s = parsed.data;
  if (!s.tags?.length && s.minOrders == null && s.minSpendKobo == null && s.lastOrderWithinDays == null) {
    return undefined;
  }
  return s;
}

/**
 * Real broadcast audience: the tenant's customers that have GRANTED whatsapp
 * consent AND match the campaign's segment filter (when any). Non-consented
 * customers are always excluded.
 */
export async function buildBroadcastAudience(db: Db, tenantId: string, segment?: SegmentFilter): Promise<BroadcastAudienceMember[]> {
  const custs = await db
    .select({
      id: customers.id,
      whatsappPhone: customers.whatsappPhone,
      name: customers.name,
      tags: customers.tags,
      totalOrders: customers.totalOrders,
      totalSpent: customers.totalSpent,
      lastOrderAt: customers.lastOrderAt,
    })
    .from(customers)
    .where(eq(customers.tenantId, tenantId));
  const consented = await getConsentedPhones(db, tenantId);
  if (consented.size === 0) return [];
  const lastInbound = await getLastInboundMap(db, tenantId);
  const now = Date.now();
  return custs
    .filter((c) => !segment || matchesSegment(c, segment))
    .filter((c) => consented.has(normalizeWaPhone(c.whatsappPhone)))
    .map((c) => {
      const last = lastInbound.get(normalizeWaPhone(c.whatsappPhone));
      return {
        customerId: c.id,
        phone: c.whatsappPhone,
        name: c.name,
        inWindow: Boolean(last && now - last.getTime() < WA_WINDOW_MS),
      };
    });
}

/** Substitute {{var}} placeholders in a template body. */
export function substituteVars(body: string, vars: Record<string, string>): string {
  let out = body;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v));
  }
  return out;
}

/**
 * Per-tenant broadcast rate limit: at most `ratePerMin` broadcast sends
 * started per minute (fixed window, Redis-backed). Fails closed in
 * production when Redis is down; fails open with a warning in dev/test.
 */
export async function checkBroadcastRateLimit(tenantId: string, ratePerMin: number): Promise<void> {
  const minuteWindow = Math.floor(Date.now() / 60_000);
  const key = `broadcast:send:${tenantId}:${minuteWindow}`;
  let count: number;
  try {
    count = await redisIncrExStrict(key, 60);
  } catch (err: any) {
    if (err instanceof RateLimitUnavailableError) {
      if (ENV.isProd) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Broadcast rate limiter unavailable — try again shortly",
        });
      }
      console.warn("[broadcast] rate limiter unavailable — allowing (dev fail-open):", err?.message);
      return;
    }
    throw err;
  }
  if (count > ratePerMin) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Broadcast rate limit exceeded (${ratePerMin}/min for this tenant) — try again in the next minute`,
    });
  }
}

export interface CampaignSendResult {
  total: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  simulated: number;
}

type CampaignRow = typeof broadcastCampaigns.$inferSelect;

/**
 * The real campaign send loop: per-recipient rows + chunked sends with
 * in-window free-form text vs approved-template routing. Shared by
 * broadcast.send (immediate) and the scheduled-broadcast cron dispatcher.
 */
export async function executeCampaignSend(
  db: Db,
  campaign: CampaignRow,
  bcfg: BroadcastSettings,
  audience: BroadcastAudienceMember[],
): Promise<CampaignSendResult> {
  // Campaign-level variable mapping merged into per-recipient variables.
  const campaignVarMap = (campaign.varMapping ?? {}) as Record<string, string>;
  // Internal directives (e.g. __templateName) never reach template params.
  const publicVarMap = Object.fromEntries(
    Object.entries(campaignVarMap).filter(([k]) => !k.startsWith("__")),
  );

  // Campaign template body drives the in-window free-form text.
  let templateBody: string | null = null;
  let templateName = bcfg.templateName;
  let languageCode = bcfg.languageCode;
  if (campaign.templateId) {
    const [tpl] = await db
      .select()
      .from(whatsappTemplates)
      .where(eq(whatsappTemplates.id, campaign.templateId))
      .limit(1);
    if (tpl) {
      templateBody = tpl.bodyText ?? null;
      if (tpl.name) templateName = tpl.name;
      if (tpl.language) languageCode = tpl.language;
    }
  }
  // Free-form per-campaign template override (broadcast.create templateName,
  // e.g. an APPROVED Meta template picked in the UI) beats the tenant default.
  if (typeof campaignVarMap.__templateName === "string" && campaignVarMap.__templateName.trim()) {
    templateName = campaignVarMap.__templateName.trim();
  }

  await db
    .update(broadcastCampaigns)
    .set({
      status: "sending",
      totalRecipients: audience.length,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(broadcastCampaigns.id, campaign.id));

  let sent = 0;
  let failed = 0;
  let simulatedCount = 0;
  const CHUNK_SIZE = 25;
  for (let i = 0; i < audience.length; i += CHUNK_SIZE) {
    const chunk = audience.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (member) => {
        const recipientId = nanoid();
        const variables = {
          customer_name: member.name ?? "Customer",
          ...publicVarMap,
        };
        await db
          .insert(broadcastRecipients)
          .values({
            id: recipientId,
            campaignId: campaign.id,
            phone: member.phone,
            name: member.name ?? null,
            variables,
            status: "pending",
            createdAt: new Date(),
          })
          .onConflictDoNothing();
        try {
          let wamid: string | null = null;
          let simulated = false;
          if (member.inWindow && templateBody) {
            const res = await sendWhatsAppText(
              campaign.tenantId,
              member.phone,
              substituteVars(templateBody, variables),
              { notifType: "broadcast" },
            );
            wamid = res.wamids[0] ?? null;
            simulated = res.simulated;
          } else {
            // Outside the 24h window (or no text body) — approved template required.
            const components = [
              {
                type: "body",
                parameters: [
                  { type: "text", text: member.name ?? "Customer" },
                  ...Object.values(publicVarMap).map((v) => ({ type: "text", text: String(v) })),
                ],
              },
            ];
            const res = await sendWhatsAppTemplate(
              campaign.tenantId,
              member.phone,
              templateName,
              languageCode,
              components,
              { notifType: "broadcast" },
            );
            wamid = res.wamid;
            simulated = res.simulated;
          }
          if (simulated) {
            // No WhatsApp credentials configured — not a real delivery.
            simulatedCount++;
            await db
              .update(broadcastRecipients)
              .set({
                status: "failed",
                failedAt: new Date(),
                failureReason: "WhatsApp credentials not configured for tenant — send simulated",
              })
              .where(eq(broadcastRecipients.id, recipientId));
            return;
          }
          sent++;
          await db
            .update(broadcastRecipients)
            .set({ status: "sent", sentAt: new Date(), messageId: wamid })
            .where(eq(broadcastRecipients.id, recipientId));
        } catch (err: any) {
          failed++;
          await db
            .update(broadcastRecipients)
            .set({
              status: "failed",
              failedAt: new Date(),
              failureReason: String(err?.message ?? err).slice(0, 500),
            })
            .where(eq(broadcastRecipients.id, recipientId));
        }
      }),
    );
  }

  await db
    .update(broadcastCampaigns)
    .set({
      status: "completed",
      totalRecipients: audience.length,
      sentCount: sent,
      deliveredCount: 0,
      readCount: 0,
      failedCount: failed,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(broadcastCampaigns.id, campaign.id));

  return { total: audience.length, sent, delivered: 0, read: 0, failed, simulated: simulatedCount };
}

/**
 * Full dispatch of one campaign (audience build + send). Used by the
 * /api/scheduled/broadcast-dispatch cron endpoint for due campaigns.
 */
export async function dispatchCampaign(db: Db, campaign: CampaignRow): Promise<CampaignSendResult> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, campaign.tenantId))
    .limit(1);
  const bcfg = parseBroadcastSettings(tenant?.settings);
  // Messaging-quality throttle: LOW rating blocks the dispatch (the cron
  // caller marks the campaign failed), MEDIUM halves the rate.
  const throttle = applyQualityThrottle(tenant?.settings, bcfg.ratePerMin);
  if (throttle.blocked) throw new TRPCError({ code: "PRECONDITION_FAILED", message: throttle.reason });
  bcfg.ratePerMin = throttle.ratePerMin;
  const segment = normalizeSegmentFilter(campaign.segmentFilter);
  const audience = await buildBroadcastAudience(db, campaign.tenantId, segment);
  return executeCampaignSend(db, campaign, bcfg, audience);
}

export const broadcastRouter = router({
  // List all campaigns
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      status: z.enum(["draft", "scheduled", "sending", "completed", "cancelled", "failed"]).optional(),
      limit: z.number().default(20),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { campaigns: [], total: 0 };

      const rows = await db
        .select()
        .from(broadcastCampaigns)
        .orderBy(desc(broadcastCampaigns.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      return { campaigns: rows, total: rows.length };
    }),

  // Get a single campaign with recipient stats
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const [campaign] = await db
        .select()
        .from(broadcastCampaigns)
        .where(eq(broadcastCampaigns.id, input.id))
        .limit(1);
      if (!campaign) return null;

      const recipients = await db
        .select()
        .from(broadcastRecipients)
        .where(eq(broadcastRecipients.campaignId, input.id))
        .orderBy(desc(broadcastRecipients.createdAt))
        .limit(50);

      return { campaign, recipients };
    }),

  // Create a new campaign
  create: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      name: z.string().min(1),
      templateId: z.string().optional(),
      segment: z.enum(["all", "new_contacts", "recent_orders", "overdue_invoices", "shipped_orders", "vip_customers", "custom"]).default("all"),
      segmentFilter: z.record(z.string(), z.unknown()).optional(),
      scheduledAt: z.number().optional(),
      varMapping: z.record(z.string(), z.string()).optional(),
      /**
       * Free-form out-of-window template override (typically an APPROVED
       * Meta template name picked in the UI). Persisted as the internal
       * varMapping.__templateName directive consumed by executeCampaignSend.
       */
      templateName: z.string().trim().min(1).max(255).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const id = nanoid();
      const varMapping = { ...(input.varMapping ?? {}) };
      if (input.templateName) varMapping.__templateName = input.templateName;
      await db.insert(broadcastCampaigns).values({
        id,
        tenantId: input.tenantId,
        name: input.name,
        templateId: input.templateId ?? null,
        segment: input.segment,
        segmentFilter: input.segmentFilter ?? null,
        varMapping: Object.keys(varMapping).length > 0 ? varMapping : null,
        status: "draft",
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        createdBy: ctx.user?.name ?? ctx.user?.openId ?? "system",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return { id };
    }),

  /**
   * Send a campaign for real: consent-gated audience (customers of the tenant
   * with a granted whatsapp consent), per-tenant rate limit, chunked sends
   * with per-recipient status rows. Recipients inside the 24h WhatsApp window
   * get free-form text (when the campaign has a template body); everyone else
   * gets the tenant-configured approved template.
   *
   * dryRun=true returns the audience count + sample without sending anything.
   * scheduleAt (epoch ms, future) parks the campaign as status='scheduled'
   * for the /api/scheduled/broadcast-dispatch cron instead of sending now.
   * segment overrides the campaign's segmentFilter audience filter.
   */
  send: protectedProcedure
    .input(z.object({
      campaignId: z.string(),
      dryRun: z.boolean().optional().default(false),
      scheduleAt: z.number().optional(),
      segment: segmentFilterSchema.optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [campaignRow] = await db
        .select()
        .from(broadcastCampaigns)
        .where(eq(broadcastCampaigns.id, input.campaignId))
        .limit(1);

      if (!campaignRow) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      const campaign = campaignRow;

      // Tenant isolation: only the owning tenant (or an admin) may send.
      assertTenantAccess(ctx.user, campaign.tenantId);

      // Segment override: persist on the campaign so the scheduled dispatch
      // and later dry-runs see the same audience definition.
      if (input.segment) {
        await db
          .update(broadcastCampaigns)
          .set({ segmentFilter: input.segment, updatedAt: new Date() })
          .where(eq(broadcastCampaigns.id, input.campaignId));
        campaign.segmentFilter = input.segment;
      }

      // Schedule for later: the cron dispatcher picks it up when due.
      if (!input.dryRun && input.scheduleAt && input.scheduleAt > Date.now()) {
        const when = new Date(input.scheduleAt);
        await db
          .update(broadcastCampaigns)
          .set({ status: "scheduled", scheduledAt: when, updatedAt: new Date() })
          .where(eq(broadcastCampaigns.id, input.campaignId));
        return {
          dryRun: false as const,
          scheduled: true as const,
          scheduledAt: when.toISOString(),
          total: 0,
          sent: 0,
          delivered: 0,
          read: 0,
          failed: 0,
        };
      }

      const [tenant] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, campaign.tenantId))
        .limit(1);
      const bcfg = parseBroadcastSettings(tenant?.settings);

      // Messaging-quality throttle (settings.waQuality): LOW blocks the send,
      // MEDIUM halves the rate. Applies to both immediate and dryRun paths.
      const throttle = applyQualityThrottle(tenant?.settings, bcfg.ratePerMin);
      if (throttle.blocked && !input.dryRun) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: throttle.reason });
      }
      bcfg.ratePerMin = throttle.ratePerMin;

      const segment = normalizeSegmentFilter(campaign.segmentFilter);
      const audience = await buildBroadcastAudience(db, campaign.tenantId, segment);
      const inWindowCount = audience.filter((a) => a.inWindow).length;

      if (input.dryRun) {
        return {
          dryRun: true as const,
          total: audience.length,
          audienceCount: audience.length,
          inWindowCount,
          outOfWindowCount: audience.length - inWindowCount,
          segment: segment ?? null,
          sample: audience.slice(0, 5).map((a) => ({
            phone: a.phone,
            name: a.name,
            inWindow: a.inWindow,
          })),
          sent: 0,
          delivered: 0,
          read: 0,
          failed: 0,
        };
      }

      // Per-tenant throughput guard (settings.broadcast.ratePerMin, default 30/min).
      await checkBroadcastRateLimit(campaign.tenantId, bcfg.ratePerMin);

      const result = await executeCampaignSend(db, campaign, bcfg, audience);
      return { dryRun: false as const, ...result };
    }),


  // Cancel a campaign
  cancel: protectedProcedure
    .input(z.object({ campaignId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db
        .update(broadcastCampaigns)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(broadcastCampaigns.id, input.campaignId));
      return { success: true };
    }),

  // Get delivery stats summary
  stats: protectedProcedure
    .query(async () => {
      const db = await getDb();
      if (!db) return { totalCampaigns: 0, totalSent: 0, avgDeliveryRate: 0, avgReadRate: 0 };

      const campaigns = await db.select().from(broadcastCampaigns);
      const completed = campaigns.filter(c => c.status === "completed");

      const totalSent = completed.reduce((s, c) => s + c.sentCount, 0);
      const totalDelivered = completed.reduce((s, c) => s + c.deliveredCount, 0);
      const totalRead = completed.reduce((s, c) => s + c.readCount, 0);

      return {
        totalCampaigns: campaigns.length,
        totalSent,
        avgDeliveryRate: totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0,
        avgReadRate: totalDelivered > 0 ? Math.round((totalRead / totalDelivered) * 100) : 0,
      };
    }),

  // Preview variable substitution for a recipient
  preview: protectedProcedure
    .input(z.object({
      templateBody: z.string(),
      variables: z.record(z.string(), z.string()),
    }))
    .mutation(({ input }) => {
      let preview = input.templateBody;
      for (const [key, value] of Object.entries(input.variables)) {
        preview = preview.replaceAll(`{{${key}}}`, String(value));
      }
      return { preview };
    }),
  // Simulate delivery/read events on a sent campaign
  simulateDelivery: protectedProcedure
    .input(z.object({ campaignId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [campaign] = await db.select().from(broadcastCampaigns)
        .where(eq(broadcastCampaigns.id, input.campaignId)).limit(1);
      if (!campaign) throw new Error("Campaign not found");
      if (campaign.status !== "completed") throw new Error("Campaign must be completed before simulating delivery");
      const recipients = await db.select().from(broadcastRecipients)
        .where(eq(broadcastRecipients.campaignId, input.campaignId));
      let delivered = 0;
      let read = 0;
      for (const r of recipients) {
        const willDeliver = Math.random() > 0.1;
        const willRead = willDeliver && Math.random() > 0.35;
        const newStatus = willRead ? "read" : willDeliver ? "delivered" : r.status;
        if (willDeliver || willRead) {
          await db.update(broadcastRecipients).set({
            status: newStatus as any,
            deliveredAt: willDeliver ? new Date() : r.deliveredAt,
          }).where(eq(broadcastRecipients.id, r.id));
          if (willDeliver) delivered++;
          if (willRead) read++;
        }
      }
      await db.update(broadcastCampaigns).set({
        deliveredCount: delivered,
        readCount: read,
        updatedAt: new Date(),
      }).where(eq(broadcastCampaigns.id, input.campaignId));
      return { delivered, read, total: recipients.length };
    }),
});
