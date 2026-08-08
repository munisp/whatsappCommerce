/**
 * disputes.ts — Shared dispute-raising logic.
 *
 * The escrow dispute router (server/routers/escrow.ts → escrowDisputeRouter.raise)
 * and the WhatsApp chat dispute self-service (services/chatDispute.ts) BOTH go
 * through raiseEscrowDispute so the validation lives in exactly one place:
 *
 *  - the escrow must exist and belong to the claimed order/tenant
 *  - disputes can only freeze ACTIVE escrows (payment_received / escrow_held /
 *    delivery_confirmed) via a single guarded state transition
 *  - the dispute row is inserted with status "open" + merchant response
 *    deadline from the escrow config, and the merchant is notified
 */

import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { escrowConfig, escrowDisputes, escrowTransactions } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const DISPUTE_REASONS = ["not_received", "wrong_item", "damaged", "partial_delivery", "other"] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

/** Escrow states that can still be frozen by a dispute. */
export const DISPUTABLE_ESCROW_STATES = ["payment_received", "escrow_held", "delivery_confirmed"] as const;

export async function getDisputeConfig(db: Db) {
  const [cfg] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
  if (cfg) return cfg;
  await db.insert(escrowConfig).values({
    id: 1,
    custodyMode: "pssp",
    platformFeeRate: "0.03125",
    buyerConfirmWindowHours: 24,
    disputeWindowHours: 48,
    autoConfirmEnabled: true,
    floatYieldRate: "0.08",
    updatedAt: new Date(),
  }).onConflictDoNothing();
  const [seeded] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
  return seeded!;
}

export interface RaiseDisputeInput {
  escrowTxId: string;
  orderId: string;
  tenantId: string;
  raisedBy: "buyer" | "merchant";
  reason: DisputeReason;
  description?: string;
}

/**
 * Validate + freeze the escrow + insert the dispute row + notify the merchant.
 * Throws TRPCError on validation failures (same codes the router used).
 */
export async function raiseEscrowDispute(db: Db, input: RaiseDisputeInput) {
  const cfg = await getDisputeConfig(db);

  // Validate the escrow matches the claimed order/tenant (read-only check
  // for input sanity; the transition below is still atomic).
  const [escrow] = await db.select().from(escrowTransactions)
    .where(eq(escrowTransactions.id, input.escrowTxId));
  if (!escrow) throw new TRPCError({ code: "NOT_FOUND", message: "Escrow not found" });
  if (escrow.orderId !== input.orderId || escrow.tenantId !== input.tenantId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Escrow does not match the given order/tenant" });
  }

  // Freeze the escrow via a single guarded transition — disputes can only
  // be raised on ACTIVE escrows. Settled / refunded / release_instructed
  // escrows are terminal for disputes (prevents refund-after-settle).
  const transitioned = await db.update(escrowTransactions).set({
    state: "dispute_raised",
    updatedAt: new Date(),
  }).where(and(
    eq(escrowTransactions.id, input.escrowTxId),
    inArray(escrowTransactions.state, [...DISPUTABLE_ESCROW_STATES] as any),
  )).returning();
  if (transitioned.length !== 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Cannot raise a dispute on an escrow in state: ${escrow.state}`,
    });
  }

  const id = crypto.randomUUID();
  const merchantDeadline = new Date(Date.now() + cfg.disputeWindowHours * 3600 * 1000);
  await db.insert(escrowDisputes).values({
    id,
    escrowTxId: input.escrowTxId,
    orderId: input.orderId,
    tenantId: input.tenantId,
    raisedBy: input.raisedBy,
    reason: input.reason,
    description: input.description,
    status: "open",
    merchantResponseDeadline: merchantDeadline,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const [created] = await db.select().from(escrowDisputes).where(eq(escrowDisputes.id, id));
  // Fire-and-forget: notify merchant of dispute
  const { emitNotification } = await import("../routers/notifications");
  emitNotification({
    id: crypto.randomUUID(), tenantId: input.tenantId, type: "dispute_opened",
    title: "Dispute Opened on Your Order",
    body: `A ${input.raisedBy} has raised a dispute on order ${input.orderId}. Reason: ${input.reason.replace(/_/g, " ")}. Please respond within ${cfg.disputeWindowHours}h.`,
    metadata: { orderId: input.orderId, escrowTxId: input.escrowTxId, disputeId: id },
    read: false, readAt: null, createdAt: new Date(),
  }).catch(() => {});
  return created!;
}
