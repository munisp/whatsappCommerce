import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
const client = postgres(process.env.POSTGRES_URL!);
const db = drizzle(client);
async function main() {
  await client`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS "smsFailoverEnabled" boolean NOT NULL DEFAULT false`;
  await client`ALTER TABLE nlp_sessions ADD COLUMN IF NOT EXISTS "ussdMode" boolean NOT NULL DEFAULT false`;
  await client`CREATE TABLE IF NOT EXISTS whatsapp_media_files (
    id varchar(36) PRIMARY KEY,
    "tenantId" varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    "conversationId" varchar(36),
    "waPhoneNumber" varchar(20),
    "fileName" varchar(255) NOT NULL,
    "mimeType" varchar(128) NOT NULL,
    "fileSize" integer,
    "storageKey" varchar(512) NOT NULL,
    "storageUrl" varchar(1024) NOT NULL,
    "documentType" varchar(32) NOT NULL DEFAULT 'other',
    "aiScanResult" jsonb,
    "uploadedAt" timestamp NOT NULL DEFAULT now()
  )`;
  await client`CREATE INDEX IF NOT EXISTS wa_media_tenant_idx ON whatsapp_media_files ("tenantId")`;
  await client`CREATE INDEX IF NOT EXISTS wa_media_conversation_idx ON whatsapp_media_files ("conversationId")`;
  console.log("Done");
  await client.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
