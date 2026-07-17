CREATE TABLE "phone_otp_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"phone" varchar(30) NOT NULL,
	"otp_hash" varchar(128) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" integer NOT NULL,
	"created_at" integer NOT NULL,
	"user_id" integer,
	"purpose" varchar(32) DEFAULT 'login' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" varchar(30);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phoneVerified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_otp_sessions" ADD CONSTRAINT "phone_otp_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_otp_phone_idx" ON "phone_otp_sessions" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "phone_otp_expires_idx" ON "phone_otp_sessions" USING btree ("expires_at");