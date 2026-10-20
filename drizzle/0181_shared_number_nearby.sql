-- Shared number: a buyer asked for shops near them and was sent the "Share location" button. Their pin answers
-- that question (with what they were looking for) even from inside a shop, where a pin otherwise goes to the
-- shop as a delivery location. Only the question is kept, never the buyer's coordinates. Safe to re-run.
CREATE TABLE IF NOT EXISTS "shared_number_lobby" (
	"buyerPhone" varchar(32) PRIMARY KEY NOT NULL,
	"nearQuery" varchar(60),
	"nearAskedAt" timestamp,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
