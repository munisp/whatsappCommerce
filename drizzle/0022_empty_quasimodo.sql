ALTER TABLE "phone_otp_sessions" ALTER COLUMN "expires_at" SET DATA TYPE timestamp USING (to_timestamp("expires_at"));--> statement-breakpoint
ALTER TABLE "phone_otp_sessions" ALTER COLUMN "created_at" SET DATA TYPE timestamp USING (to_timestamp("created_at"));
