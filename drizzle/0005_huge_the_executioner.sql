CREATE TYPE "public"."timeline_attachment_type" AS ENUM('document', 'note');--> statement-breakpoint
CREATE TABLE "escrow_timeline_attachments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"escrow_id" varchar(36) NOT NULL,
	"event_id" varchar(128) NOT NULL,
	"attachment_type" timeline_attachment_type DEFAULT 'document' NOT NULL,
	"file_url" text,
	"file_key" text,
	"filename" varchar(255),
	"mime_type" varchar(128),
	"note" text,
	"uploaded_by" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "eta_escrow_idx" ON "escrow_timeline_attachments" USING btree ("escrow_id");--> statement-breakpoint
CREATE INDEX "eta_event_idx" ON "escrow_timeline_attachments" USING btree ("escrow_id","event_id");