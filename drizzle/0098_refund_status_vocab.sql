-- W30 hotfix (verify-v1 #9): honest refund vocabulary on orders.paymentStatus.
-- "refunded" is reserved for provider-confirmed execution; a queued provider
-- refund is "refund_initiated"; an internal-ledger-only refund (PSP money not
-- yet returned to the buyer) is "refund_recorded".
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'refund_initiated';
--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'refund_recorded';
--> statement-breakpoint
