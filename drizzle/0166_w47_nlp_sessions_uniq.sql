-- === W47 buyer (Coder B) ===
-- ONB-B-10: nlp_sessions get-or-create was check-then-insert with no unique
-- constraint — two concurrent first messages created split sessions/carts.
-- Dedupe defensively (keep the OLDEST row per tenant+phone), then enforce a
-- single winner with a unique index; routers/nlp.ts now upserts ON CONFLICT.
DELETE FROM nlp_sessions a USING nlp_sessions b
 WHERE a."tenantId" = b."tenantId"
   AND a."waPhoneNumber" = b."waPhoneNumber"
   AND (a."createdAt" > b."createdAt" OR (a."createdAt" = b."createdAt" AND a.id > b.id));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "nlp_sessions_tenant_phone_uq" ON "nlp_sessions" ("tenantId", "waPhoneNumber");
