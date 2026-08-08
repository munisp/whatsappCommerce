import { z } from "zod";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  customers,
  erasureRequests,
  escrowTransactions,
  merchantWallets,
  orders,
  users,
  walletTransactions,
} from "../../drizzle/schema";
import { writeAuditLog } from "./audit";

// Terminal escrow states — anything else is "open" and blocks erasure.
const TERMINAL_ESCROW_STATES = ["settled", "refunded", "expired"] as const;

/**
 * Find the caller's customer profiles (customers are keyed by WhatsApp phone,
 * which mirrors users.phone for WhatsApp-native signups).
 */
async function findCustomerProfileIds(db: any, phone: string | null): Promise<string[]> {
  if (!phone) return [];
  const rows = await db.select({ id: customers.id }).from(customers)
    .where(eq(customers.whatsappPhone, phone));
  return rows.map((r: { id: string }) => r.id);
}

export const privacyRouter = router({
  /**
   * NDPR/GDPR data-portability export: everything we hold about the caller,
   * serialized as a single JSON document.
   */
  exportMyData: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
    const userId = ctx.user.id;

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

    const profileIds = await findCustomerProfileIds(db, user.phone);

    const myOrders = profileIds.length
      ? await db.select().from(orders).where(inArray(orders.customerId, profileIds))
      : [];

    const myEscrows = profileIds.length
      ? await db.select().from(escrowTransactions).where(inArray(escrowTransactions.customerId, profileIds))
      : [];

    // Merchant-side data: the caller's tenant wallet + ledger (if they operate one).
    let wallet: unknown = null;
    let walletTxs: unknown[] = [];
    if (user.tenantId) {
      const [w] = await db.select().from(merchantWallets)
        .where(eq(merchantWallets.tenantId, user.tenantId)).limit(1);
      if (w) {
        wallet = w;
        walletTxs = await db.select().from(walletTransactions)
          .where(eq(walletTransactions.walletId, w.id))
          .orderBy(desc(walletTransactions.createdAt));
      }
    }

    return {
      exportedAt: new Date().toISOString(),
      regulation: "NDPR/GDPR — data subject portability",
      user,
      customerProfiles: profileIds,
      orders: myOrders,
      escrowTransactions: myEscrows,
      merchantWallet: wallet,
      walletTransactions: walletTxs,
    };
  }),

  /**
   * NDPR/GDPR right-to-erasure. Anonymizes PII on the user + customer profiles
   * (email/phone/name nulled) while keeping financial rows (orders, escrows,
   * wallet ledger) for regulatory retention. Honestly blocked while the user
   * has open escrows or pending withdrawals.
   */
  requestErasure: protectedProcedure
    .input(z.object({ reason: z.string().max(1000).optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const userId = ctx.user.id;

      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

      const profileIds = await findCustomerProfileIds(db, user.phone);

      // Guard 1: open escrows — funds are in flight, erasure must wait.
      if (profileIds.length) {
        const openEscrows = await db.select({ id: escrowTransactions.id })
          .from(escrowTransactions)
          .where(and(
            inArray(escrowTransactions.customerId, profileIds),
            notInArray(escrowTransactions.state, [...TERMINAL_ESCROW_STATES]),
          ))
          .limit(1);
        if (openEscrows.length) {
          const [req] = await db.insert(erasureRequests).values({
            userId, status: "rejected", reason: input.reason ?? null,
            blockedReason: "open_escrows", processedAt: new Date(),
          }).returning();
          return { status: "blocked" as const, reason: "open_escrows", requestId: req.id };
        }
      }

      // Guard 2: pending withdrawals on the caller's merchant wallet.
      if (user.tenantId) {
        const pending = await db.execute(sql`
          SELECT wt.id FROM wallet_transactions wt
          JOIN merchant_wallets mw ON mw.id = wt.wallet_id
          WHERE mw.tenant_id = ${user.tenantId}
            AND wt.type = 'withdrawal'
            AND wt.metadata->>'status' = 'pending'
          LIMIT 1
        `);
        if ((pending as unknown as unknown[]).length) {
          const [req] = await db.insert(erasureRequests).values({
            userId, status: "rejected", reason: input.reason ?? null,
            blockedReason: "pending_withdrawals", processedAt: new Date(),
          }).returning();
          return { status: "blocked" as const, reason: "pending_withdrawals", requestId: req.id };
        }
      }

      // Anonymize PII. Financial rows (orders/escrows/wallet ledger) are kept
      // for AML/tax retention — only direct identifiers are erased.
      const tombstone = `erased-${userId}@anonymized.local`;
      await db.update(users).set({
        name: null,
        email: null,
        phone: null,
        updatedAt: new Date(),
      }).where(eq(users.id, userId));

      if (profileIds.length) {
        await db.update(customers).set({
          name: null,
          email: null,
          whatsappPhone: tombstone,
          updatedAt: new Date(),
        }).where(inArray(customers.id, profileIds));
      }

      const [req] = await db.insert(erasureRequests).values({
        userId, status: "completed", reason: input.reason ?? null, processedAt: new Date(),
      }).returning();

      await writeAuditLog({
        actorId: String(userId),
        actorRole: ctx.user.role,
        action: "privacy.erasure",
        entityType: "user",
        entityId: String(userId),
        tenantId: user.tenantId ?? null,
        summary: `PII anonymized for user ${userId}; ${profileIds.length} customer profile(s) tombstoned; financial rows retained`,
        after: { erasureRequestId: req.id },
      });

      return { status: "completed" as const, requestId: req.id, anonymizedProfiles: profileIds.length };
    }),

  /** Admin: list all erasure requests (DPO oversight). */
  listErasureRequests: adminProcedure
    .input(z.object({
      status: z.enum(["pending", "completed", "rejected"]).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = input.status ? eq(erasureRequests.status, input.status) : undefined;
      return db.select().from(erasureRequests)
        .where(conds)
        .orderBy(desc(erasureRequests.requestedAt))
        .limit(input.limit);
    }),
});
