ALTER TABLE "users" ADD COLUMN "whatsappNotifOrders" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "whatsappNotifStatus" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "whatsappNotifMarketing" boolean DEFAULT false NOT NULL;