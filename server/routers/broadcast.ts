import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, desc, and, sql } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  broadcastCampaigns,
  broadcastRecipients,
  whatsappTemplates,
  twentyContacts,
} from "../../drizzle/schema";

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

      // Seed demo campaigns if empty
      if (rows.length === 0) {
        const demos = [
          { id: nanoid(), tenantId: "demo-tenant-1", name: "July Flash Sale", segment: "all", status: "completed" as const, totalRecipients: 1240, sentCount: 1240, deliveredCount: 1198, readCount: 876, failedCount: 42 },
          { id: nanoid(), tenantId: "demo-tenant-2", name: "Order Confirmation Blast", segment: "recent_orders", status: "completed" as const, totalRecipients: 345, sentCount: 345, deliveredCount: 340, readCount: 312, failedCount: 5 },
          { id: nanoid(), tenantId: "demo-tenant-1", name: "Payment Reminder — Overdue", segment: "overdue_invoices", status: "sending" as const, totalRecipients: 88, sentCount: 62, deliveredCount: 58, readCount: 44, failedCount: 4 },
          { id: nanoid(), tenantId: "demo-tenant-3", name: "Welcome New Customers", segment: "new_contacts", status: "draft" as const, totalRecipients: 0, sentCount: 0, deliveredCount: 0, readCount: 0, failedCount: 0 },
          { id: nanoid(), tenantId: "demo-tenant-2", name: "Shipping Update Notification", segment: "shipped_orders", status: "scheduled" as const, totalRecipients: 156, sentCount: 0, deliveredCount: 0, readCount: 0, failedCount: 0 },
        ];
        for (const d of demos) {
          await db.insert(broadcastCampaigns).values({
            ...d,
            createdAt: new Date(),
            updatedAt: new Date(),
          }).onConflictDoNothing();
        }
        return { campaigns: demos, total: demos.length };
      }

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
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const id = nanoid();
      await db.insert(broadcastCampaigns).values({
        id,
        tenantId: input.tenantId,
        name: input.name,
        templateId: input.templateId ?? null,
        segment: input.segment,
        segmentFilter: input.segmentFilter ?? null,
        varMapping: input.varMapping ?? null,
        status: "draft",
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        createdBy: ctx.user?.name ?? ctx.user?.openId ?? "system",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return { id };
    }),

  // Simulate sending a campaign (builds recipient list from Twenty contacts)
  send: protectedProcedure
    .input(z.object({ campaignId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const [campaign] = await db
        .select()
        .from(broadcastCampaigns)
        .where(eq(broadcastCampaigns.id, input.campaignId))
        .limit(1);

      if (!campaign) throw new Error("Campaign not found");

      // Merge campaign-level varMapping into per-recipient variables
      const campaignVarMap = (campaign.varMapping ?? {}) as Record<string, string>;

      // Pull contacts from Twenty CRM as recipients
      const contacts = await db
        .select()
        .from(twentyContacts)
        .limit(200);

      // Build recipient rows with variable substitution
      const recipientRows = contacts
        .filter(c => c.phone)
        .map(c => ({
          id: nanoid(),
          campaignId: input.campaignId,
          phone: c.phone!,
          name: c.name ?? null,
          variables: {
            customer_name: c.name ?? "Customer",
            store_name: "WhatsApp Commerce",
            order_number: `ORD-${Math.floor(Math.random() * 90000) + 10000}`,
            amount: `$${(Math.random() * 200 + 20).toFixed(2)}`,
            currency: "USD",
            ...campaignVarMap,
          },
          status: "pending" as const,
          createdAt: new Date(),
        }));

      // If no real contacts, generate demo recipients
      const finalRecipients = recipientRows.length > 0 ? recipientRows : Array.from({ length: 12 }, (_, i) => ({
        id: nanoid(),
        campaignId: input.campaignId,
        phone: `+1555${String(i).padStart(7, "0")}`,
        name: ["Alice Johnson", "Bob Smith", "Carol White", "David Brown", "Emma Davis", "Frank Miller", "Grace Wilson", "Henry Moore", "Iris Taylor", "Jack Anderson", "Karen Thomas", "Leo Jackson"][i] ?? `Customer ${i + 1}`,
          variables: {
            customer_name: ["Alice", "Bob", "Carol", "David", "Emma", "Frank", "Grace", "Henry", "Iris", "Jack", "Karen", "Leo"][i] ?? "Customer",
            store_name: "WhatsApp Commerce",
            order_number: `ORD-${10000 + i}`,
            amount: `$${(50 + i * 15).toFixed(2)}`,
            currency: "USD",
            ...campaignVarMap,
          },
        status: "pending" as const,
        createdAt: new Date(),
      }));

      // Insert recipients
      for (const r of finalRecipients) {
        await db.insert(broadcastRecipients).values(r).onConflictDoNothing();
      }

      // Simulate delivery: mark some as sent/delivered/read
      const total = finalRecipients.length;
      const sent = total;
      const delivered = Math.floor(total * 0.96);
      const read = Math.floor(total * 0.72);
      const failed = total - delivered;

      await db
        .update(broadcastCampaigns)
        .set({
          status: "completed",
          totalRecipients: total,
          sentCount: sent,
          deliveredCount: delivered,
          readCount: read,
          failedCount: failed,
          startedAt: new Date(),
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(broadcastCampaigns.id, input.campaignId));

      return { total, sent, delivered, read, failed };
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
