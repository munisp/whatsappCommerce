-- === W48 api-db (PERF-API-12): pg_trgm GIN index on products(lower(name))
-- so tenant product name search (ILIKE '%…%') can use an index instead of a
-- full seq scan. Additive only.
-- The DO blocks make this resilient on Postgres variants without the
-- pg_trgm contrib module (e.g. embedded PGlite used by the sim harness):
-- the migration succeeds with a WARNING and the code keeps working (ILIKE
-- falls back to a seq scan). ===
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pg_trgm unavailable on this Postgres — skipping products trigram index';
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "products_lower_name_trgm_idx" ON "products" USING gin (lower("name") gin_trgm_ops)';
  END IF;
END $$;
