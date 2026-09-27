-- === W54 disputes === DISP-3/DISP-7 (additive-only):
--  1. dispute_resolution enum gains 'replacement' (money-untouched path that
--     opens a linked RMA instead of moving escrow funds).
--  2. escrow_disputes.metadata  — merchant response bookkeeping (DISP-3:
--     respondedAt / note / evidence token) + replacement RMA link (DISP-7).
--  3. rma_requests.metadata     — reverse link { disputeId } for replacement
--     RMAs created from a dispute resolution.
ALTER TYPE "public"."dispute_resolution" ADD VALUE 'replacement';--> statement-breakpoint
ALTER TABLE "escrow_disputes" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "rma_requests" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
