-- Businesses onboard by chat on the shared number (SELL) and on the platform Telegram bot. Safe to re-run.
-- shared_number_lobby.sellingAt: this phone is setting up a shop, so its messages on the shared number go to the
-- onboarding assistant until it is done or they go back to shopping ("stores", a shop code).
ALTER TABLE "shared_number_lobby" ADD COLUMN IF NOT EXISTS "sellingAt" timestamp;
--> statement-breakpoint
-- The platform Telegram bot's chats and the phone each one proved by sharing its own contact (Telegram verifies it).
CREATE TABLE IF NOT EXISTS "telegram_platform_chats" (
	"chatId" varchar(32) PRIMARY KEY NOT NULL,
	"phone" varchar(32) NOT NULL,
	"username" varchar(64),
	"verifiedAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
