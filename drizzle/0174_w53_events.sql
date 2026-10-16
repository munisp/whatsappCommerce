-- === W53 EVENTS (ticketing): events + event_ticket_types + event_tickets.
-- Additive-only; IF NOT EXISTS for idempotent re-application. ===
CREATE TABLE IF NOT EXISTS "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"venue" varchar(300),
	"venueCoords" jsonb,
	"imageUrl" text,
	"startsAt" timestamp NOT NULL,
	"endsAt" timestamp,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"capacity" integer,
	"metadata" jsonb,
	"createdBy" varchar(64),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_tenant_idx" ON "events" ("tenantId", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_tenant_status_idx" ON "events" ("tenantId", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_ticket_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"eventId" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"priceCents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"quantity" integer NOT NULL,
	"soldCount" integer DEFAULT 0 NOT NULL,
	"maxPerOrder" integer DEFAULT 10 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_ticket_types_event_idx" ON "event_ticket_types" ("eventId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_ticket_types_tenant_idx" ON "event_ticket_types" ("tenantId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"eventId" uuid NOT NULL,
	"ticketTypeId" uuid NOT NULL,
	"orderId" varchar(36),
	"buyerCustomerId" varchar(64) NOT NULL,
	"code" varchar(24) NOT NULL,
	"status" varchar(16) DEFAULT 'issued' NOT NULL,
	"checkedInAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_tickets_tenant_code_uq" ON "event_tickets" ("tenantId", "code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_tickets_event_idx" ON "event_tickets" ("eventId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_tickets_order_idx" ON "event_tickets" ("orderId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_tickets_buyer_idx" ON "event_tickets" ("tenantId", "buyerCustomerId");
