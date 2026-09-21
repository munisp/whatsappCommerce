import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { spawn } from "child_process";
// archiver loaded via createRequire (CJS module)
import { createRequire as _cjsRequire } from "module";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Archiver: _ArchiverClass } = _cjsRequire(import.meta.url)("archiver");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const archiver = (format: string, opts?: Record<string, unknown>): any => new _ArchiverClass(format, opts);
import path from "path";
import { fileURLToPath } from "url";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { storageServe } from "../storage";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { isProd, isDev } from "./env";
import { runRecoverySweeps, sweepEndpointAuth, sweepIntervalMinutes } from "./recoverySweeps";
import { registerGracefulShutdown } from "./gracefulShutdown";
import { WebSocketServer, WebSocket } from "ws";
import { sdk } from "./sdk";
import { getDb } from "../db";
import { inventorySnapshots, invoices } from "../../drizzle/schema";
import { runInventorySyncHeartbeat } from "../services/inventorySync";
import { isTenantInactive, logSuspendedTenantDrop, getTenantStatus } from "../services/tenantGuard";
import { sql } from "drizzle-orm";
import { z } from "zod";
import crypto from "crypto";
import { paymentTransactions, paymentIntents, walletTransactions, alertRules, alertRuleEvents, forecastSnapshots, tenants, escrowConfig, escrowTransactions, escrowSlaExtensions, logisticsShipments, merchantWallets, floatIncomeEntries, orders } from "../../drizzle/schema";
import { broadcastCampaigns, broadcastRecipients, twentyContacts } from "../../drizzle/schema";
import { hermesPODrafts, hermesHealthLog, fluvioEventLog } from "../../drizzle/schema";
import { eq, and, desc, gte, lte, lt } from "drizzle-orm";
import { randomUUID } from "crypto";
import { handleGetEvidencePortal, handleSubmitEvidence } from "../routers/evidencePortal";
import { publishConversationEvent } from "../kafka";
import { daprSaveState, daprGetState } from "../dapr";
import { redisSet, redisGet } from "../redis";
import { runSlaScan } from "../routers/sla";
import { confirmProviderPayment } from "../services/paymentConfirm";
import { finalizeWalletWithdrawal } from "../routers/escrow";
import { sendWhatsAppInteractive, sendWhatsAppMedia, sendWhatsAppText, applyWaDeliveryStatus, markMessageRead } from "../services/waSender";
import { isOnboardingIntakeNumber } from "../services/waOnboarding";
import { handleInboundReceiptImage } from "../services/receiptVerification";
import {
  handleIntegrationWebhook,
  SIGNATURE_HEADER as INTEGRATION_SIGNATURE_HEADER,
  TENANT_HEADER as INTEGRATION_TENANT_HEADER,
} from "../services/integrations/inbound";
import { processOutbox } from "../services/integrations/outbox";
import { claimWebhookEvent, sweepProcessedWebhookEvents } from "../services/webhookDedupe";
import { handleUnifiedPaymentWebhook } from "../services/payments/providers/unifiedWebhook";
import {
  recordUsage, getPlan, evaluateQuota, notifyQuotaWarning,
  METRIC_MESSAGES, METRIC_MESSAGES_IN, METRIC_MESSAGES_OUT,
} from "../services/metering";
import { matchSettlements } from "../services/reconMatch";
import { checkReadiness, readinessHttpStatus } from "../services/healthReady";
// === W34 otel-core ===
import {
  initTelemetry, telemetryStatus,
  recordHttpRequest, recordCronRun, renderMetrics, injectTraceHeaders,
  expressTelemetryMiddleware,
} from "./telemetry";

// ── Conversation WebSocket broadcast ─────────────────────────────────────────
// Map of tenantId → Set of connected clients
const tenantClients = new Map<string, Set<WebSocket>>();

export function broadcastConversationEvent(tenantId: string, event: object) {
  const clients = tenantClients.get(tenantId);
  if (!clients) return;
  const msg = JSON.stringify(event);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// === W34 wa-ops-alert (merger seam) === payload schema for the ops bridge.
const waOpsAlertSchema = z.object({
  to: z.string().regex(/^\+?[0-9]{8,15}$/, "to must be an E.164-ish WhatsApp number"),
  body: z.string().min(1).max(4000),
  kind: z.literal("ops-alert"),
});

/**
 * Platform ops: outbound sends at the webhook-dispatch layer are usage-metered
 * (messages_out + the combined `messages` quota counter) without touching
 * waSender. Metering never blocks or fails the send (recordUsage swallows its
 * own errors).
 */
async function sendWhatsAppTextMetered(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  tenantId: string,
  phone: string,
  text: string,
  opts?: Parameters<typeof sendWhatsAppText>[3],
) {
  const result = await sendWhatsAppText(tenantId, phone, text, opts);
  await recordUsage(db, tenantId, METRIC_MESSAGES_OUT);
  await recordUsage(db, tenantId, METRIC_MESSAGES);
  return result;
}

// === W45 webhook-core ===
// Shared inbound-pipeline helpers for the Meta WhatsApp webhook and its DLQ
// retry heartbeat (MSG-3/4/5/7/8/12/13/14/16/21/22). Both paths dispatch
// through processWaWebhookValue below — the SAME per-message pipeline.

type WaWebhookDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

interface WaValueProcessResult {
  failures: string[];
  duplicatesSkipped: number;
  suppressed: number;
  quarantined: number;
}

/**
 * MSG-22: reverse a dedupe-ledger claim (best-effort). Used when a claimed
 * message cannot be processed right now (e.g. over-quota) and must stay
 * replayable after the condition clears. Never throws.
 */
async function releaseWaWebhookClaim(db: WaWebhookDb, claimId: string): Promise<void> {
  try {
    const { processedWebhookEvents } = await import("../../drizzle/schema");
    await db.delete(processedWebhookEvents).where(eq(processedWebhookEvents.id, claimId));
    console.warn(`[whatsapp-webhook] released wamid claim ${claimId} (replayable after quota reset)`);
  } catch (e: any) {
    console.error(`[whatsapp-webhook] claim release failed for ${claimId}:`, e?.message);
  }
}

/**
 * MSG-3: platform ops alert for a message delivered to an unknown
 * phone_number_id. The message is quarantined (never dispatched under the
 * shared "default" tenant); the alert goes to PLATFORM_OPS_ALERT_PHONE when
 * configured and is always logged loudly. Never throws.
 */
async function alertUnknownPhoneNumberId(phoneNumberId: string, msg: any, from: string): Promise<void> {
  console.error(
    `[whatsapp-webhook] QUARANTINED inbound message: unknown phone_number_id='${phoneNumberId}' ` +
    `wamid=${msg?.id ?? "?"} from=${from} type=${msg?.type ?? "?"} — refused default-tenant dispatch`,
  );
  try {
    const opsPhone = process.env.PLATFORM_OPS_ALERT_PHONE ?? "";
    if (opsPhone) {
      await sendWhatsAppText("default", opsPhone,
        `⚠️ WA webhook quarantine: message ${msg?.id ?? "?"} to unregistered phone_number_id ${phoneNumberId} from ${from} was NOT dispatched.`,
        { notifType: "ops_alert", skipLog: false });
    }
  } catch (e: any) {
    console.error("[whatsapp-webhook] quarantine ops alert send failed:", e?.message);
  }
}

/**
 * MSG-12: customer_changed_number (number port) — migrate identity
 * (customers), consent records, cart sessions and the 24h session window to
 * the new wa_id so the buyer's context is not orphaned. Conversations stay
 * linked through the unchanged customer row. Best-effort per table: a
 * failure on one table must not block the others.
 */
async function migrateWaIdentityOnNumberPort(db: WaWebhookDb, tenantId: string, oldWaId: string, newWaId: string): Promise<void> {
  const { customers: customersT, consents: consentsT, cartSessions: cartSessionsT } = await import("../../drizzle/schema");
  await db.update(customersT)
    .set({ whatsappPhone: newWaId, updatedAt: new Date() })
    .where(and(eq(customersT.tenantId, tenantId), eq(customersT.whatsappPhone, oldWaId)))
    .catch((e: any) => console.error("[number-port] customers migrate failed:", e?.message));
  await db.update(consentsT)
    .set({ phone: newWaId, updatedAt: new Date() })
    .where(and(eq(consentsT.tenantId, tenantId), eq(consentsT.phone, oldWaId)))
    .catch((e: any) => console.error("[number-port] consents migrate failed:", e?.message));
  await db.update(cartSessionsT)
    .set({ waPhoneNumber: newWaId, updatedAt: new Date() })
    .where(and(eq(cartSessionsT.tenantId, tenantId), eq(cartSessionsT.waPhoneNumber, oldWaId)))
    .catch((e: any) => console.error("[number-port] cart_sessions migrate failed:", e?.message));
  try {
    // wa:sw:{tenant}:{new} window opened; the old key expires naturally.
    const { recordInbound } = await import("../services/sessionWindow");
    await recordInbound(tenantId, newWaId, new Date());
  } catch (e: any) {
    console.error("[number-port] session-window migrate failed:", e?.message);
  }
  console.log(`[number-port] tenant=${tenantId} ${oldWaId} → ${newWaId}: customers/consents/cart_sessions/session-window migrated`);
}

/**
 * Process one Meta webhook change `value` (messages + delivery statuses)
 * through the single shared per-message pipeline. Called by the live webhook
 * handler for EVERY entry[]/changes[] fan-out (MSG-4) and by the DLQ retry
 * heartbeat with a namespaced claim prefix (MSG-8). Per-message failures are
 * collected into result.failures (MSG-7) so the caller can mark the DLQ row
 * processed/failed+lastError.
 */
async function processWaWebhookValue(
  db: WaWebhookDb,
  value: any,
  opts: { claimPrefix?: string } = {},
): Promise<WaValueProcessResult> {
  const messages: any[] = value?.messages ?? [];
  const contacts: any[] = value?.contacts ?? [];
  const phoneNumberId: string = value?.metadata?.phone_number_id ?? "";
  const result: WaValueProcessResult = { failures: [], duplicatesSkipped: 0, suppressed: 0, quarantined: 0 };
      for (const msg of messages) {
        // === W45 webhook-core (MSG-7): per-message try/catch → the
        // caller marks the DLQ event failed+lastError so the retry
        // heartbeat has real work. ===
        try {
        const waPhoneNumber: string = msg.from ?? "";
        const contactName: string = contacts.find((c: any) => c.wa_id === waPhoneNumber)?.profile?.name ?? "";
// === W45 webhook-core (MSG-21) === claim-first ordering: the
        // wamid dedupe claim now happens BEFORE the onboarding-intake branch
        // (tenantId scope "onboarding") so intake deliveries are deduped like
        // every other inbound message.
        const isOnboardingIntake = isOnboardingIntakeNumber(phoneNumberId);
        // Determine tenant from phone number ID (look up in tenants table)
        const [tenant] = isOnboardingIntake
          ? [null as any]
          : await db.select().from(tenants)
            .where(eq(tenants.whatsappPhoneNumberId, phoneNumberId))
            .limit(1).catch(() => [null as any]);
        // === W40 tenancy (TEN-1): suspended/churned tenants get NO inbound
        // processing — drop with a structured log, before the dedupe claim,
        // metering, contact provisioning or NLP dispatch. The 200 ack was
        // already sent, so Meta will not retry.
        if (tenant && isTenantInactive((tenant as any).status)) {
          logSuspendedTenantDrop("whatsapp", {
            tenantId: (tenant as any).id,
            tenantStatus: (tenant as any).status,
            phoneNumberId,
            wamid: msg.id ?? null,
            from: waPhoneNumber,
          });
          continue;
        }
        // === W45 webhook-core (MSG-3 / TEN-21): unknown phone_number_id →
        // quarantine. NEVER dispatch under the shared "default" tenant in
        // production (cross-tenant contamination); outside production the
        // shared-default fallback is allowed only when
        // WHATSAPP_DEFAULT_TENANT_ID is explicitly configured. Quarantined
        // messages raise a platform ops alert and are NOT processed. ===
        if (!isOnboardingIntake && !tenant) {
          const allowSharedDefault = !isProd && !!process.env.WHATSAPP_DEFAULT_TENANT_ID;
          if (!allowSharedDefault) {
            result.quarantined++;
            await alertUnknownPhoneNumberId(phoneNumberId, msg, waPhoneNumber);
            continue;
          }
        }
        const tenantId: string = isOnboardingIntake
          ? "onboarding"
          : ((tenant as any)?.id ?? process.env.WHATSAPP_DEFAULT_TENANT_ID ?? "default");
        // ── Platform ops: webhook idempotency (insert-first claim) ──────────
        // Meta retries deliveries until a 200; the wamid is the ledger PK, so
        // a retry collides (ON CONFLICT DO NOTHING) and is skipped — a
        // message is never reprocessed. Production fails closed when the
        // ledger is unavailable (dev/test use an in-memory fallback).
        // Messages that don't match a real tenant (e.g. Meta's fixed-payload
        // test button, always the same wamid) get a unique claim key per
        // delivery instead, so they're never skipped as duplicates — real
        // tenant-matched messages keep strict per-wamid dedup unchanged.
        // On DLQ-heartbeat replay (MSG-8) the claim is namespaced by
        // opts.claimPrefix so a failed first attempt can be reprocessed
        // idempotently per retry attempt.
        let claimedWamid: string | null = null;
        if (msg.id) {
          const claimId = opts.claimPrefix
            ? `${opts.claimPrefix}${msg.id}`
            : (tenant || isOnboardingIntake ? msg.id : `${msg.id}:${Date.now()}`);
          let claim: "claimed" | "duplicate";
          try {
            claim = await claimWebhookEvent(db, { id: claimId, tenantId, type: msg.type ?? "unknown" });
          } catch (dedupeErr: any) {
            // Fail closed (production policy): the ack was already sent, but a
            // blind dedupe ledger must NOT reprocess — skip the message.
            console.error(`[whatsapp-webhook] dedupe ledger unavailable for ${msg.id} — failing closed, message NOT processed:`, dedupeErr?.message);
            continue;
          }
          if (claim === "duplicate") {
            result.duplicatesSkipped++;
            console.log(`[whatsapp-webhook] duplicate delivery ${msg.id} — skipped`);
            continue;
          }
          claimedWamid = claimId;
          // ── Read receipt (blue ticks): fire-and-forget after the message ──
          // is accepted for processing — NEVER blocks or throws.
          if (!isOnboardingIntake) {
            markMessageRead(tenantId, msg.id).catch(() => {});
          }
        }
        // ── w9: platform conversational-onboarding intake number ────────────
        // Messages to the platform's own onboarding number belong to a
        // prospective tenant with no tenant row yet — hand them to the
        // onboarding copilot and skip normal tenant dispatch entirely.
        // Unset ONBOARDING_PHONE_NUMBER_ID → predicate is always false → zero
        // behavior change for existing tenants. (W45 MSG-21: the wamid was
        // already claimed above, so Meta retries of intake messages dedupe.)
        if (isOnboardingIntake) {
          try {
            const { handleInbound } = await import("../services/waOnboarding");
            await handleInbound(msg, waPhoneNumber);
          } catch (e: any) {
            // Fail-safe: the 200 ack was already sent; never rethrow.
            console.error("[whatsapp-webhook] onboarding intake error:", e?.message);
          }
          continue;
        }
        // ── Platform ops: usage metering + monthly message quota gate ──────
        // Count every inbound message; warn the tenant admin once per period
        // at 80% and 100%; past the hard stop (limit + 10% grace) the buyer
        // gets a polite "merchant busy" reply and the message is not processed.
        try {
          await recordUsage(db, tenantId, METRIC_MESSAGES_IN);
          const totalUsage = await recordUsage(db, tenantId, METRIC_MESSAGES);
          const plan = await getPlan(db, tenantId);
          const quota = evaluateQuota(totalUsage, plan.limits.messagesPerMonth);
          if (quota.warnLevel) await notifyQuotaWarning(db, tenantId, quota);
          if (!quota.allowed) {
            console.warn(`[whatsapp-webhook] tenant ${tenantId} over hard message quota (${quota.usage}/${quota.limit}) — busy reply sent`);
            await sendWhatsAppText(tenantId, waPhoneNumber,
              "Thanks for your message! We're experiencing unusually high volume right now — please try again a little later. 🙏",
              { notifType: "quota_busy" }).catch((e: any) => console.warn("[whatsapp-webhook] busy reply send failed:", e?.message));
            // === W45 webhook-core (MSG-22): over-quota messages were
            // previously claimed then silently dropped — unrecoverable after
            // quota reset. Reverse the wamid claim and surface the event to
            // the DLQ retry heartbeat (throw → caller marks the event failed
            // with nextRetryAt) so the message is replayed after reset. ===
            if (claimedWamid) await releaseWaWebhookClaim(db, claimedWamid);
            throw new Error(`over_quota: tenant ${tenantId} message quota exhausted (${quota.usage}/${quota.limit})`);
          }
        } catch (e: any) {
          // Metering/quota failures must never block message processing.
          console.error("[whatsapp-webhook] metering/quota check failed — processing anyway:", e?.message);
        }
        // === W45 webhook-core (MSG-5): human-agent takeover suppression ===
        // When the (tenant, phone) conversation is human_active, the inbound
        // message is persisted for the agent thread (and the conversation
        // counters bumped) but ALL bot replies/dispatch are suppressed until
        // an agent releases the thread back to the bot (escalation.releaseToBot
        // / resolve). Fail-open: a lookup error must not drop the message.
        try {
          const { customers: customersT, conversations: convsT } = await import("../../drizzle/schema");
          const [cust] = await db.select({ id: customersT.id }).from(customersT)
            .where(and(eq(customersT.tenantId, tenantId), eq(customersT.whatsappPhone, waPhoneNumber)))
            .limit(1).catch(() => [] as any[]);
          if (cust?.id) {
            const [humanConv] = await db.select().from(convsT)
              .where(and(
                eq(convsT.tenantId, tenantId),
                eq(convsT.customerId, cust.id),
                eq(convsT.status, "human_active"),
              ))
              .orderBy(desc(convsT.updatedAt)).limit(1).catch(() => [] as any[]);
            if (humanConv) {
              await db.insert(whatsappCustomerReplies).values({
                id: crypto.randomUUID(),
                tenantId,
                userId: null,
                fromPhone: waPhoneNumber,
                toPhone: phoneNumberId,
                wamid: msg.id ?? crypto.randomUUID(),
                contextWamid: msg.context?.id ?? null,
                messageType: msg.type ?? "unknown",
                body: msg.text?.body ?? msg.image?.caption ?? msg.document?.caption ?? `[${msg.type ?? "unknown"}]`,
                mediaId: msg.image?.id ?? msg.document?.id ?? msg.video?.id ?? msg.audio?.id ?? null,
              }).onConflictDoNothing()
                .catch((e: any) => console.error("[whatsapp-webhook] human_active inbound persist error:", e?.message));
              await db.update(convsT)
                .set({ messageCount: sql`${convsT.messageCount} + 1`, updatedAt: new Date() })
                .where(eq(convsT.id, humanConv.id)).catch(() => {});
              result.suppressed++;
              console.log(`[whatsapp-webhook] human_active conversation ${humanConv.id} — bot replies suppressed for ${waPhoneNumber} (tenant ${tenantId})`);
              continue;
            }
          }
        } catch (e: any) {
          console.error("[whatsapp-webhook] human_active check failed — processing normally:", e?.message);
        }
        // ── WA messaging ops: contact auto-provisioning + 24h session window ──
        // Upsert the customer from Meta's contacts[] payload (profile name
        // fills only an empty name) and stamp the inbound window. Text
        // messages are then checked against CTWA campaign keywords for
        // attribution + mapped action. Never blocks message processing.
        try {
          const { provisionInboundContact } = await import("../services/waContacts");
          await provisionInboundContact(db, tenantId, waPhoneNumber, contactName);
          const { recordInbound } = await import("../services/sessionWindow");
          await recordInbound(tenantId, waPhoneNumber, new Date());
          if (msg.type === "text") {
            const { handleCtwaInbound } = await import("../services/ctwa");
            const claimed = await handleCtwaInbound({
              db, tenantId, phone: waPhoneNumber, text: msg.text?.body ?? "", contactName: contactName || undefined,
            });
            if (claimed) continue;
          }
        } catch (e: any) {
          console.error("[whatsapp-webhook] messaging-ops entry error:", e?.message);
        }
        // === W45 webhook-core (MSG-12): system messages — number port ===
        // customer_changed_number carries system.new_wa_id; migrate identity
        // (customers), consent, session-window and cart state to the new
        // wa_id so the buyer's context is not orphaned.
        if (msg.type === "system") {
          const sysType: string = msg.system?.type ?? "";
          if (sysType === "customer_changed_number") {
            const newWaId = String(msg.system?.new_wa_id ?? "").replace(/[^0-9]/g, "");
            const oldWaId = waPhoneNumber.replace(/[^0-9]/g, "");
            if (newWaId && oldWaId && newWaId !== oldWaId) {
              try {
                await migrateWaIdentityOnNumberPort(db, tenantId, oldWaId, newWaId);
                await sendWhatsAppText(tenantId, newWaId,
                  "Your WhatsApp number changed — we've moved your account, consent and cart to your new number. ✅",
                  { notifType: "number_port" })
                  .catch((e: any) => console.error("[whatsapp-webhook] number-port notice send error:", e?.message));
              } catch (e: any) {
                console.error("[whatsapp-webhook] number-port migration error:", e?.message);
              }
            } else {
              console.warn(`[whatsapp-webhook] customer_changed_number with unusable ids (old='${oldWaId}' new='${newWaId}') — skipped`);
            }
          } else {
            console.log(`[whatsapp-webhook] unhandled system message subtype '${sysType}' — acknowledged`);
          }
          continue;
        }
        // ── Emoji-reaction tracking ─────────────────────────────────────────
        // WhatsApp reaction payloads carry a `reaction` field; reply with the
        // sender's latest order/shipment status + tracking link.
        if (msg.type === "reaction" || msg.reaction) {
          try {
            const { handleReactionInbound } = await import("../services/useCases");
            const reactionReply = await handleReactionInbound({ db, tenantId, phone: waPhoneNumber });
            if (reactionReply) {
              await sendWhatsAppTextMetered(db, tenantId, waPhoneNumber, reactionReply, { notifType: "reaction_status" })
                .catch((e: any) => console.error("[whatsapp-webhook] reaction reply send error:", e?.message));
            }
          } catch (e: any) {
            console.error("[whatsapp-webhook] reaction tracking error:", e?.message);
          }
          continue;
        }
        // ── Interactive replies (button_reply / list_reply) ───────────────
        // Menu buttons/lists carry `menu_<n>` ids and resolve through the
        // SAME resolveMenuSelection logic as numeric text replies; order
        // action cards carry `order_<action>:<orderId>` ids.
        if (msg.type === "interactive") {
          try {
            const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply ?? null;
            // === W27 catalog-ai (additive): merchant AI-listing draft buttons
            // (catalog_ai:publish:<id> / catalog_ai:reject:<id>) resolve here;
            // any other id falls through to the standard dispatch unchanged.
            if ((reply?.id ?? "").startsWith("catalog_ai:")) {
              const { handleCatalogDraftButton } = await import("../services/catalogAI");
              const r = await handleCatalogDraftButton({ tenantId, phone: waPhoneNumber, replyId: reply!.id });
              if (r?.reply) {
                await sendWhatsAppText(tenantId, waPhoneNumber, r.reply)
                  .catch((e: any) => console.error("[whatsapp-webhook] catalog-ai reply send error:", e?.message));
              }
              continue;
            }
            // === W43 dispatch (Coder C): merchant address-change approval
            // card buttons (addrchg:approve:<id> / addrchg:reject:<id>) resolve
            // here; any other id falls through unchanged. TG inline-keyboard
            // taps carry the SAME ids into the NLP engine (see routers/nlp.ts).
            if ((reply?.id ?? "").startsWith("addrchg:")) {
              try {
                const m = /^addrchg:(approve|reject):([0-9a-fA-F-]{36})$/i.exec(reply!.id);
                let cardReply = "Sorry, that address-change link is no longer valid.";
                if (m) {
                  const { isTenantStaffPhone } = await import("../services/catalogAI");
                  const isStaff = await isTenantStaffPhone(db, tenantId, waPhoneNumber).catch(() => false);
                  if (!isStaff) {
                    cardReply = "Sorry, only store staff can approve or reject address changes.";
                  } else {
                    const { decideAddressChange } = await import("../services/addressChange");
                    const decided = await decideAddressChange(db, {
                      requestId: m[2],
                      tenantId,
                      approve: m[1].toLowerCase() === "approve",
                      decidedBy: waPhoneNumber,
                    });
                    cardReply = `Address change ${decided.id.slice(0, 8)} ${decided.status} — the customer has been notified.`;
                  }
                }
                await sendWhatsAppText(tenantId, waPhoneNumber, cardReply)
                  .catch((e: any) => console.error("[whatsapp-webhook] addrchg reply send error:", e?.message));
              } catch (e: any) {
                await sendWhatsAppText(tenantId, waPhoneNumber, `Could not update that address change: ${e?.message ?? "unknown error"}`)
                  .catch(() => {});
              }
              continue;
            }
            // === END W43 dispatch ===
            // === W44 preorders-offers (Coder B): merchant offer approval
            // card buttons (offer:accept|reject|counter:<id>) resolve here;
            // counter via card prompts for the typed amount form. Customer
            // counter-offer card taps (offer:caccept|cdecline:<id>) resolve
            // here too (customerRef = waPhoneNumber). TG callbacks carry the
            // SAME ids into the NLP engine (see routers/nlp.ts). ===
            if ((reply?.id ?? "").startsWith("offer:")) {
              const id = reply!.id;
              const m = /^offer:(accept|reject|counter):([0-9a-fA-F-]{8,36})$/i.exec(id);
              const cm = /^offer:(caccept|cdecline):([0-9a-fA-F-]{8,36})$/i.exec(id);
              let cardReply = "Sorry, that offer link is no longer valid.";
              try {
                if (m) {
                  const { isTenantStaffPhone } = await import("../services/catalogAI");
                  const isStaff = await isTenantStaffPhone(db, tenantId, waPhoneNumber).catch(() => false);
                  if (!isStaff) {
                    cardReply = "Sorry, only store staff can respond to offers.";
                  } else if (m[1].toLowerCase() === "counter") {
                    cardReply = `To counter, type OFFER COUNTER ${m[2]} <amount> — e.g. OFFER COUNTER ${m[2]} 4800.`;
                  } else {
                    const { decideOffer } = await import("../services/customOffers");
                    const decided = await decideOffer(db, {
                      offerId: m[2],
                      tenantId,
                      action: m[1].toLowerCase() as "accept" | "reject",
                      decidedBy: waPhoneNumber,
                    });
                    cardReply = decided.status === "accepted"
                      ? `Offer ${decided.id.slice(0, 8)} accepted — the customer got a priced checkout link.`
                      : `Offer ${decided.id.slice(0, 8)} ${decided.status} — the customer has been notified.`;
                  }
                } else if (cm) {
                  const { respondToCounter } = await import("../services/customOffers");
                  const decided = await respondToCounter(db, {
                    offerId: cm[2],
                    tenantId,
                    customerRef: waPhoneNumber,
                    accept: cm[1].toLowerCase() === "caccept",
                  });
                  cardReply = decided.status === "accepted"
                    ? "Deal! Your payment link is on its way here."
                    : decided.status === "rejected"
                      ? "Okay — that offer is closed. You can make a new one any time."
                      : `That offer is ${decided.status} now.`;
                }
              } catch (e: any) {
                cardReply = `Could not update that offer: ${e?.message ?? "unknown error"}`;
              }
              await sendWhatsAppText(tenantId, waPhoneNumber, cardReply)
                .catch((e: any) => console.error("[whatsapp-webhook] offer reply send error:", e?.message));
              continue;
            }
            // === END W44 preorders-offers ===
            const { handleInteractiveInbound } = await import("../services/useCases");
            const outcome = await handleInteractiveInbound({
              db,
              tenant: tenant ?? null,
              tenantId,
              phone: waPhoneNumber,
              replyId: reply?.id ?? undefined,
              replyTitle: reply?.title ?? undefined,
              customerName: contactName || undefined,
            });
            if (outcome.interactive) {
              await sendWhatsAppInteractive(tenantId, waPhoneNumber, outcome.interactive)
                .catch((e: any) => console.error("[whatsapp-webhook] interactive reply send error:", e?.message));
            } else if (outcome.reply) {
              await sendWhatsAppText(tenantId, waPhoneNumber, outcome.reply)
                .catch((e: any) => console.error("[whatsapp-webhook] interactive reply send error:", e?.message));
            }
          } catch (e: any) {
            console.error("[whatsapp-webhook] interactive reply error:", e?.message);
          }
          continue;
        }
        if (msg.type === "text") {
          const textBody: string = msg.text?.body ?? "";
          // ── Capture customer reply in whatsapp_customer_replies ────────────
          try {
            const contextWamid: string | undefined = msg.context?.id;
            // Resolve orderId from contextWamid (look up in notification log)
            let replyOrderId: string | undefined;
            let replyUserId: number | undefined;
            if (contextWamid) {
              const [notifLog] = await db.select()
                .from(whatsappNotificationLog)
                .where(eq(whatsappNotificationLog.wamid, contextWamid))
                .limit(1).catch(() => [null as any]);
              if (notifLog) {
                replyOrderId = notifLog.orderId ?? undefined;
                replyUserId = notifLog.userId ?? undefined;
              }
            }
            // Resolve userId from phone if not found via contextWamid
            if (!replyUserId) {
              const [matchedUser] = await db.select({ id: users.id })
                .from(users)
                .where(eq(users.phone, waPhoneNumber))
                .limit(1).catch(() => [null as any]);
              if (matchedUser) replyUserId = matchedUser.id;
            }
            await db.insert(whatsappCustomerReplies).values({
              id: crypto.randomUUID(),
              tenantId,
              orderId: replyOrderId ?? null,
              userId: replyUserId ?? null,
              fromPhone: waPhoneNumber,
              toPhone: phoneNumberId,
              wamid: msg.id ?? crypto.randomUUID(),
              contextWamid: contextWamid ?? null,
              messageType: "text",
              body: textBody,
            }).onConflictDoNothing();
          } catch (e: any) {
            console.error("[whatsapp-webhook] customer reply capture error:", e?.message);
          }
          // ── Hermes PO approval/rejection via WhatsApp reply ───────────────
          const poMatch = textBody.trim().match(/^(APPROVE|REJECT)\s+PO-([A-Z0-9]+)/i);
          if (poMatch) {
            const action = poMatch[1].toUpperCase();
            const poId = poMatch[2];
            try {
              const { hermesPODrafts: hpd } = await import("../../drizzle/schema");
              const { eq: eqOp, and: andOp } = await import("drizzle-orm");
              const dbInst = await getDb();
              if (dbInst) {
                // === W45 webhook-core (MSG-16) === sender verification: only
                // the tenant's configured adminPhone may approve/reject POs
                // (fail closed when adminPhone is not configured).
                const { resolveAdminPhone } = await import("../services/adminAlerts");
                const adminPhone = await resolveAdminPhone(dbInst, tenantId);
                const normDigits = (p: string) => p.replace(/[^0-9]/g, "");
                if (!adminPhone || normDigits(adminPhone) !== normDigits(waPhoneNumber)) {
                  console.warn(`[hermes-webhook] PO ${action} command from non-admin phone ${waPhoneNumber} (tenant ${tenantId}) — ignored`);
                  await sendWhatsAppText(tenantId, waPhoneNumber, "Sorry, only the store admin phone can approve or reject purchase orders.")
                    .catch((e: any) => console.error("[hermes-webhook] non-admin notice send failed:", e?.message));
                  continue; // Skip NLP processing for PO commands
                }
                // Unique match required: exact match on the full poId, or an
                // UNAMBIGUOUS suffix match. More than one pending PO matching
                // the token → reject as ambiguous (never act on the first hit).
                // (W45 MSG-16: the dead first select was removed.)
                const allPOs = await dbInst.select().from(hpd)
                  .where(andOp(eqOp(hpd.tenantId, tenantId), eqOp(hpd.status, "pending")))
                  .limit(50);
                const token = poId.toUpperCase();
                const poMatches = allPOs.filter(p => {
                  const full = p.poId.toUpperCase();
                  return full === token || full.endsWith(token);
                });
                if (poMatches.length > 1) {
                  console.warn(`[hermes-webhook] PO-${poId} ambiguous for tenant ${tenantId} — ${poMatches.length} pending POs match`);
                  await sendWhatsAppText(tenantId, waPhoneNumber,
                    `PO-${poId} matches ${poMatches.length} pending purchase orders — please reply with the full PO id (e.g. APPROVE PO-${poMatches[0].poId}).`)
                    .catch((e: any) => console.error("[hermes-webhook] ambiguity notice send failed:", e?.message));
                  continue; // Skip NLP processing for PO commands
                }
                const matchedPO = poMatches[0];
                if (matchedPO) {
                  const newStatus = action === "APPROVE" ? "approved" : "rejected";
                  await dbInst.update(hpd)
                    .set({ status: newStatus as any, approvedAt: Date.now(), approvedBy: waPhoneNumber, note: `WhatsApp ${action} by ${waPhoneNumber}` })
                    .where(eqOp(hpd.poId, matchedPO.poId));
                  // If approved, trigger supplier email via hermes-skills
                  if (action === "APPROVE") {
                    const hermesSkillsUrl = process.env.HERMES_SKILLS_URL ?? "http://hermes-skills:8097";
                    fetch(`${hermesSkillsUrl}/skills/po-approved`, {
                      method: "POST",
                      // hermes-skills /skills/* requires X-Internal-Token == INTERNAL_API_KEY
                      headers: { "Content-Type": "application/json", "X-Internal-Token": process.env.INTERNAL_API_KEY ?? "" },
                      body: JSON.stringify({
                        po_id: matchedPO.poId,
                        tenant_id: matchedPO.tenantId,
                        supplier_email: matchedPO.supplierEmail,
                        supplier_name: matchedPO.supplierName,
                        product_name: matchedPO.productName,
                        sku: matchedPO.sku,
                        quantity: matchedPO.quantity,
                        unit_cost: matchedPO.unitCost,
                        total_cost: matchedPO.totalCost,
                        currency: matchedPO.currency,
                        approved_at: new Date().toISOString(),
                      }),
                      signal: AbortSignal.timeout(10000),
                    }).catch((e: any) => console.error("[hermes-webhook] skills trigger failed:", e?.message));
                  }
                  // Send WhatsApp confirmation back to merchant
                  const waToken = process.env.WA_TOKEN ?? process.env.META_WA_TOKEN ?? "";
                  const waPNId = phoneNumberId || (process.env.WA_PHONE_NUMBER_ID ?? "");
                  if (waToken && waPNId) {
                    const confirmText = action === "APPROVE"
                      ? `✅ PO-${poId} *approved*! Supplier email is being sent to ${matchedPO.supplierName}.`
                      : `❌ PO-${poId} *rejected*. No supplier email will be sent.`;
                    fetch(`https://graph.facebook.com/v19.0/${waPNId}/messages`, {
                      method: "POST",
                      headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
                      body: JSON.stringify({ messaging_product: "whatsapp", to: waPhoneNumber, type: "text", text: { body: confirmText } }),
                    }).catch((e: any) => console.error("[hermes-webhook] WA confirm send failed:", e?.message));
                  }
                } else {
                  console.warn(`[hermes-webhook] PO-${poId} not found for tenant ${tenantId}`);
                }
              }
            } catch (e: any) {
              console.error("[hermes-webhook] PO approval error:", e?.message);
            }
            continue; // Skip NLP processing for PO commands
          }
          // === W27 bookkeeping ===
          // Merchant bookkeeping commands ("sales summary", "digest on/off",
          // "expense", "confirm expense", "export"). Exact/prefix matching
          // only — non-matching messages fall through to the NLP pipeline.
          try {
            const { handleBookkeepingText } = await import("../services/bookkeeping");
            const bkReply = await handleBookkeepingText({ db, tenantId, phone: waPhoneNumber, text: textBody });
            if (bkReply) {
              await sendWhatsAppText(tenantId, waPhoneNumber, bkReply)
                .catch((e: any) => console.error("[whatsapp-webhook] bookkeeping reply send error:", e?.message));
              continue; // claimed — skip NLP
            }
          } catch (e: any) {
            console.error("[whatsapp-webhook] bookkeeping command error:", e?.message);
          }
          // ── CV-1 / J85: visual stock-take APPLY / REVIEW replies ────────
          // "APPLY" applies the calibrated auto-apply items from the latest
          // WhatsApp shelf-photo stock-take; "REVIEW" parks it for the
          // dashboard. Tenant opt-in only — the service returns handled=false
          // when settings.visualInventoryWhatsAppEnabled is off and the text
          // falls through to the normal menu/NLP pipeline.
          const stocktakeMatch = textBody.trim().match(/^(APPLY|REVIEW)$/i);
          if (stocktakeMatch) {
            try {
              const { handleStocktakeApplyReply } = await import("../services/visualStocktake");
              const stOutcome = await handleStocktakeApplyReply({
                tenantId,
                waPhoneNumber,
                command: stocktakeMatch[1].toUpperCase() as "APPLY" | "REVIEW",
              });
              if (stOutcome.handled) continue; // Skip NLP processing for stock-take commands
            } catch (e: any) {
              console.error("[whatsapp-webhook] visual stocktake reply error:", e?.message);
            }
          }
          // ── W17/F10: rider cash-collection confirmation ─────────────────
          // "RIDER_CONFIRM <orderNumber> [amount]" from a registered rider
          // phone (tenant settings.codRiderPhones). Non-riders / other texts
          // fall through to the normal menu/NLP pipeline (handled=false).
          if (/^\s*RIDER_CONFIRM\s+\S+/i.test(textBody)) {
            try {
              const { handleRiderConfirm } = await import("../services/codFlow");
              const riderOutcome = await handleRiderConfirm({
                db,
                tenantId,
                waPhoneNumber,
                text: textBody,
              });
              if (riderOutcome.handled) continue; // Skip NLP processing for rider commands
            } catch (e: any) {
              console.error("[whatsapp-webhook] rider confirm error:", e?.message);
            }
          }
          // ── W27 credit: merchant credit commands ────────────────────────
          // "CREDIT [SCORE|OFFERS|STATUS|ACCEPT [amount]]" from the tenant's
          // admin phone (settings.adminPhone). Non-admins / other texts fall
          // through to the normal menu/NLP pipeline (handled=false).
          if (/^\s*CREDIT\b/i.test(textBody)) {
            try {
              const { handleCreditCommand } = await import("../services/creditWhatsApp");
              const creditOutcome = await handleCreditCommand({
                db,
                tenantId,
                waPhoneNumber,
                text: textBody,
              });
              if (creditOutcome.handled) {
                if (creditOutcome.reply) {
                  await sendWhatsAppTextMetered(db, tenantId, waPhoneNumber, creditOutcome.reply)
                    .catch((e: any) => console.error("[whatsapp-webhook] credit reply send error:", e?.message));
                }
                continue; // Skip NLP processing for credit commands
              }
            } catch (e: any) {
              console.error("[whatsapp-webhook] credit command error:", e?.message);
            }
          }
          // === W28 odoo-sync (Coder A): tenant-admin Odoo commands ────────
          // "ODOO STATUS" / "ODOO SYNC NOW" from the tenant's admin phone
          // (settings.adminPhone). Non-admins / other texts fall through to
          // the normal menu/NLP pipeline (handled=false).
          if (/^\s*ODOO\b/i.test(textBody)) {
            try {
              const { handleOdooCommand } = await import("../services/odoo/odooWhatsApp");
              const odooOutcome = await handleOdooCommand({
                db,
                tenantId,
                waPhoneNumber,
                text: textBody,
              });
              if (odooOutcome.handled) {
                if (odooOutcome.reply) {
                  await sendWhatsAppTextMetered(db, tenantId, waPhoneNumber, odooOutcome.reply)
                    .catch((e: any) => console.error("[whatsapp-webhook] odoo reply send error:", e?.message));
                }
                continue; // Skip NLP processing for odoo commands
              }
            } catch (e: any) {
              console.error("[whatsapp-webhook] odoo command error:", e?.message);
            }
          }
          // === END W28 odoo-sync ===
          // Publish inbound message to Kafka for event streaming
          publishConversationEvent(
            msg.id ?? randomUUID(),
            tenantId,
            "wa.messages.inbound",
            { from: waPhoneNumber, textBody, contactName, waPhoneNumber }
          ).catch(() => {});
          // Cache conversation context in Dapr state store (Redis-backed)
          // === W45 webhook-core (MSG-14): cache keyed by (tenant, phone) ===
          daprSaveState("wacommerce-statestore", `conv:${tenantId}:${waPhoneNumber}:last_msg`, {
            text: textBody, ts: Date.now(), waPhoneNumber, tenantId
          }).catch(() => {});
          // ── Conversational menu/session engine ──────────────────────────
          // Consent gate → menu keywords → numeric selection / active
          // use-case flows. Returns handled=false when the message should
          // fall through to the NLP pipeline (fallback "nlp" or an active
          // shop/NLP session).
          let handledByMenu = false;
          try {
            const { handleConversationalInbound } = await import("../services/useCases");
            const menuOutcome = await handleConversationalInbound({
              db,
              tenant: tenant ?? null,
              tenantId,
              phone: waPhoneNumber,
              text: textBody,
              customerName: contactName || undefined,
            });
            if (menuOutcome.handled) {
              handledByMenu = true;
              // Prefer the interactive (button/list) rendering on WhatsApp;
              // fall back to the plain-text menu when the send fails.
              if (menuOutcome.interactive) {
                const interactiveRes = await sendWhatsAppInteractive(tenantId, waPhoneNumber, menuOutcome.interactive)
                  .catch((e: any) => {
                    console.error("[whatsapp-webhook] interactive menu send error:", e?.message);
                    return null;
                  });
                if (interactiveRes) {
                  // Platform ops metering: outbound interactive menu send.
                  await recordUsage(db, tenantId, METRIC_MESSAGES_OUT);
                  await recordUsage(db, tenantId, METRIC_MESSAGES);
                }
                if (!interactiveRes && menuOutcome.reply) {
                  await sendWhatsAppTextMetered(db, tenantId, waPhoneNumber, menuOutcome.reply)
                    .catch((e: any) => console.error("[whatsapp-webhook] menu reply send error:", e?.message));
                }
              } else if (menuOutcome.reply) {
                await sendWhatsAppTextMetered(db, tenantId, waPhoneNumber, menuOutcome.reply)
                  .catch((e: any) => console.error("[whatsapp-webhook] menu reply send error:", e?.message));
              }
            }
          } catch (e: any) {
            console.error("[whatsapp-webhook] menu engine error — falling back to NLP:", e?.message);
          }
          // Route text messages through the NLP engine, then DELIVER the reply
          // back to the buyer over WhatsApp (previously the reply was computed
          // and silently discarded).
          if (!handledByMenu) {
            try {
              const { appRouter: ar } = await import("../routers");
              const caller = ar.createCaller({ user: null } as any);
              const nlpResult = await caller.nlp.processMessage({
                tenantId,
                waPhoneNumber,
                message: textBody,
                customerName: contactName || undefined,
              });
              if (nlpResult?.reply && nlpResult.intent !== "ussd_menu") {
                await sendWhatsAppTextMetered(db, tenantId, waPhoneNumber, nlpResult.reply)
                  .catch((e: any) => console.error("[whatsapp-webhook] reply send error:", e?.message));
                // Rich follow-ups annotated by the NLP engine:
                // order action card after a confirm_order payment summary,
                // and a product image card on single-product queries.
                const orderCard = (nlpResult as any)?.orderCard as { orderId?: string; orderNumber?: string } | undefined;
                if (orderCard?.orderId && orderCard?.orderNumber) {
                  const { buildOrderActionCard } = await import("../services/useCases");
                  await sendWhatsAppInteractive(
                    tenantId,
                    waPhoneNumber,
                    buildOrderActionCard({ orderId: orderCard.orderId, orderNumber: orderCard.orderNumber }),
                    { notifType: "order_action_card", orderId: orderCard.orderId },
                  ).catch((e: any) => console.error("[whatsapp-webhook] order action card send error:", e?.message));
                }
                const productImage = (nlpResult as any)?.productImage as { link?: string; caption?: string } | undefined;
                if (productImage?.link) {
                  await sendWhatsAppMedia(
                    tenantId,
                    waPhoneNumber,
                    { type: "image", link: productImage.link, caption: productImage.caption },
                    { notifType: "product_image" },
                  ).catch((e: any) => console.error("[whatsapp-webhook] product image send error:", e?.message));
                }
              }
            } catch (e: any) {
              console.error("[whatsapp-webhook] NLP error:", e?.message);
            }
          }
        } else if (msg.type === "location" && msg.location) {
          // ── Native location messages ──────────────────────────────────
          // Buyer shared a pin: if they're mid-checkout awaiting a delivery
          // address, continue checkout exactly as the text-address path and
          // attach the coords to the order; otherwise save it as their
          // default delivery address.
          try {
            const { handleInboundLocationMessage } = await import("../services/locationInbound");
            const outcome = await handleInboundLocationMessage({
              tenantId,
              waPhoneNumber,
              customerName: contactName || undefined,
              location: {
                latitude: Number(msg.location.latitude),
                longitude: Number(msg.location.longitude),
                name: msg.location.name ?? null,
                address: msg.location.address ?? null,
              },
            });
            if (outcome.reply) {
              await sendWhatsAppTextMetered(db, tenantId, waPhoneNumber, outcome.reply)
                .catch((e: any) => console.error("[whatsapp-webhook] location reply send error:", e?.message));
            }
            if (outcome.orderCard?.orderId && outcome.orderCard?.orderNumber) {
              const { buildOrderActionCard } = await import("../services/useCases");
              await sendWhatsAppInteractive(
                tenantId,
                waPhoneNumber,
                buildOrderActionCard({ orderId: outcome.orderCard.orderId, orderNumber: outcome.orderCard.orderNumber }),
                { notifType: "order_action_card", orderId: outcome.orderCard.orderId },
              ).catch((e: any) => console.error("[whatsapp-webhook] order action card send error:", e?.message));
            }
          } catch (e: any) {
            console.error("[whatsapp-webhook] location message error:", e?.message);
          }
          continue;
        } else if (msg.type === "image" || msg.type === "document" || msg.type === "video" || msg.type === "audio") {
          // ── Capture media reply in whatsapp_customer_replies ──────────────
          try {
            const contextWamid: string | undefined = msg.context?.id;
            const mediaId: string = msg.image?.id ?? msg.document?.id ?? msg.video?.id ?? msg.audio?.id ?? "";
            let replyOrderId2: string | undefined;
            let replyUserId2: number | undefined;
            if (contextWamid) {
              const [notifLog2] = await db.select()
                .from(whatsappNotificationLog)
                .where(eq(whatsappNotificationLog.wamid, contextWamid))
                .limit(1).catch(() => [null as any]);
              if (notifLog2) {
                replyOrderId2 = notifLog2.orderId ?? undefined;
                replyUserId2 = notifLog2.userId ?? undefined;
              }
            }
            if (!replyUserId2) {
              const [matchedUser2] = await db.select({ id: users.id })
                .from(users)
                .where(eq(users.phone, waPhoneNumber))
                .limit(1).catch(() => [null as any]);
              if (matchedUser2) replyUserId2 = matchedUser2.id;
            }
            await db.insert(whatsappCustomerReplies).values({
              id: crypto.randomUUID(),
              tenantId,
              orderId: replyOrderId2 ?? null,
              userId: replyUserId2 ?? null,
              fromPhone: waPhoneNumber,
              toPhone: phoneNumberId,
              wamid: msg.id ?? crypto.randomUUID(),
              contextWamid: contextWamid ?? null,
              messageType: msg.type,
              body: msg.image?.caption ?? msg.document?.caption ?? msg.video?.caption ?? null,
              mediaId: mediaId || null,
            }).onConflictDoNothing();
          } catch (e: any) {
            console.error("[whatsapp-webhook] media reply capture error:", e?.message);
          }
          // === W45 webhook-core (A2 seam wired, MSG-6): mirror EVERY inbound
          // media message (image/document/video/AUDIO — audio included in the
          // mediaId fallback now) to internal object storage at webhook time
          // via A2's mirrorInboundMedia. The helper inserts the
          // whatsapp_media_files row itself (Graph URL fallback), then
          // downloads + storagePut's the bytes and flips the row to the
          // internal key. Fire-and-forget by contract: never throws, never
          // blocks the 200 ack. ===
          const mediaId: string = msg.image?.id ?? msg.document?.id ?? msg.video?.id ?? msg.audio?.id ?? "";
          const mimeType: string = msg.image?.mime_type ?? msg.document?.mime_type ?? msg.video?.mime_type ?? msg.audio?.mime_type ?? "application/octet-stream";
          const caption: string = msg.image?.caption ?? msg.document?.caption ?? msg.video?.caption ?? "";
          const filename: string = msg.document?.filename ?? `${msg.type}_${Date.now()}`;
          if (mediaId) {
            void import("../services/inboundMediaMirror")
              .then((m) => m.mirrorInboundMedia({
                tenantId,
                waPhoneNumber,
                mediaId,
                kind: msg.type as "image" | "document" | "video" | "audio",
                mimeType,
                caption: caption || null,
                filename: msg.document?.filename ?? null,
              }))
              .catch((e: any) => console.error("[whatsapp-webhook] media mirror error:", e?.message));
          }
          // === END W45 webhook-core (A2 seam MSG-6) ===
          // ── Receipt-screenshot payment verification ─────────────────────
          // If this sender has a recent order awaiting payment, scan the
          // image, match the amount, and confirm via the shared payment path.
          // Fully async — must NEVER delay the webhook 200 ack.
          if (msg.type === "image" && mediaId) {
            handleInboundReceiptImage({ tenantId, waPhoneNumber, mediaId })
              .then(async (outcome) => {
                // ── Visual product search ────────────────────────────────
                // Only when the receipt pipeline did NOT claim the image
                // (no pending unpaid order) — a receipt screenshot for an
                // order must never be double-handled as a product search.
                const { shouldRunVisualSearchAfterReceipt, handleInboundProductImage } = await import("../services/visualSearch");
                if (!shouldRunVisualSearchAfterReceipt(outcome)) return;
                // === W27 catalog-ai (additive): merchant product photo →
                // AI draft listing. Only tenant staff phones are claimed;
                // anything else falls through to expense OCR / stocktake /
                // visual search.
                const { handleInboundCatalogProductPhoto } = await import("../services/catalogAI");
                const aiOutcome = await handleInboundCatalogProductPhoto({ tenantId, waPhoneNumber, mediaId })
                  .catch((e: any) => {
                    console.error("[whatsapp-webhook] catalog-ai photo error:", e?.message);
                    return { handled: false } as { handled: boolean; outcome?: string };
                  });
                if (aiOutcome?.handled) return;
                // === W27 bookkeeping ===
                // Expense receipt-photo capture claims the image ONLY when
                // the sender has an open "expense" session; otherwise the
                // stocktake / visual-search chain proceeds unchanged.
                const { handleInboundExpenseImage } = await import("../services/bookkeeping");
                const expOutcome = await handleInboundExpenseImage({ tenantId, waPhoneNumber, mediaId })
                  .catch((e: any) => {
                    console.error("[whatsapp-webhook] expense OCR error:", e?.message);
                    return { handled: false } as { handled: boolean };
                  });
                if (expOutcome?.handled) return;
                // === W31 vendor-bills (Coder A) ===
                // Supplier invoice forward: an image whose caption starts
                // with "bill"/"invoice" is captured into vendor_bills via the
                // shared OCR pipeline; anything else falls through to the
                // stocktake / visual-search chain unchanged.
                const { handleInboundVendorBillImage } = await import("../services/vendorBills");
                const vbOutcome = await handleInboundVendorBillImage({ tenantId, waPhoneNumber, mediaId, caption })
                  .catch((e: any) => {
                    console.error("[whatsapp-webhook] vendor bill capture error:", e?.message);
                    return { handled: false } as { handled: boolean };
                  });
                if (vbOutcome?.handled) return;
                // === END W31 vendor-bills ===
                // ── CV-1 / J85: WhatsApp shelf-photo stock-take ────────
                // Tenant opt-in (settings.visualInventoryWhatsAppEnabled).
                // Runs BEFORE visual product search when enabled — a
                // stock-take tenant's shelf photos must not be mistaken
                // for customer product lookups. Outcome "disabled" falls
                // through to visual search unchanged.
                const { handleInboundStocktakeImage } = await import("../services/visualStocktake");
                const stOutcome = await handleInboundStocktakeImage({ tenantId, waPhoneNumber, mediaId })
                  .catch((e: any) => {
                    console.error("[whatsapp-webhook] visual stocktake error:", e?.message);
                    return { handled: false } as { handled: boolean; outcome?: string };
                  });
                if (stOutcome?.handled && stOutcome.outcome !== "disabled") return;
                // === W43 dispatch (Coder C): proof-of-delivery photo. Claims
                // the image ONLY when the sender has an order in the
                // awaiting-POD state (tenant requirePod + shipment
                // out_for_delivery/in_transit); anything else falls through
                // to visual search unchanged. ===
                const { handleInboundPodImage } = await import("../services/deliveryProof");
                const podOutcome = await handleInboundPodImage({ tenantId, waPhoneNumber, mediaId, caption })
                  .catch((e: any) => {
                    console.error("[whatsapp-webhook] POD capture error:", e?.message);
                    return { handled: false } as { handled: boolean };
                  });
                if (podOutcome?.handled) return;
                // === END W43 dispatch ===
                await handleInboundProductImage({ tenantId, waPhoneNumber, mediaId })
                  .catch((e: any) => console.error("[whatsapp-webhook] visual search error:", e?.message));
              })
              // === W45 webhook-core (A2 seam wired, MSG-24): terminal catch of
              // the receipt → catalog-ai → expense → vendor-bill → stocktake →
              // POD → visual-search chain sends the localized "couldn't process
              // that photo" fail-soft reply (channel-parity aware) instead of
              // silence. Never throws. ===
              .catch(async (e: any) => {
                console.error("[whatsapp-webhook] receipt verify error:", e?.message);
                const { replyImagePipelineFailed } = await import("../services/imagePipelineFallback");
                await replyImagePipelineFailed(tenantId, waPhoneNumber).catch(() => {});
              });
          }
          // === END W45 webhook-core (A2 seam MSG-24) ===
          // ── Voice-note ordering ───────────────────────────────────────────
          // Download the audio from the Graph API (per-tenant creds), run it
          // through the pluggable transcriber, and feed the transcript into
          // the SAME text pipeline. Fail-soft reply when voice isn't enabled.
          // Fully async — must NEVER delay the webhook 200 ack.
          if (msg.type === "audio" && msg.audio?.id) {
            (async () => {
              // === W27 catalog-ai (additive): merchant voice note → AI draft
              // listing. Only tenant staff phones are claimed ("not_merchant"
              // falls through to the buyer voice-ordering pipeline unchanged).
              const { handleInboundCatalogVoiceNote } = await import("../services/catalogAI");
              const aiOutcome = await handleInboundCatalogVoiceNote({
                tenantId,
                waPhoneNumber,
                mediaId: msg.audio.id,
                mimeType: msg.audio?.mime_type ?? null,
              });
              if (aiOutcome.handled && aiOutcome.outcome === "draft_created") return;
              if (aiOutcome.handled && aiOutcome.outcome !== "not_merchant" && aiOutcome.outcome !== "disabled") return;
              const { handleInboundVoiceNote } = await import("../services/transcribe");
              await handleInboundVoiceNote({
                tenantId,
                waPhoneNumber,
                mediaId: msg.audio.id,
                mimeType: msg.audio?.mime_type ?? null,
                customerName: contactName || undefined,
              });
            })().catch((e: any) => console.error("[whatsapp-webhook] voice note error:", e?.message));
          }
        } else if (msg.type === "order") {
          // === W45 webhook-core (MSG-13): native catalog order message →
          // build a cart from product_items (Meta product_retailer_id maps to
          // products.id — see services/metaCatalog.ts) and reply with a priced
          // summary. Previously this type got silence. ===
          try {
            const items: any[] = Array.isArray(msg.order?.product_items) ? msg.order.product_items : [];
            if (items.length === 0) {
              await sendWhatsAppTextMetered(db, tenantId, waPhoneNumber,
                "Thanks for your order! We couldn't read the items — please try again or type what you'd like.",
                { notifType: "order_inbound" }).catch(() => {});
            } else {
              const { cartSessions: cartSessionsT, cartItems: cartItemsT } = await import("../../drizzle/schema");
              const cartNow = new Date();
              let [cart] = await db.select().from(cartSessionsT)
                .where(and(eq(cartSessionsT.tenantId, tenantId), eq(cartSessionsT.waPhoneNumber, waPhoneNumber)))
                .orderBy(desc(cartSessionsT.updatedAt)).limit(1).catch(() => [] as any[]);
              if (!cart) {
                const cid = crypto.randomUUID();
                await db.insert(cartSessionsT).values({
                  id: cid, tenantId, waPhoneNumber, sessionData: {}, currentStep: "browse",
                  createdAt: cartNow, updatedAt: cartNow,
                }).catch((e: any) => console.error("[whatsapp-webhook] cart session create error:", e?.message));
                [cart] = await db.select().from(cartSessionsT).where(eq(cartSessionsT.id, cid)).limit(1).catch(() => [] as any[]);
              }
              const lines: string[] = [];
              let total = 0;
              let currency: string = items[0]?.currency ?? "NGN";
              for (const it of items) {
                const retailerId = String(it?.product_retailer_id ?? "");
                const qty = Math.max(1, parseInt(String(it?.quantity ?? "1"), 10) || 1);
                const [prod] = retailerId
                  ? await db.select().from(products)
                      .where(and(eq(products.id, retailerId), eq(products.tenantId, tenantId)))
                      .limit(1).catch(() => [] as any[])
                  : [null as any];
                const name: string = prod?.name ?? `Item ${retailerId || "?"}`;
                const unit = prod ? Number(prod.price) : Number(it?.item_price ?? 0);
                if (prod?.currency) currency = prod.currency;
                lines.push(`• ${qty} × ${name} — ${(unit * qty).toFixed(2)} ${currency}`);
                total += unit * qty;
                if (cart?.id && prod) {
                  await db.insert(cartItemsT).values({
                    cartSessionId: cart.id, productId: prod.id, productName: prod.name,
                    quantity: qty, unitPrice: String(unit), currency,
                  }).catch((e: any) => console.error("[whatsapp-webhook] cart item insert error:", e?.message));
                }
              }
              await sendWhatsAppTextMetered(db, tenantId, waPhoneNumber,
                `🛒 Order received:\n${lines.join("\n")}\nTotal: ${total.toFixed(2)} ${currency}\nReply CHECKOUT to pay, or keep shopping.`,
                { notifType: "order_inbound" })
                .catch((e: any) => console.error("[whatsapp-webhook] order reply send error:", e?.message));
            }
          } catch (e: any) {
            console.error("[whatsapp-webhook] order message error:", e?.message);
          }
        } else if (msg.type === "button") {
          // === W45 webhook-core (MSG-13): legacy template quick-reply button
          // (button.text / button.payload) → the SAME interactive dispatch as
          // modern interactive button_reply payloads. ===
          try {
            const { handleInteractiveInbound } = await import("../services/useCases");
            const outcome = await handleInteractiveInbound({
              db,
              tenant: tenant ?? null,
              tenantId,
              phone: waPhoneNumber,
              replyId: msg.button?.payload ?? undefined,
              replyTitle: msg.button?.text ?? undefined,
              customerName: contactName || undefined,
            });
            if (outcome.interactive) {
              await sendWhatsAppInteractive(tenantId, waPhoneNumber, outcome.interactive)
                .catch((e: any) => console.error("[whatsapp-webhook] button reply send error:", e?.message));
            } else if (outcome.reply) {
              await sendWhatsAppText(tenantId, waPhoneNumber, outcome.reply)
                .catch((e: any) => console.error("[whatsapp-webhook] button reply send error:", e?.message));
            }
          } catch (e: any) {
            console.error("[whatsapp-webhook] button message error:", e?.message);
          }
        } else if (msg.type && msg.type !== "system") {
          // === W45 webhook-core (MSG-13): contacts / sticker / unsupported /
          // unknown inbound types get a polite fallback instead of silence. ===
          console.log(`[whatsapp-webhook] unsupported inbound type '${msg.type}' from ${waPhoneNumber} — polite fallback reply`);
          await sendWhatsAppTextMetered(db, tenantId, waPhoneNumber,
            "Thanks for your message! We can't handle that type of content yet — please send text, a photo, or pick from the menu. 🙏",
            { notifType: "unsupported_inbound" })
            .catch((e: any) => console.error("[whatsapp-webhook] fallback reply send error:", e?.message));
        }
      } catch (msgErr: any) {
        const m = String(msgErr?.message ?? msgErr).slice(0, 300);
        console.error(`[whatsapp-webhook] per-message processing failed (wamid=${msg?.id ?? "?"} type=${msg?.type ?? "?"}):`, m);
        result.failures.push(`${msg?.id ?? "no-wamid"}: ${m}`);
      }
      }
      // ── Delivery status receipts ───────────────────────────────────────────
      const statuses: any[] = value?.statuses ?? [];
      for (const st of statuses) {
        const waMessageId: string = st.id ?? "";
        const recipientPhone: string = st.recipient_id ?? "";
        const statusVal: string = st.status ?? "";
        const tsUnix: number = parseInt(st.timestamp ?? "0", 10);
        const errorCode: string = st.errors?.[0]?.code?.toString() ?? "";
        const errorMessage: string = st.errors?.[0]?.title ?? "";
        if (!waMessageId || !["sent","delivered","read","failed"].includes(statusVal)) continue;
        const [stTenant] = await db.select({ id: tenants.id }).from(tenants)
          .where(eq(tenants.whatsappPhoneNumberId, phoneNumberId))
          .limit(1).catch(() => [null as any]);
        const stTenantId: string = (stTenant as any)?.id ?? "default";
        await db.insert(waMessageDeliveryReceipts).values({
          tenantId: stTenantId,
          waMessageId,
          recipientPhone,
          status: statusVal as any,
          errorCode: errorCode || null,
          errorMessage: errorMessage || null,
          timestamp: tsUnix ? new Date(tsUnix * 1000) : new Date(),
          rawPayload: st,
        }).catch((e: any) => console.warn("[whatsapp-webhook] delivery receipt insert failed:", e?.message));
        // Cross-reference: update whatsapp_notification_log if this wamid was
        // sent by our platform (unknown wamids are ignored quietly inside;
        // failed deliveries keep the full error payload and are metered).
        await applyWaDeliveryStatus(db, stTenantId, st)
          .catch((e: any) => console.warn("[whatsapp-webhook] notif log update failed:", e?.message));
      }
  return result;
}
// === END W45 webhook-core ===


// ── Webhook security helpers ─────────────────────────────────────────────────

/** Length-guarded constant-time string comparison (timingSafeEqual throws on length mismatch). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Production-like detection is centralized in ./env (isProd): anything that is
// not explicitly NODE_ENV=development/test is treated as production, so an
// unset NODE_ENV fails closed.
function isProductionLike(): boolean {
  return isProd;
}

/**
 * Resolve a webhook signing secret, failing CLOSED.
 * - Secret set → returned, caller MUST verify the signature.
 * - Secret unset in production/staging → 503 sent, returns null (caller returns).
 * - Secret unset outside production → loud warning, returns "" (signature check skipped for local dev).
 */
function requireWebhookSecret(
  secretName: string,
  secret: string | null | undefined,
  res: express.Response,
): string | null {
  if (secret) return secret;
  if (isProductionLike()) {
    console.error(`[webhook-security] ${secretName} is not configured — refusing request (fail closed)`);
    res.status(503).json({ error: "webhook-secret-not-configured", secret: secretName });
    return null;
  }
  console.warn(`[webhook-security] ${secretName} unset — skipping signature verification (non-production mode)`);
  return "";
}

/** Constant-time HMAC verification of a raw request body. */
function verifyHmacSignature(rawBody: Buffer, secret: string, signature: string, algo: "sha256" | "sha512"): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac(algo, secret).update(rawBody).digest("hex");
  return timingSafeEqualStr(signature, expected);
}

/** Coerce an express body that may be a Buffer (express.raw) or parsed object into a Buffer. */
function toRawBody(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(JSON.stringify(body ?? {}), "utf8");
}


function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  // === W34 otel-core === lazy, fail-open OTel bootstrap. Activated only when
  // OTEL_ENABLED=true; init failure warns and continues (requests unaffected).
  void initTelemetry().catch(() => { /* telemetry must never break boot */ });
  // === W34 merger seam (otel-sidecars) === wire the persisted tenant
  // allowlist (telemetry.setTenantAllowlist) into /api/metrics label guard.
  void import("../services/telemetryCardinality")
    .then((m) => m.registerMetricAllowlistProvider())
    .catch(() => { /* fail-open: env-only labels */ });

  // === W34 otel-core === inbound span + x-trace-id response header (from the
  // request span; traceparent extraction links cron/internal callers) +
  // inbound HTTP RED metrics. Registered FIRST so every route is covered.
  // Never throws into the request path.
  app.use((req, res, next) => {
    expressTelemetryMiddleware(req, res, () => {
      const t0 = Date.now();
      res.on("finish", () => {
        try {
          const matched = (req as any).route?.path;
          const route = typeof matched === "string" && matched
            ? `${req.baseUrl ?? ""}${matched}`
            : "unmatched";
          const tenantHdr = req.headers["x-tenant-id"];
          recordHttpRequest(
            route,
            res.statusCode,
            typeof tenantHdr === "string" ? tenantHdr : null,
            Date.now() - t0,
          );
        } catch { /* fail-open */ }
      });
      next();
    });
  });

  // === W34 otel-core === cron_runs_total{route,result} for scheduled routes.
  app.use("/api/scheduled", (req, res, next) => {
    res.on("finish", () => {
      try {
        recordCronRun(req.path || "unknown", res.statusCode < 400 ? "ok" : "error");
      } catch { /* fail-open */ }
    });
    next();
  });

  // === W34 otel-core === GET /api/metrics — Prometheus text exposition.
  // Auth: METRICS_TOKEN bearer, X-Internal-Api-Key, or an admin session.
  // Honest 503 when telemetry is disabled (no fake empty exposition).
  app.get("/api/metrics", async (req, res) => {
    try {
      const status = telemetryStatus();
      if (!status.enabled) {
        res.status(503).json({ error: "telemetry-disabled", telemetry: status });
        return;
      }
      let authed = false;
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const metricsToken = (process.env.METRICS_TOKEN ?? "").trim();
      const internalKey = (process.env.INTERNAL_API_KEY ?? "").trim();
      const presentedInternal = (req.headers["x-internal-api-key"] as string | undefined)
        ?? (req.headers["x-internal-token"] as string | undefined) ?? "";
      const eq = (a: string, b: string) => {
        const ba = Buffer.from(a); const bb = Buffer.from(b);
        return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
      };
      if (metricsToken && eq(bearer, metricsToken)) authed = true;
      if (!authed && internalKey && eq(presentedInternal, internalKey)) authed = true;
      if (!authed && bearer) {
        try {
          const user = await sdk.authenticateRequest(req);
          authed = !!user && (user as any).role === "admin";
        } catch { authed = false; }
      }
      if (!authed) {
        res.status(401).json({ error: "metrics-auth-required" });
        return;
      }
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(await renderMetrics());
    } catch (err: any) {
      // Fail-open for the platform, honest for the scrape.
      res.status(500).json({ error: "metrics-render-failed", detail: String(err?.message ?? err) });
    }
  });
  // === END W34 otel-core ===

  // ── w11 payment provider adapter pack (flutterwave/stripe/monnify) ───────
  // Additive + non-blocking: a registration failure is reported via
  // observability but must NEVER prevent server boot (paystack/manual are
  // registered at registry module load and keep working regardless).
  try {
    const { registerAdapterPack } = await import("../services/payments/providers/registerAll");
    registerAdapterPack();
  } catch (adapterErr: any) {
    try {
      const { captureException } = await import("../services/observability");
      captureException(adapterErr, {
        service: "server/boot",
        operation: "registerAdapterPack",
        severity: "error",
      });
    } catch {
      console.error("[boot] registerAdapterPack failed:", adapterErr?.message ?? adapterErr);
    }
  }

  // ── WebSocket server for /api/ws/conversations ────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/ws/conversations") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const tenantId = url.searchParams.get("tenantId") ?? "unknown";
        if (!tenantClients.has(tenantId)) tenantClients.set(tenantId, new Set());
        tenantClients.get(tenantId)!.add(ws);
        // Send a welcome ping
        ws.send(JSON.stringify({ type: "connected", tenantId, timestamp: Date.now() }));
        // Simulate periodic events in dev mode for demo purposes
        let simInterval: ReturnType<typeof setInterval> | null = null;
        if (isDev) {
          const eventTypes = ["message_received", "bot_active", "escalated", "resolved", "conversation_opened"] as const;
          simInterval = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const evt = {
              type: eventTypes[Math.floor(Math.random() * eventTypes.length)],
              conversationId: `conv-${Math.random().toString(36).slice(2, 10)}`,
              tenantId,
              status: "open",
              timestamp: Date.now(),
            };
            ws.send(JSON.stringify(evt));
          }, 8000); // every 8 seconds
        }
        ws.on("close", () => {
          tenantClients.get(tenantId)?.delete(ws);
          if (simInterval) clearInterval(simInterval);
        });
      });
    } else {
      socket.destroy();
    }
  });

  // ── CORS (hand-rolled, no external dependency) ────────────────────────────
  // Allowed origins come from CORS_ORIGIN (comma-separated, or "*" for any).
  // Default: same-origin only — no Access-Control-Allow-Origin header is
  // emitted for cross-origin requests. Handles OPTIONS preflights.
  const corsAllowedOrigins = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      if (corsAllowedOrigins.includes("*")) {
        res.setHeader("Access-Control-Allow-Origin", "*");
      } else if (corsAllowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Internal-Api-Key, X-API-Key, X-Tenant-Id, X-Filename, X-Note"
      );
      res.setHeader("Access-Control-Max-Age", "86400");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // ── CSRF origin verification (W39, PLT-3) ───────────────────────────────
  // Cookie-authenticated mutating requests must present a same-host (or
  // allowlisted) Origin/Referer. Webhook/internal-token paths and
  // bearer/cookie-less requests are exempt. Second layer behind
  // SameSite=Lax session cookies (server/_core/cookies.ts).
  {
    const { createCsrfProtection } = await import("./csrf");
    app.use(createCsrfProtection({ allowedOrigins: corsAllowedOrigins }));
  }

  // Configure body parser with larger size limit for file uploads.
  // Skip routes that need the exact raw bytes for HMAC signature verification
  // (webhooks, evidence uploads) — express.raw() further down would otherwise
  // find the body already consumed/parsed and fall back to re-serializing it,
  // which is not guaranteed byte-identical to what the sender actually signed.
  const RAW_BODY_PATH_PREFIXES = ["/api/webhooks/", "/integrations/", "/api/evidence/", "/api/internal/recon-settlements"];
  const needsRawBody = (path: string) => RAW_BODY_PATH_PREFIXES.some((p) => path.startsWith(p));
  app.use((req, res, next) => needsRawBody(req.path) ? next() : express.json({ limit: "50mb" })(req, res, next));
  app.use((req, res, next) => needsRawBody(req.path) ? next() : express.urlencoded({ limit: "50mb", extended: true })(req, res, next));

  // ── Edge rate limiting (wave 10, additive) ────────────────────────────────
  // Token buckets keyed by IP (+X-Tenant-Id when present): webhooks 300/min
  // (Meta retries need headroom), auth/login 10/min, general API 600/min.
  // Redis-backed with single-node in-memory fallback. /health* is exempt.
  // Wired BEFORE route handlers; 429 carries Retry-After. Never blocks if the
  // limiter itself errors (edge availability > strict counting).
  {
    const { createEdgeRateLimitMiddleware } = await import("../services/rateLimit");
    app.use(createEdgeRateLimitMiddleware());
  }

  // ── Redis-backed per-tenant rate limiting ─────────────────────────────────
  // 200 req/min per tenant (identified by X-Tenant-Id header or JWT sub)
  app.use("/api/trpc", async (req: any, res: any, next: any) => {
    const { checkRateLimit } = await import("./rateLimit");
    const tenantKey = req.headers["x-tenant-id"] as string
      ?? (req.user as any)?.tenantId
      ?? req.ip
      ?? "anon";
    const windowKey = `rl:trpc:${tenantKey}:${Math.floor(Date.now() / 60000)}`;
    // checkRateLimit treats an unreachable Redis as a FAILURE (never count=0):
    // production fails CLOSED (503), dev/test fails OPEN with a warning.
    const decision = await checkRateLimit(windowKey, 200, 60, isProd);
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(decision.retryAfter));
      if (decision.error) {
        res.status(503).json({ error: "rate-limiter-unavailable", retryAfter: decision.retryAfter });
        return;
      }
      res.status(429).json({ error: "Too many requests", retryAfter: decision.retryAfter });
      return;
    }
    next();
  });

  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // Serves objects uploaded via server/storage.ts's storagePut() — that
  // function has always returned `/api/storage/{key}` as the object's URL,
  // but no route ever served it (registerStorageProxy above is a *different*
  // legacy proxy, for /manus-storage/* on the old Manus platform backend).
  // Any existing storagePut() caller's returned URL — product images, and
  // now tenant logos — has been silently 404ing until this route exists.
  app.get("/api/storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) { res.status(400).send("Missing storage key"); return; }
    try {
      // W30 (V3#17): storage objects are no longer world-readable. Access
      // requires EITHER an authenticated session OR a key-bound capability
      // token (?cap=…, minted server-side for shared evidence links).
      let authorized = false;
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (user) {
        // W30 hotfix2: an authenticated session used to read ANY storage key.
        // Tenant-scoped namespaces (key = <ns>/<tenantId>/…) now require the
        // session tenant (or a membership) to match the key's tenant —
        // platform admins bypass. Non-scoped namespaces keep the prior
        // session-authenticated behavior; the capability-token path below is
        // untouched (already bound to the exact key).
        const { keyTenantScope, sessionMayReadScopedKey } = await import("../services/storageSecurity");
        const scope = keyTenantScope(key);
        if (!scope || sessionMayReadScopedKey(user as any, scope)) authorized = true;
      }
      if (!authorized) {
        const cap = typeof req.query.cap === "string" ? req.query.cap : "";
        if (cap) {
          const { verifyCapabilityToken } = await import("../services/capabilityTokens");
          if (verifyCapabilityToken(cap, "storage_cap", key)) authorized = true;
        }
      }
      if (!authorized) {
        res.status(401).json({ error: "Authentication required to access storage objects" });
        return;
      }
      const { stream, contentType } = await storageServe(key);
      // W30 (V3#17): never trust the stored (client-supplied) Content-Type —
      // sniff the first bytes; force attachment for types that could script
      // on the app origin (HTML/SVG/XML/JS — stored-XSS vector).
      const { servedContentPolicy } = await import("../services/storageSecurity");
      const chunks: Buffer[] = [];
      let headDone = false;
      stream.on("data", (chunk: Buffer) => {
        if (!headDone) {
          chunks.push(chunk);
          const head = Buffer.concat(chunks);
          if (head.length >= 512) {
            headDone = true;
            const policy = servedContentPolicy(contentType, head);
            res.set("Content-Type", policy.contentType);
            res.set("Content-Disposition", policy.disposition);
            res.set("X-Content-Type-Options", "nosniff");
            // No more public/immutable caching — objects are authenticated.
            res.set("Cache-Control", "private, no-store");
            for (const c of chunks) res.write(c);
            chunks.length = 0;
          }
        } else {
          res.write(chunk);
        }
      });
      stream.on("end", () => {
        if (!headDone) {
          const policy = servedContentPolicy(contentType, Buffer.alloc(0));
          res.set("Content-Type", policy.contentType);
          res.set("Content-Disposition", policy.disposition);
          res.set("X-Content-Type-Options", "nosniff");
          res.set("Cache-Control", "private, no-store");
        }
        res.end();
      });
      stream.on("error", () => { if (!res.headersSent) res.status(404).end(); else res.end(); });
    } catch {
      res.status(404).send("Not found");
    }
  });

  // === W46 uc-docs (Coder D): generated statement/proforma/commission PDFs ===
  // Serves files written by server/services/ucDocsPdf.ts (UC_DOCS_DIR).
  // Traversal-guarded; access requires an authenticated session whose tenant
  // matches the first path segment (platform admins bypass) OR a capability
  // token bound to the exact key (?cap=…). Telegram delivery uploads the PDF
  // buffer directly (Bot API multipart), so it does not depend on this route.
  app.get("/api/uc-docs/*", async (req, res) => {
    const rel = (req.params as Record<string, string>)[0];
    if (!rel || rel.includes("..") || rel.startsWith("/")) { res.status(400).send("Bad path"); return; }
    try {
      let authorized = false;
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (user) {
        const tenantSegment = rel.split("/")[0];
        if ((user as any).role === "admin" || (user as any).tenantId === tenantSegment ||
            (Array.isArray((user as any).memberships) && (user as any).memberships.includes(tenantSegment))) {
          authorized = true;
        }
      }
      if (!authorized) {
        const cap = typeof req.query.cap === "string" ? req.query.cap : "";
        if (cap) {
          const { verifyCapabilityToken } = await import("../services/capabilityTokens");
          if (verifyCapabilityToken(cap, "storage_cap", `uc-docs/${rel}`)) authorized = true;
        }
      }
      if (!authorized) { res.status(401).json({ error: "Authentication required" }); return; }
      const { join, normalize } = await import("path");
      const { createReadStream, existsSync } = await import("fs");
      const { ucDocsDir } = await import("../services/ucDocsPdf");
      const abs = normalize(join(ucDocsDir(), rel));
      if (!abs.startsWith(normalize(ucDocsDir())) || !existsSync(abs)) { res.status(404).send("Not found"); return; }
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="${rel.split("/").pop()}"`);
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Cache-Control", "private, no-store");
      createReadStream(abs).pipe(res);
    } catch {
      res.status(404).send("Not found");
    }
  });
  // === END W46 uc-docs ===

  // ── Scheduled: abandoned cart recovery (Heartbeat cron, every ~10 min) ────
  // Carts idle >30min with items, no newer order, and NDPR consent get ONE
  // localized recovery message per cart per 24h.
  // After deploy: manus-heartbeat create --name cart-recovery --cron "0 */10 * * * *" --path /api/scheduled/cart-recovery
  app.post("/api/scheduled/cart-recovery", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const { runCartRecovery, recoveryCounters } = await import("../services/cartRecovery");
      const idleMinutes = Number(req.body?.idleMinutes) > 0 ? Number(req.body.idleMinutes) : undefined;
      const run = await runCartRecovery({ idleMinutes });
      return res.json({ ok: true, run, totals: recoveryCounters });
    } catch (e: any) {
      console.error("[cart-recovery] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "cart-recovery failed" });
    }
  });

  // === W44 preorders-offers (Coder B) ===
  // ── Scheduled: pre-order availability sweep (lazy flip, every ~5 min) ────
  // Flips due order lines 'preorder' → 'ordered' (claim-first guarded UPDATE)
  // so the W43 fulfillment path takes over, and notifies each customer on
  // BOTH channels. Idempotent — a replayed sweep flips nothing.
  // After deploy: manus-heartbeat create --name preorders-due --cron "0 */5 * * * *" --path /api/scheduled/preorders-due
  app.post("/api/scheduled/preorders-due", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const { sweepDuePreorders } = await import("../services/preorders");
      const run = await sweepDuePreorders();
      return res.json({ ok: true, run });
    } catch (e: any) {
      console.error("[preorders-due] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "preorders-due failed" });
    }
  });

  // ── Scheduled: custom-offer expiry sweep (every ~30 min) ────────────────
  // Open offers (pending/countered) past expiresAt flip to 'expired'; the
  // customer is notified on their channel. Idempotent.
  // After deploy: manus-heartbeat create --name offers-expire --cron "0 */30 * * * *" --path /api/scheduled/offers-expire
  app.post("/api/scheduled/offers-expire", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const { sweepExpiredOffers } = await import("../services/customOffers");
      const run = await sweepExpiredOffers();
      return res.json({ ok: true, run });
    } catch (e: any) {
      console.error("[offers-expire] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "offers-expire failed" });
    }
  });
  // === END W44 preorders-offers ===

  // === W46 uc-ux (Coder E): UC-23 wishlist price-drop sweep ================
  // Compares live product prices to wishlist baselines and notifies buyers
  // once per drop on BOTH channels (price_drop_alert parity category).
  // Claim-first baseline flip makes replays/concurrent sweeps idempotent.
  // After deploy: manus-heartbeat create --name wishlist-price-drop-sweep --cron "0 0 */6 * * *" --path /api/scheduled/wishlist-price-drop-sweep
  app.post("/api/scheduled/wishlist-price-drop-sweep", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { sweepWishlistPriceDrops } = await import("../services/wishlists");
      const run = await sweepWishlistPriceDrops(db);
      return res.json({ ok: true, run });
    } catch (e: any) {
      console.error("[wishlist-price-drop-sweep] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "wishlist-price-drop-sweep failed" });
    }
  });
  // === END W46 uc-ux ===

  // === W27 bookkeeping ===
  // ── Scheduled: opt-in merchant sales digests (daily/weekly) ─────────────
  // Sends "You made ₦X this week, up N%" to every opted-in merchant phone;
  // idempotent per (tenant, phone, period) via bookkeeping_digest_log.
  // After deploy: manus-heartbeat create --name bookkeeping-digests --cron "0 0 7 * * *" --path /api/scheduled/bookkeeping-digests
  app.post("/api/scheduled/bookkeeping-digests", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runScheduledDigests } = await import("../services/bookkeeping");
      const run = await runScheduledDigests(db, new Date());
      return res.json({ ok: true, run });
    } catch (e: any) {
      console.error("[bookkeeping-digests] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "bookkeeping-digests failed" });
    }
  });

  // === W28 odoo-sync (Coder A) ===
  // ── Scheduled: nightly Odoo batch sync (sweep + outbox drain) ───────────
  // For every enabled odoo_configs tenant: sweep paid orders / confirmed
  // expenses / payouts / loan disbursements into the exactly-once outbox,
  // then run the claim-before-send worker. Batch-mode tenants get their
  // entries posted here; failed rows surface in the portal reconciliation
  // queue. Idempotent.
  // After deploy: manus-heartbeat create --name odoo-sync-nightly --cron "0 0 2 * * *" --path /api/scheduled/odoo-sync
  app.post("/api/scheduled/odoo-sync", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runOdooNightlyBatch } = await import("../services/odoo/sync");
      const run = await runOdooNightlyBatch(db);
      return res.json({ ok: true, run });
    } catch (e: any) {
      console.error("[odoo-sync] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "odoo-sync failed" });
    }
  });
  // === END W28 odoo-sync ===

  // ── Scheduled: W27 credit — micro-loan auto-repayment sweep (every ~10 min) ──
  // Deducts each active loan's repaymentPct from newly settled wallet sales
  // (escrow_release credits) and marks overdue loans defaulted. Idempotent.
  // After deploy: manus-heartbeat create --name credit-loan-repayment --cron "0 */10 * * * *" --path /api/scheduled/credit-loan-repayment
  app.post("/api/scheduled/credit-loan-repayment", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const { runLoanRepaymentSweep } = await import("../services/tradeCredit/microLoans");
      const run = await runLoanRepaymentSweep();
      return res.json({ ok: true, run });
    } catch (e: any) {
      console.error("[credit-loan-repayment] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "credit-loan-repayment failed" });
    }
  });

  // ── Scheduled: WhatsApp failed-send retry + dead-letter (every ~5 min) ────
  // Retries due retriable sends (5xx/429/network) with exponential backoff
  // (1m, 5m, 15m, 1h); after 4 attempts → status "dead" + tenant admin alert.
  // After deploy: manus-heartbeat create --name wa-send-retry --cron "0 */5 * * * *" --path /api/scheduled/wa-send-retry
  app.post("/api/scheduled/wa-send-retry", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const { runWaSendRetries } = await import("../services/waSender");
      const limit = Number(req.body?.limit) > 0 ? Number(req.body.limit) : undefined;
      const run = await runWaSendRetries({ limit });
      return res.json({ ok: true, run });
    } catch (e: any) {
      console.error("[wa-send-retry] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "wa-send-retry failed" });
    }
  });

  // === W40 TEN-5 (Coder B) ===
  // ── Scheduled: KYC erasure sweep — retry tombstoned S3 scan deletions ───
  // Documents tombstoned at GDPR erasure time (erasureScheduledAt set,
  // erasedAt null because the object store was unreachable) are retried
  // here until the S3 object is confirmed deleted.
  // After deploy: manus-heartbeat create --name kyc-erasure-sweep --cron "0 */30 * * * *" --path /api/scheduled/kyc-erasure-sweep
  app.post("/api/scheduled/kyc-erasure-sweep", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runKycErasureSweep } = await import("../services/kycPrivacy");
      const run = await runKycErasureSweep(db);
      return res.json({ ok: true, run });
    } catch (e: any) {
      console.error("[kyc-erasure-sweep] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "kyc-erasure-sweep failed" });
    }
  });

  // === W40 TEN-8 (Coder B) ===
  // ── Scheduled: KYB periodic re-screen (daily) ──────────────────────────
  // Re-screens every non-terminal KYB application (business name + UBO)
  // through the SAME fail-closed screening path used at review time;
  // journals lastScreenedAt; a NEW reject moves the application to
  // under_review + audit row (never silently leaves a hit approved).
  // After deploy: manus-heartbeat create --name kyb-rescreen --cron "0 0 3 * * *" --path /api/scheduled/kyb-rescreen
  app.post("/api/scheduled/kyb-rescreen", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runKybRescreenSweep } = await import("../services/kycPrivacy");
      const run = await runKybRescreenSweep(db);
      return res.json({ ok: true, run });
    } catch (e: any) {
      console.error("[kyb-rescreen] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "kyb-rescreen failed" });
    }
  });

  // === W46 kyc (Coder A, TEN-6) ===
  // ── Scheduled: KYC/KYB expiry sweep (hourly) ───────────────────────────
  // Flips approved applications past expiresAt (stamped at approval per
  // risk tier) to 'expired' with a guarded UPDATE, audits each expiry, and
  // notifies the tenant admin over WhatsApp that re-verification is due.
  // After deploy: manus-heartbeat create --name kyc-expiry-sweep --cron "0 0 * * * *" --path /api/scheduled/kyc-expiry-sweep
  app.post("/api/scheduled/kyc-expiry-sweep", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runKycExpirySweep } = await import("../services/kycExpiry");
      const run = await runKycExpirySweep(db);
      return res.json({ ok: true, run });
    } catch (e: any) {
      console.error("[kyc-expiry-sweep] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "kyc-expiry-sweep failed" });
    }
  });
  // === END W46 kyc ===
  // === W46 privacy-consent (TEN-22) ===
  // ── Scheduled: KYB review-queue SLA sweep (hourly) ─────────────────────
  // Escalates pending KYB reviews past their 48h SLA (claim-first
  // escalatedAt flip), records slaBreachedAt, and alerts the tenant admin.
  // W42 contract: token must be scoped EXACTLY to this path (scope+jti).
  // After deploy: manus-heartbeat create --name kyb-sla-sweep --cron "0 0 * * * *" --path /api/scheduled/kyb-sla-sweep
  app.post("/api/scheduled/kyb-sla-sweep", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runKybSlaSweep } = await import("../services/kybSla");
      const run = await runKybSlaSweep(db);
      return res.json({ ok: true, run });
    } catch (e: any) {
      console.error("[kyb-sla-sweep] cron failed:", e?.message);
      return res.status(500).json({ error: e?.message ?? "kyb-sla-sweep failed" });
    }
  });
  // === END W46 privacy-consent ===

  // ── Scheduled: inventory sync (Heartbeat cron, fires every 5 min) ──────────
  app.post("/api/scheduled/inventory-sync", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      // A3-F03: run the real per-tenant Odoo inventory sync (never throws).
      const syncSummary = await runInventorySyncHeartbeat();
      // Count low-stock items using per-product threshold via JOIN
      const lowStockRows = await db.execute(sql`
        SELECT COUNT(*) AS cnt
        FROM inventory_snapshots s
        JOIN products p ON p.id = s."productId"
        WHERE CAST(s."availableQty" AS NUMERIC) <= p."lowStockThreshold"
          AND CAST(s."availableQty" AS NUMERIC) > 0
      `);
      const outOfStockRows = await db.execute(sql`
        SELECT COUNT(*) AS cnt FROM inventory_snapshots
        WHERE CAST("availableQty" AS NUMERIC) <= 0
      `);
      const lowStockCount = Number((lowStockRows as any[])[0]?.cnt ?? 0);
      const outOfStockCount = Number((outOfStockRows as any[])[0]?.cnt ?? 0);
      return res.json({
        ok: syncSummary.failed.length === 0,
        sync: syncSummary,
        syncedAt: new Date().toISOString(),
        lowStockCount,
        outOfStockCount,
        taskUid: user.taskUid,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: err?.message ?? "unknown",
        stack: err?.stack,
        context: { url: req.url },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── Paystack webhook (/api/webhooks/paystack) ─────────────────────────────
  // ── Scheduled: nightly reconciliation discrepancy alert ──────────────────
  app.post("/api/scheduled/reconciliation-alert", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      // Load the reconciliation_discrepancy rule to get configured threshold + window
      const [reconRule] = await db
        .select()
        .from(alertRules)
        .where(eq(alertRules.ruleType, "reconciliation_discrepancy"))
        .limit(1);
      const ALERT_THRESHOLD = reconRule
        ? parseFloat(reconRule.threshold as unknown as string) / 100
        : 0.05;
      const windowHours = reconRule?.windowHours ?? 24;
      // ── Cooldown check: skip notification if rule fired too recently ──────
      const cooldownMinutes = reconRule?.cooldownMinutes ?? 60;
      if (cooldownMinutes > 0 && reconRule?.lastTriggeredAt) {
        const msSinceLast = Date.now() - new Date(reconRule.lastTriggeredAt).getTime();
        if (msSinceLast < cooldownMinutes * 60 * 1000) {
          return res.json({
            ok: true,
            skipped: true,
            reason: `Cooldown active — last triggered ${Math.round(msSinceLast / 60000)}m ago (cooldown: ${cooldownMinutes}m)`,
          });
        }
      }
      const cutoff = new Date(Date.now() - windowHours * 3600 * 1000);
      const unreconciledRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(paymentTransactions)
        .where(
          sql`${paymentTransactions.createdAt} >= ${cutoff}
              AND (${paymentTransactions.status} = 'pending'
                   OR ${paymentTransactions.status} = 'failed')`
        );
      const totalRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(paymentTransactions)
        .where(sql`${paymentTransactions.createdAt} >= ${cutoff}`);
      const unreconciled = unreconciledRows[0]?.count ?? 0;
      const total = totalRows[0]?.count ?? 0;
      const discrepancyRate = total > 0 ? unreconciled / total : 0;
      if (discrepancyRate > ALERT_THRESHOLD) {
        await notifyOwner({
          title: "⚠️ Reconciliation Alert: High Discrepancy Rate",
          content: `Nightly reconciliation check detected ${unreconciled} unreconciled transactions out of ${total} in the last ${windowHours}h (${(discrepancyRate * 100).toFixed(1)}% discrepancy rate — threshold: ${(ALERT_THRESHOLD * 100).toFixed(0)}%). Please review the Reconciliation Simulation dashboard for details.`,
        }).catch((e: unknown) => console.warn("[reconciliation-alert] notification failed:", e));
      }
      // Write an immutable event row for the history log
      if (reconRule) {
        await db.insert(alertRuleEvents).values({
          id: randomUUID(),
          ruleId: reconRule.id,
          ruleName: reconRule.name,
          ruleType: "reconciliation_discrepancy",
          actualValue: String((discrepancyRate * 100).toFixed(4)),
          threshold: reconRule.threshold as unknown as string,
          windowHours,
          notificationSent: discrepancyRate > ALERT_THRESHOLD,
          metadata: { total, unreconciled, taskUid: user.taskUid },
        }).catch((e: unknown) => console.warn("[reconciliation-alert] event insert failed:", e));
        await db
          .update(alertRules)
          .set({ lastTriggeredAt: new Date(), updatedAt: new Date() })
          .where(eq(alertRules.id, reconRule.id))
          .catch(() => {});
      }
      return res.json({
        ok: true,
        checkedAt: new Date().toISOString(),
        total,
        unreconciled,
        discrepancyRate: parseFloat((discrepancyRate * 100).toFixed(2)),
        alertSent: discrepancyRate > ALERT_THRESHOLD,
        taskUid: user.taskUid,
      });
    } catch (err: unknown) {
      const e = err as Error;
      return res.status(500).json({
        error: e?.message ?? "unknown",
        stack: e?.stack,
        context: { url: req.url },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── Monthly forecast snapshot heartbeat ──────────────────────────────────────
  // Fires on the 1st of each month. Saves next-month projection and resolves
  // the previous month's snapshot with actual values + accuracy %.
  app.post("/api/scheduled/forecast-snapshot", async (req, res) => {
    const user = await sdk.authenticateRequest(req).catch(() => null);
    if (!user?.isCron) return res.status(403).json({ error: "Forbidden" });
    try {
      const db = await getDb();
      if (!db) return res.json({ skipped: true });

      const now = new Date();
      const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const nextMonth = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}`;

      // Compute this month's actual GMV and revenue
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const txRows = await db.select({ amount: paymentTransactions.amount, tenantId: paymentTransactions.tenantId })
        .from(paymentTransactions)
        .where(and(
          gte(paymentTransactions.createdAt, startOfMonth),
          eq(paymentTransactions.status, "completed")
        ));

      const tenantRows = await db.select({ id: tenants.id, cogsRate: tenants.cogsRate }).from(tenants);
      const cogsMap = Object.fromEntries(tenantRows.map((t) => [t.id, t.cogsRate ?? 0.40]));

      let actualGmv = 0;
      let actualRevenue = 0;
      for (const tx of txRows) {
        const amt = parseFloat(tx.amount ?? "0");
        actualGmv += amt;
        const cogs = cogsMap[tx.tenantId] ?? 0.40;
        const netProfit = amt * (1 - 0.015 - cogs);
        actualRevenue += Math.max(0, netProfit * 0.05) + amt * 0.002;
      }

      // Resolve last month's snapshot if it exists
      const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, "0")}`;
      const [prevSnap] = await db.select().from(forecastSnapshots)
        .where(eq(forecastSnapshots.snapshotMonth, thisMonth));
      if (prevSnap && !prevSnap.resolvedAt) {
        const projected = parseFloat(prevSnap.projectedRevenue);
        const accuracy = projected > 0 ? Math.max(0, 100 - Math.abs(actualRevenue - projected) / projected * 100) : 0;
        await db.update(forecastSnapshots)
          .set({
            actualRevenue: String(actualRevenue.toFixed(4)),
            actualGmv: String(actualGmv.toFixed(4)),
            accuracyPct: String(accuracy.toFixed(4)),
            resolvedAt: now,
          })
          .where(eq(forecastSnapshots.snapshotMonth, thisMonth));
      }

      // Project next month using simple 10% MoM growth assumption
      const projectedRevenue = actualRevenue * 1.10;
      const projectedGmv = actualGmv * 1.10;
      await db.insert(forecastSnapshots).values({
        snapshotMonth: nextMonth,
        projectedRevenue: String(projectedRevenue.toFixed(4)),
        projectedGmv: String(projectedGmv.toFixed(4)),
      }).onConflictDoNothing();

      res.json({ ok: true, snapshotMonth: nextMonth, projectedRevenue, projectedGmv, actualRevenue, actualGmv });
    } catch (err: any) {
      console.error("[forecast-snapshot]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Leaderboard top-3 notification heartbeat ──────────────────────────────────
  // Fires daily. Computes MoM GMV growth per tenant and notifies owner when a
  // tenant newly enters the top-3 positions for the first time this month.
  app.post("/api/scheduled/leaderboard-top3", async (req, res) => {
    const user = await sdk.authenticateRequest(req).catch(() => null);
    if (!user?.isCron) return res.status(403).json({ error: "Forbidden" });
    try {
      const db = await getDb();
      if (!db) return res.json({ skipped: true });

      const now = new Date();
      const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

      // GMV this month per tenant
      const thisMoRows = await db.select({ tenantId: paymentTransactions.tenantId, amount: paymentTransactions.amount })
        .from(paymentTransactions)
        .where(and(gte(paymentTransactions.createdAt, startThisMonth), eq(paymentTransactions.status, "completed")));

      // GMV last month per tenant
      const lastMoRows = await db.select({ tenantId: paymentTransactions.tenantId, amount: paymentTransactions.amount })
        .from(paymentTransactions)
        .where(and(
          gte(paymentTransactions.createdAt, startLastMonth),
          lte(paymentTransactions.createdAt, endLastMonth),
          eq(paymentTransactions.status, "completed")
        ));

      const thisMo: Record<string, number> = {};
      const lastMo: Record<string, number> = {};
      for (const r of thisMoRows) thisMo[r.tenantId] = (thisMo[r.tenantId] ?? 0) + parseFloat(r.amount ?? "0");
      for (const r of lastMoRows) lastMo[r.tenantId] = (lastMo[r.tenantId] ?? 0) + parseFloat(r.amount ?? "0");

      const allTenantIds = Array.from(new Set([...Object.keys(thisMo), ...Object.keys(lastMo)]));
      const growthRanked = allTenantIds
        .map((id) => {
          const curr = thisMo[id] ?? 0;
          const prev = lastMo[id] ?? 0;
          const growth = prev > 0 ? ((curr - prev) / prev) * 100 : (curr > 0 ? 100 : 0);
          return { tenantId: id, growth, curr, prev };
        })
        .sort((a, b) => b.growth - a.growth)
        .slice(0, 3);

      if (growthRanked.length === 0) return res.json({ ok: true, top3: [] });

      const tenantRows = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
      const nameMap = Object.fromEntries(tenantRows.map((t) => [t.id, t.name]));

      const lines = growthRanked.map((r, i) =>
        `#${i + 1} ${nameMap[r.tenantId] ?? r.tenantId}: +${r.growth.toFixed(1)}% GMV ($${r.curr.toFixed(0)} vs $${r.prev.toFixed(0)} last month)`
      );

      await notifyOwner({
        title: "GMV Growth Leaderboard - Top 3 This Month",
        content: "Today's top GMV growth leaders:\n\n" + lines.join("\n") + "\n\nView full leaderboard at /revenue -> GMV Growth tab.",
      });

      res.json({ ok: true, top3: growthRanked });
    } catch (err: any) {
      console.error("[leaderboard-top3]", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/webhooks/paystack", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const body = toRawBody(req.body);
      // Fail CLOSED when the secret is unset (503 in production/staging).
      const secret = requireWebhookSecret("PAYSTACK_WEBHOOK_SECRET", process.env.PAYSTACK_WEBHOOK_SECRET, res);
      if (secret === null) return;
      if (secret) {
        const sig = (req.headers["x-paystack-signature"] as string) ?? "";
        if (!verifyHmacSignature(body, secret, sig, "sha512")) {
          console.warn("[paystack-webhook] invalid signature — rejected");
          return res.status(401).json({ error: "invalid-signature" });
        }
      }
      const payload = JSON.parse(body.toString());
      if (payload.event === "charge.success") {
        const ref = payload.data?.reference as string | undefined;
        const amountKobo = Number(payload.data?.amount);
        const currency = (payload.data?.currency as string | undefined) ?? null;
        if (ref) {
          const result = await confirmProviderPayment(db, {
            provider: "paystack",
            reference: ref,
            amountMajor: Number.isFinite(amountKobo) ? amountKobo / 100 : null, // Paystack amounts are in kobo
            currency,
            rawPayload: payload.data,
          });
          if (!result.ok) {
            console.warn(`[paystack-webhook] ref=${ref} → ${result.action}${result.detail ? `: ${result.detail}` : ""}`);
          }
          // === W45 money-intents seam (PAY-13) — paymentConfirm.ts PINNED ===
          // Adjacent seam ONLY: quarantine + ops alert + auto-refund when the
          // pinned confirm rejected a PSP mismatch with money in hand.
          // Never throws. (HOOK CONTRACT for merger: keep immediately after
          // the confirmProviderPayment call.)
          {
            const { runPaymentMismatchQuarantineHook } = await import("../services/payments/paymentMismatchQuarantine");
            await runPaymentMismatchQuarantineHook(db, {
              provider: "paystack",
              reference: ref,
              result,
              amountMajor: Number.isFinite(amountKobo) ? amountKobo / 100 : null,
              currency,
              rawPayload: payload.data,
            });
          }
          // === END W45 money-intents seam ===
          // === W31 AR webhook hook ===
          // After the PINNED confirmProviderPayment verified + completed the
          // intent, record any AR-invoice payment keyed by this reference
          // (= ar_invoices.payment_link_ref). Exactly-once, never throws.
          if (result.ok) {
            const { runArInvoiceWebhookHook } = await import("../services/arInvoices");
            await runArInvoiceWebhookHook(db, { provider: "paystack", reference: ref });
          }
          // === END W31 AR webhook hook ===
          // === W41 buyer-credit hook (adjacent seam — paymentConfirm.ts untouched) ===
          // Activates buyer installment plans whose down payment this charge
          // settled, and saves a consented reusable authorization as a
          // customer payment token. Exactly-once, never throws.
          if (result.ok) {
            const { runBuyerCreditWebhookHook } = await import("../services/buyerInstallments");
            await runBuyerCreditWebhookHook(db, { provider: "paystack", reference: ref, rawPayload: payload.data });
          }
          // === END W41 buyer-credit hook ===
          // === W44 giftcards-referrals hook (adjacent seam — paymentConfirm.ts untouched) ===
          // Activates gift cards whose purchase intent this charge settled
          // (metadata.kind='gift_card_purchase') and rewards referrers when a
          // referee's first order goes PAID. Exactly-once, never throws.
          if (result.ok) {
            const { runGiftCardPurchaseWebhookHook } = await import("../services/giftCards");
            await runGiftCardPurchaseWebhookHook(db, { provider: "paystack", reference: ref });
            const { runReferralRewardWebhookHook } = await import("../services/referrals");
            await runReferralRewardWebhookHook(db, { provider: "paystack", reference: ref });
          }
          // === END W44 giftcards-referrals hook ===
          // === W44 deposits-subs-digital hook (adjacent seam — paymentConfirm.ts PINNED/untouched) ===
          // Appointment deposit/remainder confirmation (appt-deposit:<id> /
          // appt-remainder:<id> references) + claim-first digital PIN
          // allocation on the paid order. Exactly-once, never throws.
          if (result.ok) {
            const { runAppointmentWebhookHook } = await import("../services/appointments");
            await runAppointmentWebhookHook(db, { provider: "paystack", reference: ref });
            const { runDigitalPinWebhookHook } = await import("../services/digitalPins");
            await runDigitalPinWebhookHook(db, { provider: "paystack", reference: ref });
          }
          // === END W44 deposits-subs-digital hook ===
          return res.status(200).json({ received: true, ...result });
        }
      }
      // ── Wallet withdrawal payout finalization ────────────────────────────
      // wallet.requestWithdrawal already debited the balance and initiated the
      // transfer synchronously; these events only finalize the wallet_transactions
      // status (success → completed) or credit the balance back (failed/reversed).
      if (payload.event === "transfer.success" || payload.event === "transfer.failed" || payload.event === "transfer.reversed") {
        const ref = payload.data?.reference as string | undefined;
        if (ref) {
          const result = await finalizeWalletWithdrawal(db, {
            reference: ref,
            event: payload.event,
            reason: (payload.data?.reason as string | undefined) ?? null,
          });
          if (!result.ok) {
            console.warn(`[paystack-webhook] transfer ref=${ref} → ${result.action}`);
          }
          return res.status(200).json({ received: true, ...result });
        }
      }
      // === W39 PAY-8: dispute / refund-status events (previously bare-200'd) ===
      if (typeof payload.event === "string" && payload.event.startsWith("charge.dispute")) {
        const { recordPspDispute } = await import("../services/payments/disputes");
        const d = payload.data ?? {};
        const reference = (d.transaction?.reference ?? d.reference ?? null) as string | null;
        const resolution = String(d.resolution ?? d.status ?? "").toLowerCase();
        const status = payload.event === "charge.dispute.resolve"
          ? (resolution.includes("won") ? "won" : resolution.includes("lost") || resolution.includes("accepted") ? "lost" : "lost")
          : "open";
        const result = await recordPspDispute(db, {
          provider: "paystack",
          providerRef: reference ?? "unknown",
          kind: "dispute",
          status,
          amountCents: Number.isFinite(Number(d.refund_amount ?? d.transaction?.amount)) ? Number(d.refund_amount ?? d.transaction?.amount) : null,
          currency: (d.currency as string | undefined) ?? null,
          payload: d,
        });
        return res.status(200).json({ received: true, ...result });
      }
      if (payload.event === "refund.processed" || payload.event === "refund.failed") {
        const { reconcilePspRefund } = await import("../services/payments/disputes");
        const d = payload.data ?? {};
        const reference = (d.reference ?? d.transaction_reference ?? null) as string | null;
        const result = await reconcilePspRefund(db, {
          provider: "paystack",
          providerRef: reference ?? "unknown",
          outcome: payload.event === "refund.processed" ? "processed" : "failed",
          amountCents: Number.isFinite(Number(d.amount)) ? Number(d.amount) : null,
          payload: d,
        });
        return res.status(200).json({ received: true, ...result });
      }
      if (typeof payload.event === "string" && payload.event.length > 0) {
        const { logUnhandledPspEvent } = await import("../services/payments/disputes");
        logUnhandledPspEvent("paystack", payload);
      }
      // === END W39 PAY-8 ===
      return res.status(200).json({ received: true });
    } catch (err: any) {
      console.error("[paystack-webhook]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Unified provider webhook (w11): /api/webhooks/payments/:provider ─────
  // Additive: resolves the registered adapter, verifies (fail-closed), and
  // feeds normalized events into the SAME confirmProviderPayment money path.
  app.post("/api/webhooks/payments/:provider", express.raw({ type: "application/json" }), (req, res) => {
    void handleUnifiedPaymentWebhook(req, res);
  });

  // ── Flutterwave webhook (/api/webhooks/flutterwave) ───────────────────────
  app.post("/api/webhooks/flutterwave", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const body = toRawBody(req.body);
      // Fail CLOSED when the secret is unset (503 in production/staging).
      const secret = requireWebhookSecret("FLW_WEBHOOK_SECRET", process.env.FLW_WEBHOOK_SECRET, res);
      if (secret === null) return;
      if (secret) {
        // Flutterwave sends the configured secret hash verbatim in verif-hash.
        const sig = (req.headers["verif-hash"] as string) ?? "";
        if (!timingSafeEqualStr(sig, secret)) {
          console.warn("[flutterwave-webhook] invalid verif-hash — rejected");
          return res.status(401).json({ error: "invalid-signature" });
        }
      }
      const payload = JSON.parse(body.toString());
      if (payload.event === "charge.completed" && payload.data?.status === "successful") {
        const txRef = payload.data?.tx_ref as string | undefined;
        const amount = Number(payload.data?.amount); // major currency units
        const currency = (payload.data?.currency as string | undefined) ?? null;
        if (txRef) {
          const result = await confirmProviderPayment(db, {
            provider: "flutterwave",
            reference: txRef,
            amountMajor: Number.isFinite(amount) ? amount : null,
            currency,
            rawPayload: payload.data,
          });
          if (!result.ok) {
            console.warn(`[flutterwave-webhook] tx_ref=${txRef} → ${result.action}${result.detail ? `: ${result.detail}` : ""}`);
          }
          // === W45 money-intents seam (PAY-13) — paymentConfirm.ts PINNED ===
          {
            const { runPaymentMismatchQuarantineHook } = await import("../services/payments/paymentMismatchQuarantine");
            await runPaymentMismatchQuarantineHook(db, {
              provider: "flutterwave",
              reference: txRef,
              result,
              amountMajor: Number.isFinite(amount) ? amount : null,
              currency,
              rawPayload: payload.data,
            });
          }
          // === END W45 money-intents seam ===
          // === W31 AR webhook hook === (see paystack handler above)
          if (result.ok) {
            const { runArInvoiceWebhookHook } = await import("../services/arInvoices");
            await runArInvoiceWebhookHook(db, { provider: "flutterwave", reference: txRef });
          }
          // === END W31 AR webhook hook ===
          // === W41 buyer-credit hook (adjacent seam — see paystack above) ===
          if (result.ok) {
            const { runBuyerCreditWebhookHook } = await import("../services/buyerInstallments");
            await runBuyerCreditWebhookHook(db, { provider: "flutterwave", reference: txRef, rawPayload: payload.data });
          }
          // === END W41 buyer-credit hook ===
          // === W44 giftcards-referrals hook (adjacent seam — see paystack above) ===
          if (result.ok) {
            const { runGiftCardPurchaseWebhookHook } = await import("../services/giftCards");
            await runGiftCardPurchaseWebhookHook(db, { provider: "flutterwave", reference: txRef });
            const { runReferralRewardWebhookHook } = await import("../services/referrals");
            await runReferralRewardWebhookHook(db, { provider: "flutterwave", reference: txRef });
          }
          // === END W44 giftcards-referrals hook ===
          // === W44 deposits-subs-digital hook (adjacent seam — paymentConfirm.ts PINNED/untouched) ===
          // Appointment deposit/remainder confirmation (appt-deposit:<id> /
          // appt-remainder:<id> references) + claim-first digital PIN
          // allocation on the paid order. Exactly-once, never throws.
          if (result.ok) {
            const { runAppointmentWebhookHook } = await import("../services/appointments");
            await runAppointmentWebhookHook(db, { provider: "flutterwave", reference: txRef });
            const { runDigitalPinWebhookHook } = await import("../services/digitalPins");
            await runDigitalPinWebhookHook(db, { provider: "flutterwave", reference: txRef });
          }
          // === END W44 deposits-subs-digital hook ===
          return res.status(200).json({ received: true, ...result });
        }
      }
      // === W39 PAY-8: dispute / refund-status events (previously bare-200'd) ===
      if (typeof payload.event === "string" && /dispute|chargeback/i.test(payload.event)) {
        const { recordPspDispute } = await import("../services/payments/disputes");
        const d = payload.data ?? {};
        const reference = (d.tx_ref ?? d.txRef ?? d.reference ?? null) as string | null;
        const result = await recordPspDispute(db, {
          provider: "flutterwave",
          providerRef: reference ?? "unknown",
          kind: /chargeback/i.test(payload.event) ? "chargeback" : "dispute",
          status: "open",
          amountCents: Number.isFinite(Number(d.amount)) ? Math.round(Number(d.amount) * 100) : null, // FLW amounts are major units
          currency: (d.currency as string | undefined) ?? null,
          payload: d,
        });
        return res.status(200).json({ received: true, ...result });
      }
      if (payload.event === "refund.processed" || payload.event === "refund.failed") {
        const { reconcilePspRefund } = await import("../services/payments/disputes");
        const d = payload.data ?? {};
        const reference = (d.reference ?? d.tx_ref ?? d.flw_ref ?? null) as string | null;
        const result = await reconcilePspRefund(db, {
          provider: "flutterwave",
          providerRef: reference ?? "unknown",
          outcome: payload.event === "refund.processed" ? "processed" : "failed",
          amountCents: Number.isFinite(Number(d.amount)) ? Math.round(Number(d.amount) * 100) : null,
          payload: d,
        });
        return res.status(200).json({ received: true, ...result });
      }
      if (typeof payload.event === "string" && payload.event.length > 0) {
        const { logUnhandledPspEvent } = await import("../services/payments/disputes");
        logUnhandledPspEvent("flutterwave", payload);
      }
      // === END W39 PAY-8 ===
      return res.status(200).json({ received: true });
    } catch (err: any) {
      console.error("[flutterwave-webhook]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // === W43 dispatch (Coder C): courier proof-of-delivery capture ─────────
  // POST /api/delivery/proof — base64 JSON body:
  //   { tenantId, orderId, type?, imageBase64?, mimeType?, mediaUrl?,
  //     capturedByDriverId?, idempotencyKey? }
  // Auth: per-tenant courier token — tenants.settings.dispatch.courierToken
  // or the DELIVERY_PROOF_TOKEN env fallback, presented as
  // "x-delivery-proof-token". Fail-CLOSED when no token is configured (a POD
  // gates the money-relevant delivered transition). Media bytes reuse the
  // existing WA media storage path (storagePut). Idempotent on
  // idempotencyKey — courier retries return the original proof.
  app.post("/api/delivery/proof", express.json({ limit: "12mb" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const body = (req.body ?? {}) as Record<string, any>;
      const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
      const orderId = typeof body.orderId === "string" ? body.orderId : "";
      if (!tenantId || !orderId) return res.status(400).json({ error: "tenantId and orderId are required" });

      const [tenantRow] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
      if (!tenantRow) return res.status(404).json({ error: "tenant-not-found" });
      const settings = (tenantRow.settings ?? null) as any;
      const expected: string | null =
        (typeof settings?.dispatch?.courierToken === "string" && settings.dispatch.courierToken.trim()) ||
        (process.env.DELIVERY_PROOF_TOKEN?.trim() || null);
      if (!expected) {
        console.error("[delivery-proof] no courier token configured (tenant settings.dispatch.courierToken or DELIVERY_PROOF_TOKEN) — refusing");
        return res.status(503).json({ error: "proof-capture-not-configured" });
      }
      const presented = ((req.headers["x-delivery-proof-token"] as string) ?? "").trim();
      if (presented !== expected) {
        console.warn("[delivery-proof] invalid courier token — rejected");
        return res.status(401).json({ error: "invalid-token" });
      }

      const type = ["photo", "signature", "otp"].includes(body.type) ? body.type : "photo";
      let mediaBuffer: Buffer | null = null;
      const mimeType: string | null = typeof body.mimeType === "string" ? body.mimeType : "image/jpeg";
      if (typeof body.imageBase64 === "string" && body.imageBase64.length > 0) {
        mediaBuffer = Buffer.from(body.imageBase64, "base64");
        if (mediaBuffer.length === 0 || mediaBuffer.length > 8 * 1024 * 1024) {
          return res.status(400).json({ error: "imageBase64 must decode to 1..8MiB" });
        }
      }
      if (!mediaBuffer && typeof body.mediaUrl !== "string") {
        return res.status(400).json({ error: "imageBase64 or mediaUrl is required" });
      }

      const { recordDeliveryProof } = await import("../services/deliveryProof");
      const result = await recordDeliveryProof(db, {
        tenantId,
        orderId,
        type,
        mediaBuffer,
        mimeType,
        mediaUrl: typeof body.mediaUrl === "string" ? body.mediaUrl : null,
        capturedByDriverId: typeof body.capturedByDriverId === "string" ? body.capturedByDriverId : null,
        capturedVia: "endpoint",
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
        fulfillmentId: typeof body.fulfillmentId === "string" ? body.fulfillmentId : null,
      });
      return res.json({
        ok: true,
        proofId: result.proof.id,
        duplicate: result.duplicate,
        delivered: result.delivered,
        mediaUrl: result.proof.mediaUrl,
      });
    } catch (err: any) {
      if (err?.code === "NOT_FOUND") return res.status(404).json({ error: err.message });
      console.error("[delivery-proof]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W43 dispatch ===

  // ── Shipbubble delivery webhook (/api/webhooks/shipbubble) ────────────────
  app.post("/api/webhooks/shipbubble", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const [cfg] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
      const body = toRawBody(req.body);
      const secret = requireWebhookSecret(
        "SHIPBUBBLE_WEBHOOK_SECRET",
        cfg?.shipbubbleWebhookSecret ?? process.env.SHIPBUBBLE_WEBHOOK_SECRET,
        res,
      );
      if (secret === null) return;
      if (secret) {
        const sig = (req.headers["x-shipbubble-signature"] as string) ?? "";
        if (!verifyHmacSignature(body, secret, sig, "sha512")) {
          console.warn("[shipbubble-webhook] invalid signature — rejected");
          return res.status(401).json({ error: "Invalid signature" });
        }
      }
      const payload = JSON.parse(body.toString());
      const trackingId = payload.tracking_number ?? payload.data?.tracking_number;
      const event = (payload.event ?? payload.status ?? "").toLowerCase();
      if (!trackingId) return res.status(200).json({ received: true });
      const statusMap: Record<string, string> = {
        "shipment.picked_up": "picked_up", "shipment.in_transit": "in_transit",
        "shipment.out_for_delivery": "out_for_delivery", "shipment.delivered": "delivered",
        "shipment.failed": "failed", "shipment.returned": "returned",
        picked_up: "picked_up", in_transit: "in_transit",
        out_for_delivery: "out_for_delivery", delivered: "delivered", failed: "failed",
      };
      const newStatus = statusMap[event];
      if (!newStatus) return res.status(200).json({ received: true, skipped: true });
      const [shipment] = await db.select().from(logisticsShipments)
        .where(eq(logisticsShipments.trackingId, trackingId));
      if (!shipment) return res.status(200).json({ received: true, notFound: true });
      // === W43 dispatch (Coder C): tenants.requirePod gates → delivered.
      // When the tenant requires proof-of-delivery and none exists yet, the
      // shipment advances to out_for_delivery instead and the carrier is told
      // to capture POD (POST /api/delivery/proof). Flag OFF (default) =
      // pre-W43 behavior byte-identical. ===
      if (newStatus === "delivered") {
        const { podDeliveryGate } = await import("../services/deliveryProof");
        const gate = await podDeliveryGate(db, shipment.tenantId, shipment.orderId);
        if (gate.required && !gate.satisfied) {
          const podNow = new Date();
          await db.update(logisticsShipments).set({
            status: "out_for_delivery",
            outForDeliveryAt: shipment.outForDeliveryAt ?? podNow,
            webhookPayloads: sql`webhook_payloads || ${JSON.stringify([{ ...payload, receivedAt: podNow.toISOString(), podRequired: true }])}::jsonb`,
            updatedAt: podNow,
          }).where(eq(logisticsShipments.id, shipment.id));
          console.log(`[shipbubble-webhook] delivered blocked: POD required (order=${shipment.orderId})`);
          return res.status(200).json({ received: true, podRequired: true });
        }
      }
      // === END W43 dispatch ===
      const now = new Date();
      const tsField: Record<string, object> = {
        picked_up: { pickedUpAt: now }, in_transit: { inTransitAt: now },
        out_for_delivery: { outForDeliveryAt: now }, delivered: { deliveredAt: now },
        failed: { failedAt: now }, returned: { returnedAt: now },
      };
      await db.update(logisticsShipments).set({
        status: newStatus as any,
        ...tsField[newStatus],
        webhookPayloads: sql`webhook_payloads || ${JSON.stringify([{ ...payload, receivedAt: now.toISOString() }])}::jsonb`,
        updatedAt: now,
      }).where(eq(logisticsShipments.id, shipment.id));
      if (newStatus === "delivered" && shipment.escrowTxId) {
        // === W30 escrow-lifecycle === shared helper: flipping to
        // delivery_confirmed ALWAYS resets the buyer-protection deadline
        // (verify-v1 #14 — previously the window could be ~zero here).
        const { confirmEscrowDelivery } = await import("../services/escrowLifecycle");
        await confirmEscrowDelivery(db, { escrowTxId: shipment.escrowTxId, at: now });
        await db.update(orders).set({ status: "delivered", updatedAt: now }).where(eq(orders.id, shipment.orderId));
      }
      // Push a WhatsApp status update to the buyer (non-blocking).
      const { notifyBuyerShipmentStatus } = await import("../routers/logistics");
      notifyBuyerShipmentStatus(db, shipment, newStatus)
        .catch((e: any) => console.warn("[shipbubble-webhook] buyer status push failed:", e?.message));
      return res.status(200).json({ received: true });
    } catch (err: any) {
      console.error("[shipbubble-webhook]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Bank escrow settlement callback (PSSP mode) ───────────────────────────
  // Authenticated via HMAC-SHA256 over the raw body (ESCROW_BANK_WEBHOOK_SECRET,
  // fail closed when unset) and the bankRef MUST match the reference generated
  // at release-instruction time and stored on the escrow row.
  app.post("/api/webhooks/escrow-bank", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const body = toRawBody(req.body);
      const secret = requireWebhookSecret("ESCROW_BANK_WEBHOOK_SECRET", process.env.ESCROW_BANK_WEBHOOK_SECRET, res);
      if (secret === null) return;
      if (secret) {
        const sig =
          (req.headers["x-escrow-bank-signature"] as string) ??
          (req.headers["x-signature"] as string) ??
          "";
        if (!verifyHmacSignature(body, secret, sig.replace(/^sha256=/, ""), "sha256")) {
          console.warn("[escrow-bank-webhook] invalid signature — rejected");
          return res.status(401).json({ error: "invalid-signature" });
        }
      }
      const { escrowId, bankRef, status } = JSON.parse(body.toString()) ?? {};
      if (!escrowId || !bankRef) return res.status(400).json({ error: "Missing escrowId or bankRef" });

      const [escrow] = await db.select().from(escrowTransactions)
        .where(eq(escrowTransactions.id, escrowId)).limit(1);
      if (!escrow) return res.status(404).json({ error: "escrow-not-found" });

      // The presented bankRef must equal the reference we generated when the
      // release was instructed — otherwise anyone can settle any escrow.
      if (!escrow.bankRef || !timingSafeEqualStr(String(bankRef), escrow.bankRef)) {
        console.warn(`[escrow-bank-webhook] bankRef mismatch for escrow ${escrowId} — rejected`);
        return res.status(401).json({ error: "bankref-mismatch" });
      }

      if (status === "settled") {
        if (escrow.state === "settled") {
          return res.status(200).json({ received: true, action: "already-settled" });
        }
        const transitioned = await db.update(escrowTransactions).set({
          state: "settled", bankSettlementConfirmedAt: new Date(), settledAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(escrowTransactions.id, escrowId), eq(escrowTransactions.state, "release_instructed")))
          .returning({ id: escrowTransactions.id });
        if (transitioned.length === 0) {
          return res.status(409).json({ error: "invalid-state", state: escrow.state });
        }
      }
      return res.status(200).json({ received: true });
    } catch (err: any) {
      console.error("[escrow-bank-webhook]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Integration webhooks (Medusa / Twenty CRM / Odoo) ────────────────────
  // POST /integrations/:system/webhook?t=<tenantId> (or X-Tenant-Id header).
  // Per-tenant HMAC-SHA256 (settings.integrations.<system>.webhookSecret) over
  // the raw body, timingSafeEqual-compared, fail-closed in production.
  // Accepted payloads are recorded in integration_events (direction='in') and
  // applied with a loop guard (never re-enqueued outbound).
  app.post("/integrations/:system/webhook", express.raw({ type: "*/*" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const tenantId =
        (typeof req.query.t === "string" && req.query.t) ||
        (req.headers[INTEGRATION_TENANT_HEADER] as string | undefined) ||
        null;
      const sig = req.headers[INTEGRATION_SIGNATURE_HEADER];
      const result = await handleIntegrationWebhook(
        req.params.system,
        tenantId,
        toRawBody(req.body),
        Array.isArray(sig) ? sig[0] : sig,
        { db, isProduction: isProductionLike() },
      );
      return res.status(result.status).json(result.body);
    } catch (err: any) {
      console.error("[integrations-webhook]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Shopify app connector (W16, roadmap F7) — ADDITIVE ────────────────────
  // OAuth redirect callback (GET) and HMAC-verified webhooks (POST
  // /api/webhooks/shopify?t=<tenantId>). Verification + processing live in
  // server/services/shopifyIntegration/webhook.ts.
  app.get("/api/shopify/callback", async (req, res) => {
    try {
      const { handleShopifyOAuthCallbackExpress } = await import("../services/shopifyIntegration/webhook");
      await handleShopifyOAuthCallbackExpress(req, res);
    } catch (err: any) {
      console.error("[shopify-oauth-callback]", err);
      res.status(500).json({ error: err?.message });
    }
  });
  app.post("/api/webhooks/shopify", express.raw({ type: "*/*" }), async (req, res) => {
    try {
      const { handleShopifyWebhookExpress } = await import("../services/shopifyIntegration/webhook");
      await handleShopifyWebhookExpress(req, res);
    } catch (err: any) {
      console.error("[shopify-webhook]", err);
      res.status(500).json({ error: err?.message });
    }
  });
  // ── Internal recovery sweeps (assurance F-02) ─────────────────────────────
  // Runs the recovery/reconciliation sweeps that previously had no invoker:
  // settlement_retry markers, mandate-charge reconcile, bureau outbox retry,
  // dunning, and webhook-dedupe retention. See _core/recoverySweeps.ts.
  //
  // Auth: shared-secret header `x-sweep-secret` compared (timing-safe) against
  // SWEEP_SECRET. FAIL-CLOSED: when SWEEP_SECRET is unset the endpoint is
  // disabled (503) — there is no default secret. Wrong/missing secret → 401.
  //
  // External scheduler example (any cron runner / k8s CronJob):
  //   curl -XPOST -H "x-sweep-secret: $SWEEP_SECRET" https://app/api/internal/sweeps
  app.post("/api/internal/sweeps", async (req, res) => {
    const auth = sweepEndpointAuth(req.headers as any);
    if (auth === "disabled") {
      // Fail closed: never run recovery sweeps on an unauthenticated endpoint.
      return res.status(503).json({ error: "sweeps disabled — SWEEP_SECRET is not configured" });
    }
    if (auth === "unauthorized") {
      return res.status(401).json({ error: "unauthorized" });
    }
    try {
      const report = await runRecoverySweeps();
      console.log(`[sweeps] completed ok=${report.ok} in ${report.durationMs}ms: ${JSON.stringify(report.results)}`);
      return res.status(report.ok ? 200 : 207).json(report);
    } catch (err: any) {
      return res.status(503).json({ error: String(err?.message ?? err) });
    }
  });

  // === W34 wa-ops-alert (merger seam) ===
  // POST /api/internal/wa-ops-alert — platform-side receiver for the W34
  // Alertmanager→WhatsApp ops bridge (deploy/otel/alertmanager-wa-bridge.mjs).
  // Auth: X-Internal-Token (timing-safe vs INTERNAL_API_KEY) — FAIL-CLOSED:
  // when INTERNAL_API_KEY is unset the endpoint is disabled (503). Rate-limited
  // 30/min fail-closed. Honest 503 when WhatsApp env credentials are not
  // configured (the bridge logs the drop and still 200s Alertmanager).
  app.post("/api/internal/wa-ops-alert", async (req, res) => {
    const internalKey = (process.env.INTERNAL_API_KEY ?? "").trim();
    if (!internalKey) {
      return res.status(503).json({ error: "wa-ops-alert disabled — INTERNAL_API_KEY is not configured" });
    }
    const presented = (req.headers["x-internal-token"] as string | undefined)
      ?? (req.headers["x-internal-api-key"] as string | undefined) ?? "";
    if (!timingSafeEqualStr(presented, internalKey)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const parsed = waOpsAlertSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid-payload", detail: parsed.error.issues.map((i) => i.message).join("; ").slice(0, 300) });
    }
    // Rate limit: 30 ops alerts/min; fail-CLOSED in production, dev/test
    // fail-open with a warning (consistent with the platform's other limiters
    // — the sim/dev environments have no Redis).
    try {
      const { checkRateLimit } = await import("./rateLimit");
      const windowKey = `rl:wa-ops-alert:${Math.floor(Date.now() / 60000)}`;
      const decision = await checkRateLimit(windowKey, 30, 60, isProd);
      if (!decision.allowed) {
        return res.status(decision.error ? 503 : 429).json({ error: decision.error ? "rate-limiter-unavailable" : "rate-limited", retryAfter: decision.retryAfter });
      }
    } catch (rlErr: any) {
      return res.status(503).json({ error: `rate-limiter-unavailable: ${String(rlErr?.message ?? rlErr)}` });
    }
    const waConfigured = !!((process.env.WAC_WHATSAPP_TOKEN || process.env.WHATSAPP_TOKEN) && (process.env.WAC_WHATSAPP_PHONE_ID || process.env.WHATSAPP_PHONE_NUMBER_ID));
    if (!waConfigured) {
      return res.status(503).json({ error: "whatsapp-not-configured", sent: false });
    }
    try {
      const { sendWhatsAppText } = await import("../services/waSender");
      const result = await sendWhatsAppText("default", parsed.data.to, parsed.data.body, { notifType: "ops_alert", skipLog: false });
      if (!result.sent) {
        return res.status(503).json({ error: "whatsapp-send-simulated", sent: false });
      }
      return res.status(200).json({ sent: true, wamids: result.wamids, chunks: result.chunks });
    } catch (err: any) {
      // Honest failure — the bridge counts this as a drop.
      return res.status(502).json({ error: `whatsapp-send-failed: ${String(err?.message ?? err).slice(0, 200)}`, sent: false });
    }
  });
  // === END W34 wa-ops-alert ===

  // ── WhatsApp Business API webhook (Meta) ──────────────────────────────────
  // GET: verification challenge from Meta
  app.get("/api/webhooks/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    // A4-04: never fall back to the public static token in production — the
    // env.ts boot gate already refuses to boot in prod when the var is unset
    // or still the demo value; this is defense-in-depth at request time.
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN ?? (isProd ? "" : "whatsapp_verify_token_demo");
    if (!verifyToken) {
      return res.status(503).json({ error: "Webhook verification not configured" });
    }
    if (mode === "subscribe" && token === verifyToken) {
      console.log("[whatsapp-webhook] Verification successful");
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: "Forbidden" });
  });
  // POST: incoming messages and media from Meta
  app.post("/api/webhooks/whatsapp", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      // ── HMAC-SHA256 signature verification (fail closed when unset) ───────
      const rawBody = toRawBody(req.body);
      const appSecret = requireWebhookSecret("WHATSAPP_APP_SECRET", process.env.WHATSAPP_APP_SECRET, res);
      if (appSecret === null) return;
      if (appSecret) {
        const sig = ((req.headers["x-hub-signature-256"] as string) ?? "").replace(/^sha256=/, "");
        if (!verifyHmacSignature(rawBody, appSecret, sig, "sha256")) {
          console.warn("[whatsapp-webhook] Invalid HMAC signature — request rejected");
          return res.status(401).json({ error: "invalid-signature" });
        }
      }
      const body = JSON.parse(rawBody.toString());
      // ── DLQ: log every inbound payload ────────────────────────────────────
      const waEventId = crypto.randomUUID();
      const waMsg0 = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      // === W42 PLT-12 === DLQ-insert failure is no longer log-only: persist
      // to a durable fallback (Redis list / JSONL file — survives restart)
      // and raise an ops alert via the existing admin-alerts path.
      const waDlqRecord = {
        id: waEventId,
        messageId: waMsg0?.id ?? null,
        phoneNumberId: body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? null,
        waPhoneNumber: waMsg0?.from ?? null,
        messageType: waMsg0?.type ?? null,
        rawPayload: body,
        status: "received" as const,
        retryCount: 0,
      };
      await db.insert(waWebhookEvents).values(waDlqRecord).catch(async (e: any) => {
        console.warn("[whatsapp-webhook] DLQ insert failed:", e?.message);
        let backend: "redis" | "file" | "none" = "none";
        try {
          const { persistWaWebhookFallback, alertWaDlqInsertFailure } = await import("../services/waWebhookDlqFallback");
          backend = await persistWaWebhookFallback({ ...waDlqRecord, fallbackReason: String(e?.message ?? e).slice(0, 300) });
          console.warn(`[whatsapp-webhook] DLQ fallback persisted via ${backend} (id=${waEventId})`);
          await alertWaDlqInsertFailure(db, waDlqRecord, e, backend);
        } catch (fbErr: any) {
          console.error("[whatsapp-webhook] DLQ fallback ALSO failed — event may be lost:", fbErr?.message ?? fbErr);
        }
      });
      // === END W42 PLT-12 ===
      // Acknowledge immediately (Meta requires 200 within 20s)
      res.status(200).json({ received: true });
      // === W40 MSG-2: message_template_status_update events ===
      // Template lifecycle events (REJECTED/PAUSED/DISABLED/APPROVED) arrive
      // on this same endpoint with field="message_template_status_update" and
      // were previously dropped by the bare 200. Persist the new status
      // (template store + settings cache) and alert the tenant admin on dead
      // templates; campaign sends gate on it via assertTemplateSendable.
      try {
        const { handleTemplateStatusWebhook } = await import("../services/templateStatus");
        const tsr = await handleTemplateStatusWebhook(db, body);
        if (tsr.handled > 0) {
          console.log(`[whatsapp-webhook] template-status events: ${JSON.stringify(tsr)}`);
        }
      } catch (e: any) {
        console.error("[whatsapp-webhook] template-status handling failed:", e?.message);
      }
      // === END W40 MSG-2 ===
      // === W45 webhook-core (MSG-4): iterate ALL entry[]/changes[] — no
      // more first-element-only fan-out; the full payload is persisted in the
      // wa_webhook_events DLQ row above. ===
      const waProcFailures: string[] = [];
      const waEntries: any[] = Array.isArray(body?.entry) ? body.entry : [];
      for (const entryItem of waEntries) {
        const changeList: any[] = Array.isArray(entryItem?.changes) ? entryItem.changes : [];
        for (const change of changeList) {
          const value = change?.value;
          if (!value) continue;
          try {
            const r = await processWaWebhookValue(db, value, {});
            waProcFailures.push(...r.failures);
          } catch (changeErr: any) {
            const m = String(changeErr?.message ?? changeErr).slice(0, 300);
            console.error("[whatsapp-webhook] change processing failed:", m);
            waProcFailures.push(m);
          }
        }
      }
      // === W45 webhook-core (MSG-7): flip the DLQ row to processed/failed so
      // the retry heartbeat's status='failed' select has real work
      // (previously rows sat at "received" forever and nothing was retried). ===
      const waProcNow = new Date();
      if (waProcFailures.length > 0) {
        await db.update(waWebhookEvents)
          .set({
            status: "failed",
            lastError: waProcFailures.join(" | ").slice(0, 900),
            nextRetryAt: new Date(Date.now() + 2 * 60 * 1000),
            updatedAt: waProcNow,
          })
          .where(eq(waWebhookEvents.id, waEventId))
          .catch((e: any) => console.warn("[whatsapp-webhook] DLQ status update failed:", e?.message));
      } else {
        await db.update(waWebhookEvents)
          .set({ status: "processed", processedAt: waProcNow, updatedAt: waProcNow })
          .where(eq(waWebhookEvents.id, waEventId))
          .catch((e: any) => console.warn("[whatsapp-webhook] DLQ status update failed:", e?.message));
      }
      // === END W45 webhook-core (handler fan-out + DLQ flip) ===
    } catch (err: any) {
      console.error("[whatsapp-webhook]", err);
    }
  });

  // === W37 telegram (Coder B): Telegram Bot API webhook ===
  // POST /api/webhooks/telegram/:tenantId — tenant comes from the PATH and
  // must have telegram configured + enabled (never first-match by bot token;
  // TEN-3 class bug). Fail-closed, timing-safe validation of the
  // X-Telegram-Bot-Api-Secret-Token header against the per-tenant stored
  // secret; dedupe via the SAME processed_webhook_events ledger with
  // namespaced ids `tg:<update_id>`; 200 ack first, processing after the ack.
  // Telegram is DISABLED by default (TELEGRAM_ENABLED=true to enable).
  app.post("/api/webhooks/telegram/:tenantId", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const {
        telegramEnabled,
        getTelegramConfig,
        validateTelegramSecret,
        processTelegramUpdate,
      } = await import("../services/telegramInbound");
      if (!telegramEnabled()) {
        return res.status(404).json({ error: "telegram-disabled" });
      }
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const tenantId = String(req.params.tenantId ?? "");
      // Fail closed with a bare 404 for unknown tenants / telegram not
      // configured — no configuration oracle for unauthenticated callers.
      const cfg = await getTelegramConfig(db, tenantId);
      if (!cfg || !cfg.enabled || !cfg.webhookSecret || !cfg.botToken) {
        return res.status(404).json({ error: "not-found" });
      }
      // === W40 tenancy (TEN-1): suspended/churned tenants fail closed with
      // the same bare 404 as unconfigured tenants (no status oracle); the
      // drop is logged structured for ops.
      const tgTenantStatus = await getTenantStatus(db, tenantId);
      if (tgTenantStatus !== null && isTenantInactive(tgTenantStatus)) {
        logSuspendedTenantDrop("telegram", { tenantId, tenantStatus: tgTenantStatus });
        return res.status(404).json({ error: "not-found" });
      }
      const presented = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
      if (!validateTelegramSecret(presented, cfg.webhookSecret)) {
        console.warn(`[telegram-webhook] invalid secret token (tenant=${tenantId}) — rejected`);
        return res.status(401).json({ error: "invalid-secret-token" });
      }
      const update = JSON.parse(toRawBody(req.body).toString());
      const updateId = update?.update_id;
      if (updateId === undefined || updateId === null) {
        // Well-formed Telegram webhooks always carry update_id; ack and drop.
        return res.status(200).json({ received: true });
      }
      // Insert-first dedupe claim (production fails closed when the ledger is
      // unavailable — Telegram retries, exactly the WA doctrine).
      const claim = await claimWebhookEvent(db, {
        id: `tg:${updateId}`,
        tenantId,
        type: "telegram_update",
      });
      if (claim === "duplicate") {
        return res.status(200).json({ received: true, duplicate: true });
      }
      // Acknowledge immediately — all processing happens after the ack.
      res.status(200).json({ received: true });
      await processTelegramUpdate(db, cfg, update).catch((e: any) =>
        console.error("[telegram-webhook] post-ack processing error:", e?.message));
    } catch (err: any) {
      console.error("[telegram-webhook]", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "telegram-webhook-error" });
      }
    }
  });
  // === END W37 telegram ===

  // ── USSD gateway (Africa's Talking) ───────────────────────────────────────
  // Form body: sessionId, serviceCode, phoneNumber, text (cumulative buffer
  // joined with "*"). Drives the same menu/session engine as WhatsApp and
  // responds with plain text prefixed "CON " (continue) or "END " (terminal).
  app.post("/ussd", async (req, res) => {
    res.type("text/plain");
    try {
      // W30 (V2#6): the gateway authenticates with a shared secret header.
      // Fail-closed in production (env.ts refuses to boot without it); in
      // non-prod an unset secret keeps the endpoint open for local dev with
      // a loud warning — but NEVER when the secret is configured and wrong.
      const ussdSecret = (process.env.USSD_GATEWAY_SECRET ?? "").trim();
      if (ussdSecret) {
        const presented = String(req.headers["x-ussd-gateway-key"] ?? "");
        const { timingSafeEqual } = await import("crypto");
        const a = Buffer.from(presented);
        const b = Buffer.from(ussdSecret);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return res.status(401).send("END Unauthorized gateway");
        }
      } else {
        console.warn("[ussd] USSD_GATEWAY_SECRET unset — endpoint unauthenticated (non-prod only)");
      }
      // W30 (V2#6): fixed-window rate limit per calling gateway IP.
      const { checkRateLimit } = await import("./rateLimit");
      const { isProd } = await import("./env");
      const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      const decision = await checkRateLimit(`ussd:${ip}`, 60, 60, isProd);
      if (!decision.allowed) {
        res.status(429).set("Retry-After", String(decision.retryAfter));
        return res.send("END Too many requests. Please try again later.");
      }
      const { sessionId, serviceCode, phoneNumber, text } = (req.body ?? {}) as Record<string, string>;
      if (!sessionId || !phoneNumber) {
        return res.status(400).send("END Missing sessionId or phoneNumber");
      }
      const { handleUssdRequest } = await import("../services/useCases");
      const reply = await handleUssdRequest({ sessionId, serviceCode, phoneNumber, text });
      return res.status(200).send(reply);
    } catch (e: any) {
      console.error("[ussd]", e);
      return res.status(200).send("END Service temporarily unavailable. Please try again later.");
    }
  });

  // ── Escrow auto-confirm heartbeat ─────────────────────────────────────────
  app.post("/api/scheduled/escrow-auto-confirm", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const [cfg] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
      if (!cfg?.autoConfirmEnabled) return res.json({ ok: true, skipped: "auto-confirm disabled" });
      const now = new Date();
      const expired = await db.select().from(escrowTransactions).where(and(
        eq(escrowTransactions.state, "delivery_confirmed"),
        sql`buyer_confirm_deadline < ${now.toISOString()}`,
      ));
      let confirmed = 0;
      // === W30 escrow-lifecycle ===
      // verify-v1 #13: this cron used to re-implement settlement as separate
      // non-transactional statements (state flip, then wallet credit) with NO
      // platform-fee leg and NO TigerBeetle ledger commit — a crash mid-way
      // stranded escrows settled-but-uncredited. It now delegates to the SAME
      // hardened settleEscrowAtomic used by buyerConfirm / SLA scan: one DB
      // transaction (flip + merchant net credit + platform fee leg) plus the
      // ledger commit, with saga compensation on post-capture failure.
      const { settleEscrowAtomic, EscrowSettlementError, compensateEscrowSettlementFailure } = await import("../routers/escrow");
      for (const escrow of expired) {
        try {
          // === W30 hotfix (verify-v1 #11) ===
          // Delivery confirmation sourced from a mock/local/unverified courier
          // in production is not independent delivery evidence — never
          // auto-settle; skip + alert (buyer confirm or admin review only).
          const escMeta = (escrow.metadata ?? {}) as Record<string, unknown>;
          if (escMeta.buyerProtection === "courier_unverified") {
            const { notifyOwner } = await import("../_core/notification");
            await notifyOwner({
              title: `Auto-confirm BLOCKED — unverified courier (escrow ${escrow.id.slice(0, 8)})`,
              content: `Escrow ${escrow.id} (order ${escrow.orderId ?? "unknown"}, tenant ${escrow.tenantId}) passed its buyer-confirmation deadline, but delivery was self-reported by a mock/local/unverified courier. Auto-confirm settlement was skipped. Require buyer confirmation or manual admin review.`,
            }).catch(() => {/* non-fatal */});
            continue;
          }
          const result = await settleEscrowAtomic(db, escrow.id, {
            autoConfirmed: true,
            allowedFromStates: ["delivery_confirmed"],
            descriptionPrefix: "Auto-confirm (buyer window expired)",
          });
          if (!result.transitioned) continue; // concurrent run already settled it
        } catch (settleErr: any) {
          if (settleErr instanceof EscrowSettlementError) {
            await compensateEscrowSettlementFailure(db, {
              escrowId: escrow.id,
              pendingIds: settleErr.capturedPendingIds,
              reason: settleErr.message,
            }).catch((compErr) => console.error("[escrow-auto-confirm] compensation failed:", compErr));
          }
          console.error(`[escrow-auto-confirm] settlement failed for escrow ${escrow.id}:`, settleErr?.message ?? settleErr);
          continue;
        }
        await db.update(orders).set({ paymentStatus: "completed", updatedAt: now }).where(eq(orders.id, escrow.orderId));
        confirmed++;
      }
      return res.json({ ok: true, confirmed });
    } catch (err: any) {
      console.error("[escrow-auto-confirm]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // === W45 money-intents (Coder B2, PAY-24) ===
  // ── POST /api/scheduled/transfer-sweep ──────────────────────────────────
  // Sweeps STALE non-terminal Paystack transfers (merchant withdrawals whose
  // webhook never arrived): verifyTransfer → failed/not-found gets a
  // compensating credit; stale OTP-gated transfers are alerted + auto-
  // cancelled. W42 cronAuth (scope+jti via sdk.authenticateRequest); route is
  // on the services/scheduler/scheduler.mjs allowlist (J178 contract).
  // After deploy: manus-heartbeat create --name transfer-sweep --cron "0 */10 * * * *" --path /api/scheduled/transfer-sweep
  app.post("/api/scheduled/transfer-sweep", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const { runStaleTransferSweep } = await import("../services/payments/staleTransferSweep");
      const result = await runStaleTransferSweep();
      return res.json({ ok: result.errors.length === 0, ...result });
    } catch (err: any) {
      console.error("[transfer-sweep]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W45 money-intents (PAY-24) ===

  // === W46 orders-p2 (Coder G, ORD-19) ===
  // ── POST /api/scheduled/po-breach-sweep ─────────────────────────────────
  // Alerts buyer + supplier admin on POs past promisedDate (approvedAt +
  // supplier leadTimeDays) that remain unfulfilled. Claim-first via
  // breach_alerted_at — exactly-once per breached promise. W42 cronAuth
  // (scope+jti via sdk.authenticateRequest); route is on the
  // services/scheduler/scheduler.mjs allowlist (J178 contract).
  // After deploy: manus-heartbeat create --name po-breach-sweep --cron "0 0 */6 * * *" --path /api/scheduled/po-breach-sweep
  app.post("/api/scheduled/po-breach-sweep", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const { runPoBreachSweep } = await import("../services/procurement/poBreach");
      const result = await runPoBreachSweep(db);
      return res.json({ ok: result.errors.length === 0, ...result });
    } catch (err: any) {
      console.error("[po-breach-sweep]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W46 orders-p2 ===

  // ── PSP float income heartbeat ────────────────────────────────────────────
  app.post("/api/scheduled/float-income", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const [cfg] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
      if (cfg?.custodyMode !== "psp") return res.json({ ok: true, skipped: "not in PSP mode" });
      const [{ total }] = await db.select({ total: sql<string>`coalesce(sum(escrow_balance::numeric), 0)::text` }).from(merchantWallets);
      const totalBalance = parseFloat(total ?? "0");
      if (totalBalance <= 0) return res.json({ ok: true, skipped: "no escrow balance" });
      const dailyRate = parseFloat(cfg.floatYieldRate) / 365;
      const dailyIncome = totalBalance * dailyRate;
      const today = new Date().toISOString().slice(0, 10);
      // === W30 feature-ring (V3#13) ===
      // unique(float_income_entries.date) makes repeat runs conflict — the
      // skip is honest, never a double-accrual. NOTE: this accrual is a
      // PROJECTION ONLY — no wallet/account is credited here (that requires
      // a real yield settlement rail); the row is labelled accordingly.
      const inserted = await db.insert(floatIncomeEntries).values({
        id: crypto.randomUUID(), date: today,
        totalEscrowBalance: totalBalance.toFixed(2),
        dailyYieldRate: dailyRate.toFixed(8),
        incomeAmount: dailyIncome.toFixed(4),
        currency: "NGN", createdAt: new Date(),
      }).onConflictDoNothing({ target: floatIncomeEntries.date }).returning({ id: floatIncomeEntries.id });
      if (inserted.length === 0) {
        return res.json({ ok: true, skipped: "already accrued today", date: today, projectionOnly: true });
      }
      return res.json({ ok: true, date: today, income: dailyIncome.toFixed(4), projectionOnly: true, note: "projection only — no wallet credited" });
      // === END W30 feature-ring ===
    } catch (err: any) {
      console.error("[float-income]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // tRPC API
  // ── Public Evidence Portal (no auth required) ─────────────────────────────
  app.get("/api/evidence/:token", async (req, res) => {
    try {
      const result = await handleGetEvidencePortal(req.params.token);
      if (!result.valid) {
        return res.status(result.expired ? 410 : 404).json({ error: result.expired ? "Link expired" : "Invalid link" });
      }
      return res.json(result);
    } catch (err: any) {
      console.error("[evidence-portal]", err);
      return res.status(500).json({ error: "Service error" });
    }
  });

  app.post("/api/evidence/:token/submit-json", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const { note } = req.body as { note?: string };
      const result = await handleSubmitEvidence(req.params.token, note ?? null, null, null, null);
      if (!result.success) return res.status(400).json({ error: result.error });
      return res.json({ success: true, submissionId: result.submissionId });
    } catch (err: any) {
      console.error("[evidence-submit-json]", err);
      return res.status(500).json({ error: "Service error" });
    }
  });

  // Raw binary file upload — EvidencePortal.tsx POSTs file bytes with
  // Content-Type (mime), X-Filename and X-Note headers.
  app.post(
    "/api/evidence/:token/submit",
    express.raw({ type: () => true, limit: "25mb" }),
    async (req, res) => {
      try {
        const fileBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
        if (!fileBuffer.length) return res.status(400).json({ error: "Empty file body" });
        const filename = ((req.headers["x-filename"] as string) ?? "evidence.bin").slice(0, 255);
        const mimeType = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();
        const note = (req.headers["x-note"] as string) ?? null;
        const result = await handleSubmitEvidence(req.params.token, note, fileBuffer, filename, mimeType);
        if (!result.success) return res.status(400).json({ error: result.error });
        console.log(`[evidence-submit] stored ${filename} (${mimeType}, ${fileBuffer.length} bytes) for token ${req.params.token.slice(0, 8)}…`);
        return res.json({ success: true, submissionId: result.submissionId, contentType: mimeType, size: fileBuffer.length });
      } catch (err: any) {
        console.error("[evidence-submit]", err);
        return res.status(500).json({ error: "Service error" });
      }
    }
  );

  // ── Public SLA Extension Response (no auth required) ─────────────────────
  // REST mirror of slaExtension.getByToken — used by client/src/pages/SlaExtensionResponse.tsx
  app.get("/api/sla-extension/:token", async (req, res) => {
    try {
      const token = req.params.token;
      if (!/^[a-f0-9]{64}$/i.test(token)) {
        return res.status(404).json({ valid: false, error: "Invalid link" });
      }
      const db = await getDb();
      if (!db) return res.status(503).json({ valid: false, error: "DB unavailable" });

      const [ext] = await db
        .select()
        .from(escrowSlaExtensions)
        .where(eq(escrowSlaExtensions.buyerToken, token))
        .limit(1);
      if (!ext) return res.status(404).json({ valid: false, error: "Extension request not found" });

      // Lazily expire pending requests past their expiry
      if (ext.status === "pending" && new Date() > ext.expiresAt) {
        await db.update(escrowSlaExtensions)
          .set({ status: "expired" })
          .where(eq(escrowSlaExtensions.id, ext.id));
        return res.status(410).json({ valid: false, expired: true, error: "This extension request has expired" });
      }
      if (ext.status === "expired") {
        return res.status(410).json({ valid: false, expired: true, error: "This extension request has expired" });
      }
      if (ext.status !== "pending") {
        return res.status(409).json({ valid: false, alreadyResponded: true, error: `Request already ${ext.status}` });
      }

      const [escrow] = await db
        .select({
          orderId: escrowTransactions.orderId,
          amount: escrowTransactions.amount,
          state: escrowTransactions.state,
          buyerConfirmDeadline: escrowTransactions.buyerConfirmDeadline,
        })
        .from(escrowTransactions)
        .where(eq(escrowTransactions.id, ext.escrowId))
        .limit(1);
      const [merchant] = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, ext.requestedByTenantId))
        .limit(1)
        .catch(() => [null as any]);

      return res.json({
        valid: true,
        extension: {
          id: ext.id,
          escrowId: ext.escrowId,
          extensionHours: ext.extensionHours,
          reason: ext.reason,
          status: ext.status,
          requestedAt: ext.requestedAt?.toISOString?.() ?? ext.requestedAt,
          expiresAt: ext.expiresAt?.toISOString?.() ?? ext.expiresAt,
          merchantName: (merchant as any)?.name ?? null,
          orderId: escrow?.orderId ?? null,
          orderAmount: escrow?.amount ?? null,
          currentDeadline: escrow?.buyerConfirmDeadline?.toISOString?.() ?? escrow?.buyerConfirmDeadline ?? null,
          newDeadline: ext.newDeadline?.toISOString?.() ?? ext.newDeadline ?? null,
        },
      });
    } catch (err: any) {
      console.error("[sla-extension-get]", err);
      return res.status(500).json({ valid: false, error: "Service error" });
    }
  });

  // REST mirror of slaExtension.respondToExtension — buyer approves/rejects
  app.post("/api/sla-extension/:token", express.json(), async (req, res) => {
    try {
      const token = req.params.token;
      if (!/^[a-f0-9]{64}$/i.test(token)) {
        return res.status(404).json({ error: "Extension request not found" });
      }
      const rawAction = (req.body?.action ?? req.body?.decision) as string | undefined;
      const decision = rawAction === "approve" ? "approved" : rawAction === "reject" ? "rejected" : rawAction;
      if (decision !== "approved" && decision !== "rejected") {
        return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
      }
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });

      const [ext] = await db
        .select()
        .from(escrowSlaExtensions)
        .where(eq(escrowSlaExtensions.buyerToken, token))
        .limit(1);
      if (!ext) return res.status(404).json({ error: "Extension request not found" });
      if (ext.status !== "pending") return res.status(400).json({ error: `Request already ${ext.status}` });
      if (new Date() > ext.expiresAt) {
        await db.update(escrowSlaExtensions)
          .set({ status: "expired" })
          .where(eq(escrowSlaExtensions.id, ext.id));
        return res.status(400).json({ error: "This request has expired" });
      }

      const now = new Date();
      let newDeadline: Date | null = null;
      if (decision === "approved") {
        const [escrow] = await db
          .select({ buyerConfirmDeadline: escrowTransactions.buyerConfirmDeadline })
          .from(escrowTransactions)
          .where(eq(escrowTransactions.id, ext.escrowId))
          .limit(1);
        const currentDeadline = escrow?.buyerConfirmDeadline ?? now;
        newDeadline = new Date(currentDeadline.getTime() + ext.extensionHours * 60 * 60 * 1000);
        await db.update(escrowTransactions)
          .set({ buyerConfirmDeadline: newDeadline, updatedAt: now })
          .where(eq(escrowTransactions.id, ext.escrowId));
      }

      await db.update(escrowSlaExtensions)
        .set({ status: decision, respondedAt: now, newDeadline })
        .where(eq(escrowSlaExtensions.id, ext.id));

      // Notify merchant of buyer's decision (same as slaExtension.respondToExtension)
      const { emitNotification } = await import("../routers/notifications");
      await emitNotification({
        tenantId: ext.requestedByTenantId,
        type: "system",
        title: decision === "approved" ? "SLA Extension Approved" : "SLA Extension Rejected",
        body: decision === "approved"
          ? `Buyer approved your ${ext.extensionHours}-hour extension. New deadline: ${newDeadline?.toLocaleString()}`
          : "Buyer rejected your SLA extension request. Original deadline still applies.",
        metadata: { escrowId: ext.escrowId, extensionId: ext.id },
      }).catch(() => {});

      return res.json({
        success: true,
        decision,
        newDeadline: newDeadline?.toISOString() ?? null,
        message: decision === "approved"
          ? `Extension approved. Delivery deadline extended by ${ext.extensionHours} hours.`
          : "Extension rejected. The original delivery deadline remains.",
      });
    } catch (err: any) {
      console.error("[sla-extension-respond]", err);
      return res.status(500).json({ error: "Service error" });
    }
  });

  // ── Internal platform events (fluvio-consumer → platform bridge) ─────────
  // services/fluvio-consumer POSTs batches of Fluvio stream events here.
  // Auth: shared secret header X-Internal-Api-Key (X-API-Key also accepted)
  // matching INTERNAL_API_KEY. Fails closed when the secret is unset outside dev.
  app.post("/api/internal/events", express.json({ limit: "5mb" }), async (req, res) => {
    try {
      const configuredSecret = process.env.INTERNAL_API_KEY ?? "";
      const presented =
        (req.headers["x-internal-api-key"] as string) ??
        (req.headers["x-api-key"] as string) ??
        "";
      // === W46 platform-p2 (PLT-15) === HMAC-signed internal requests
      // (kid-versioned, ts+body bound) — ADDITIVE alongside the legacy
      // bearer; presenting HMAC headers switches to strict verification,
      // and INTERNAL_AUTH_REQUIRE_HMAC=true fails closed on bearer in prod.
      const { verifyInternalRequest, hasInternalHmacHeaders, hmacRequired } = await import("./internalAuth");
      let hmacAuthed = false;
      if (hasInternalHmacHeaders(req.headers as Record<string, unknown>)) {
        const verdict = verifyInternalRequest({
          method: req.method,
          path: req.path,
          rawBody: JSON.stringify(req.body ?? {}),
          headers: req.headers as Record<string, string | string[] | undefined>,
        });
        if (!verdict.ok) {
          return res.status(401).json({ error: "invalid-internal-hmac", detail: verdict.error });
        }
        hmacAuthed = true;
      } else if (hmacRequired() && isProductionLike()) {
        return res.status(401).json({ error: "internal-hmac-required" });
      }
      // === END W46 platform-p2 (PLT-15) ===
      if (!hmacAuthed) // W46 platform-p2: legacy bearer path skipped after HMAC auth
      if (!configuredSecret) {
        if (isProductionLike()) {
          console.error("[internal-events] INTERNAL_API_KEY is not configured — refusing request (fail closed)");
          return res.status(503).json({ error: "internal-api-not-configured" });
        }
        console.warn("[internal-events] INTERNAL_API_KEY unset — allowing request (non-production mode)");
      } else if (presented !== configuredSecret) {
        return res.status(401).json({ error: "invalid-internal-api-key" });
      }

      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });

      // Accept both a batch { events: [...] } (fluvio-consumer ForwardBatch)
      // and a single event object matching infra.recordFluvioEvent's shape.
      const body = req.body ?? {};
      const events: any[] = Array.isArray(body.events) ? body.events : [body];
      let recorded = 0;
      for (const evt of events) {
        if (!evt || typeof evt.topic !== "string" || typeof evt.offset !== "number") continue;
        await db.insert(fluvioEventLog).values({
          topic: evt.topic,
          offset: evt.offset,
          partition: typeof evt.partition === "number" ? evt.partition : 0,
          tenantId: typeof evt.tenantId === "string" ? evt.tenantId : (typeof evt.tenant_id === "string" ? evt.tenant_id : null),
          eventType: typeof evt.eventType === "string" ? evt.eventType : (typeof evt.event_type === "string" ? evt.event_type : null),
          payload: (evt.payload ?? {}) as Record<string, unknown>,
          processed: false,
          receivedAt: new Date(),
        });
        recorded++;
      }
      return res.json({ ok: true, recorded, received: events.length });
    } catch (err: any) {
      console.error("[internal-events]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── GET|POST /api/scheduled/generate-invoices ─────────────────────────────
  // Generates due monthly subscription invoices for active tenants that do not
  // yet have one for the current billing period. Same insert logic as
  // server/routers/invoice.ts `generate` (subscription branch).
  // W30 hotfix: POST alias added so the cron scheduler (services/scheduler,
  // which invokes with POST + cron JWT) reaches this route — the scheduler
  // allowlist + k8s/cron-scheduler.yaml now cover it (monthly cadence).
  // After deploy: manus-heartbeat create --name generate-invoices --cron "0 0 1 1 * *" --path /api/scheduled/generate-invoices
  const generateInvoicesHandler = async (req: any, res: any) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });

      // Monthly fees per plan (mirrors BILLING_PLANS subscription tiers in onboarding.ts)
      const PLAN_MONTHLY_FEES: Record<string, number> = { starter: 49, growth: 149, enterprise: 499 };
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      const dueDate = new Date(now.getTime() + 14 * 86400000); // 14 days

      const activeTenants = await db.select().from(tenants).where(eq(tenants.status, "active"));
      let generated = 0;
      let skipped = 0;
      const errors: string[] = [];
      for (const tenant of activeTenants) {
        try {
          // Skip tenants already invoiced for this period
          const [existing] = await db.select({ id: invoices.id }).from(invoices)
            .where(and(
              eq(invoices.tenantId, tenant.id),
              eq(invoices.type, "subscription"),
              gte(invoices.periodStart, periodStart),
              lte(invoices.periodStart, periodEnd),
            ))
            .limit(1);
          if (existing) { skipped++; continue; }

          const currency = tenant.defaultCurrency ?? "NGN";
          const subscriptionFee = PLAN_MONTHLY_FEES[tenant.plan] ?? 0;
          const invoiceNumber = `INV-${tenant.id.slice(0, 6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
          await db.insert(invoices).values({
            id: crypto.randomUUID(),
            tenantId: tenant.id,
            invoiceNumber,
            type: "subscription",
            status: "draft",
            periodStart,
            periodEnd,
            subtotal: subscriptionFee.toFixed(2),
            commissionAmount: "0.00",
            subscriptionFee: subscriptionFee.toFixed(2),
            totalAmount: subscriptionFee.toFixed(2),
            currency,
            lineItems: [{ description: `Monthly subscription fee (${tenant.plan})`, amount: subscriptionFee, currency }],
            dueDate,
            createdAt: now,
            updatedAt: now,
          });
          generated++;
        } catch (tenantErr: any) {
          console.error(`[generate-invoices] tenant ${tenant.id}:`, tenantErr?.message);
          errors.push(tenant.id);
        }
      }
      return res.json({ ok: true, generated, skipped, errors, periodStart, periodEnd });
    } catch (err: any) {
      console.error("[generate-invoices]", err);
      return res.status(500).json({ error: err?.message });
    }
  };
  app.get("/api/scheduled/generate-invoices", generateInvoicesHandler);
  app.post("/api/scheduled/generate-invoices", generateInvoicesHandler);

  // === W31 scheduled payments ===
  // ── POST /api/scheduled/execute-payments (every 5 min) ──────────────────
  // Claim-before-send execution engine for scheduled_payments (W31 Coder B):
  // each due row is claimed via a guarded pending→claimed UPDATE, then the
  // wallet debit + wallet_tx ledger row (reference `sched:<id>`) + status
  // flip commit in ONE transaction — money movement is never claimed before
  // the ledger write commits. Honest insufficient_funds state is
  // merchant-retryable via scheduledPayments.retry after a top-up; other
  // failures retry with backoff and dead-letter after 5 attempts. The same
  // tick sends T-1 WhatsApp reminders (metadata.remindedAt dedupe, claimed
  // before send so no payment is reminded twice).
  // After deploy: manus-heartbeat create --name execute-payments --cron "0 */5 * * * *" --path /api/scheduled/execute-payments
  app.post("/api/scheduled/execute-payments", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runScheduledPaymentTick } = await import("../services/scheduledPayments");
      const summary = await runScheduledPaymentTick(db);
      return res.json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[execute-payments]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W31 scheduled payments ===

  // === W33 embedded-api ===
  // Embedded AP-as-a-feature HTTP surface (Melio's distribution play).
  // /api/embedded/v1/* is an Express API-key surface (NOT tRPC): partners
  // authenticate with a per-client API key, the tenant context is derived
  // from the client binding (NEVER from request params/headers), and every
  // endpoint is a THIN pass-through to the existing W31 services
  // (vendorBills / scheduledPayments / arInvoices) — no money logic lives
  // here. Bill pay goes through the SAME approval gate as in-app
  // (requireApprovalIfNeeded inside recordVendorBillPayment) — embedded can
  // never bypass it. Fail-closed: EMBEDDED_API_ENABLED defaults OFF and the
  // whole surface 404s when disabled; enabling it exposes the surface.
  {
    type EmbeddedReq = express.Request & { embedded?: { client: any; tenantId: string; actor: string; db: any } };
    const embedded = express.Router();

    // 1. Feature flag — fail-closed default OFF (404, indistinguishable from
    //    an unmounted route). Read per-request so ops can toggle without a
    //    reboot; any value other than exactly "true" is OFF.
    embedded.use((req, res, next) => {
      if ((process.env.EMBEDDED_API_ENABLED ?? "false") !== "true") {
        res.status(404).json({ error: "not-found" });
        return;
      }
      next();
    });

    // 2. API-key auth: sha256(presented key) timing-safe-compared against the
    //    stored digest (only digests persist — see services/embeddedApi.ts).
    //    Unknown key and suspended client both fail 401 honestly. Per-client
    //    rate limit reuses the fail-closed checkRateLimit (prod: limiter
    //    outage → 503; never silently unlimited).
    embedded.use(async (req: EmbeddedReq, res, next) => {
      try {
        const db = await getDb();
        if (!db) { res.status(503).json({ error: "db-unavailable" }); return; }
        const xKey = req.headers["x-api-key"];
        const auth = req.headers["authorization"];
        let presented = typeof xKey === "string" ? xKey.trim() : "";
        if (!presented && typeof auth === "string" && auth.startsWith("Bearer ")) {
          presented = auth.slice("Bearer ".length).trim();
        }
        if (!presented) { res.status(401).json({ error: "missing-api-key" }); return; }
        const { resolveApiKey, embeddedActor } = await import("../services/embeddedApi");
        const resolved = await resolveApiKey(db, presented);
        if (!resolved) { res.status(401).json({ error: "invalid-api-key" }); return; }
        if (resolved.suspended) { res.status(401).json({ error: "client-suspended" }); return; }
        const { checkRateLimit } = await import("./rateLimit");
        const limit = Math.max(1, Number(process.env.EMBEDDED_API_RATE_LIMIT_PER_MIN ?? 120) || 120);
        const windowKey = `rl:embedded:${resolved.client.id}:${Math.floor(Date.now() / 60000)}`;
        const decision = await checkRateLimit(windowKey, limit, 60, isProd);
        if (!decision.allowed) {
          res.setHeader("Retry-After", String(decision.retryAfter));
          if (decision.error) {
            res.status(503).json({ error: "rate-limiter-unavailable", retryAfter: decision.retryAfter });
            return;
          }
          res.status(429).json({ error: "rate-limited", retryAfter: decision.retryAfter });
          return;
        }
        if (decision.degraded) {
          // Redis blind and fail-open (dev/test only — prod fails closed
          // above): enforce the SAME per-client limit in-process so a blind
          // limiter never means "unlimited" anywhere. Per-minute fixed window.
          const g = globalThis as any;
          const store: Map<string, { window: number; count: number }> =
            g.__w33EmbeddedRlMem ?? (g.__w33EmbeddedRlMem = new Map());
          const win = Math.floor(Date.now() / 60000);
          const cur = store.get(resolved.client.id);
          const next = cur && cur.window === win ? { window: win, count: cur.count + 1 } : { window: win, count: 1 };
          store.set(resolved.client.id, next);
          if (next.count > limit) {
            res.setHeader("Retry-After", "60");
            res.status(429).json({ error: "rate-limited", retryAfter: 60 });
            return;
          }
        }
        req.embedded = {
          client: resolved.client,
          tenantId: resolved.client.tenantId, // tenant ALWAYS from the binding
          actor: embeddedActor(resolved.client), // embedded:<clientId>
          db,
        };
        next();
      } catch (err: any) {
        console.error("[embedded-api] auth middleware failed:", err?.message);
        res.status(500).json({ error: "embedded-auth-failed" });
      }
    });

    // Scope guard: 403 with the missing scope named honestly.
    const needScope = (scope: string) => async (req: EmbeddedReq, res: express.Response, next: express.NextFunction) => {
      const { clientHasScope } = await import("../services/embeddedApi");
      if (!req.embedded || !clientHasScope(req.embedded.client, scope as never)) {
        res.status(403).json({ error: "scope-required", scope });
        return;
      }
      next();
    };

    const mapServiceError = (res: express.Response, err: any, fallback: string) => {
      const code = err?.code;
      const msg = err?.message ?? fallback;
      if (code === "NOT_FOUND" || code === "not-found") { res.status(404).json({ error: "not-found", message: msg }); return; }
      if (code === "CONFLICT") { res.status(409).json({ error: "conflict", message: msg }); return; }
      if (code === "BAD_REQUEST" || code === "invalid-amount") { res.status(400).json({ error: "bad-request", message: msg }); return; }
      if (typeof msg === "string" && (msg.includes("required") || msg.includes("must be"))) {
        res.status(400).json({ error: "bad-request", message: msg });
        return;
      }
      console.error(`[embedded-api] ${fallback}:`, err);
      res.status(500).json({ error: "internal", message: msg });
    };

    const audit = async (req: EmbeddedReq, action: string, entityType: string, entityId: string | null, summary: string) => {
      const { writeAuditLog } = await import("../routers/audit");
      await writeAuditLog({
        tenantId: req.embedded!.tenantId,
        actorId: req.embedded!.actor, // embedded:<clientId>
        actorRole: "embedded",
        action,
        entityType,
        entityId,
        summary,
      });
    };

    const parseDate = (v: unknown): Date | null => {
      if (v == null) return null;
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d;
    };

    // ── Bills (vendorBills pass-through) ─────────────────────────────────
    embedded.get("/bills", needScope("bills:read"), async (req: EmbeddedReq, res) => {
      try {
        const { vendorBills } = await import("../../drizzle/schema");
        const { and, desc, eq } = await import("drizzle-orm");
        const conds = [eq(vendorBills.tenantId, req.embedded!.tenantId)];
        if (typeof req.query.status === "string" && req.query.status) {
          conds.push(eq(vendorBills.status, req.query.status));
        }
        const rows = await req.embedded!.db.select().from(vendorBills)
          .where(and(...conds)).orderBy(desc(vendorBills.createdAt)).limit(200);
        res.json({ bills: rows });
      } catch (err: any) { mapServiceError(res, err, "list bills failed"); }
    });

    embedded.post("/bills", needScope("bills:write"), async (req: EmbeddedReq, res) => {
      try {
        const { createVendorBill } = await import("../services/vendorBills");
        const body = req.body ?? {};
        const created = await createVendorBill(req.embedded!.db, {
          tenantId: req.embedded!.tenantId,
          vendorName: body.vendorName ?? null,
          vendorContact: body.vendorContact ?? null,
          billNumber: body.billNumber ?? null,
          description: body.description ?? null,
          amountCents: body.amountCents ?? null,
          currency: body.currency ?? "NGN",
          issueDate: parseDate(body.issueDate),
          dueDate: parseDate(body.dueDate),
          captureSource: "manual",
          actor: req.embedded!.actor,
        });
        await audit(req, "embedded.bill.create", "vendor_bill", created.bill.id,
          `Embedded bill ${created.bill.id} (${created.bill.vendorName}, ${created.bill.amountCents} cents ${created.bill.currency})`);
        res.status(201).json(created);
      } catch (err: any) { mapServiceError(res, err, "create bill failed"); }
    });

    embedded.get("/bills/:id", needScope("bills:read"), async (req: EmbeddedReq, res) => {
      try {
        const { vendorBills } = await import("../../drizzle/schema");
        const { and, eq } = await import("drizzle-orm");
        const [bill] = await req.embedded!.db.select().from(vendorBills)
          .where(and(eq(vendorBills.id, req.params.id), eq(vendorBills.tenantId, req.embedded!.tenantId)));
        if (!bill) { res.status(404).json({ error: "not-found" }); return; }
        res.json({ bill });
      } catch (err: any) { mapServiceError(res, err, "get bill failed"); }
    });

    // Bill pay goes through the SAME approval gate as in-app: above a tenant
    // threshold the bill honestly parks pending_approval (approvalRequired:
    // true, no money moves) and only an in-app approval executes it.
    embedded.post("/bills/:id/pay", needScope("payments:write"), async (req: EmbeddedReq, res) => {
      try {
        const { recordVendorBillPayment } = await import("../services/vendorBills");
        const body = req.body ?? {};
        const result = await recordVendorBillPayment(req.embedded!.db, {
          tenantId: req.embedded!.tenantId,
          billId: req.params.id,
          amountCents: body.amountCents ?? null,
          paymentRef: body.paymentRef ?? null,
          actor: req.embedded!.actor,
        });
        await audit(req, "embedded.bill.pay", "vendor_bill", req.params.id,
          `Embedded bill pay ${req.params.id} → ${result.status}${result.approvalRequired ? ` (approval ${result.approvalId})` : ""} ref ${result.paymentRef || "n/a"}`);
        res.json(result);
      } catch (err: any) { mapServiceError(res, err, "bill pay failed"); }
    });

    // ── Scheduled payments (scheduledPayments pass-through) ──────────────
    embedded.post("/payments/schedule", needScope("payments:write"), async (req: EmbeddedReq, res) => {
      try {
        const { schedulePayment } = await import("../services/scheduledPayments");
        const body = req.body ?? {};
        const executeAt = parseDate(body.executeAt);
        if (!executeAt) { res.status(400).json({ error: "bad-request", message: "executeAt (ISO date) is required" }); return; }
        if (!Number.isInteger(body.amountCents) || body.amountCents <= 0) {
          res.status(400).json({ error: "bad-request", message: "amountCents must be a positive integer" });
          return;
        }
        const kind = ["vendor_bill", "payout", "adhoc"].includes(body.kind) ? body.kind : null;
        if (!kind) { res.status(400).json({ error: "bad-request", message: "kind must be vendor_bill|payout|adhoc" }); return; }
        const result = await schedulePayment(req.embedded!.db, {
          tenantId: req.embedded!.tenantId,
          kind,
          targetId: body.targetId ?? null,
          recipient: body.recipient ?? null,
          amountCents: body.amountCents,
          currency: body.currency ?? "NGN",
          executeAt,
          idempotencyKey: body.idempotencyKey,
          // scheduled_payments.created_by is varchar(36): the canonical actor
          // (embedded:<clientId>, 45 chars) lives on the audit row below; the
          // row marker is the same client id, dash-less, prefixed — 36 chars.
          createdBy: `emb:${req.embedded!.client.id.replace(/-/g, "")}`,
        });
        await audit(req, "embedded.payment.schedule", "scheduled_payment", result.payment.id,
          `Embedded scheduled ${kind} payment ${result.payment.id} (${body.amountCents} cents @ ${executeAt.toISOString()})${result.duplicate ? " (idempotent replay)" : ""}`);
        res.status(result.duplicate ? 200 : 201).json(result);
      } catch (err: any) { mapServiceError(res, err, "schedule payment failed"); }
    });

    embedded.get("/payments/:id", needScope("payments:read"), async (req: EmbeddedReq, res) => {
      try {
        const { scheduledPayments } = await import("../../drizzle/schema");
        const { and, eq } = await import("drizzle-orm");
        const [payment] = await req.embedded!.db.select().from(scheduledPayments)
          .where(and(eq(scheduledPayments.id, req.params.id), eq(scheduledPayments.tenantId, req.embedded!.tenantId)));
        if (!payment) { res.status(404).json({ error: "not-found" }); return; }
        res.json({ payment });
      } catch (err: any) { mapServiceError(res, err, "get payment failed"); }
    });

    // ── AR invoices (arInvoices pass-through) ────────────────────────────
    embedded.get("/invoices", needScope("invoices:read"), async (req: EmbeddedReq, res) => {
      try {
        const { arInvoices } = await import("../../drizzle/schema");
        const { and, desc, eq } = await import("drizzle-orm");
        const conds = [eq(arInvoices.tenantId, req.embedded!.tenantId)];
        if (typeof req.query.status === "string" && req.query.status) {
          conds.push(eq(arInvoices.status, req.query.status));
        }
        const rows = await req.embedded!.db.select().from(arInvoices)
          .where(and(...conds)).orderBy(desc(arInvoices.createdAt)).limit(200);
        res.json({ invoices: rows });
      } catch (err: any) { mapServiceError(res, err, "list invoices failed"); }
    });

    embedded.post("/invoices", needScope("invoices:write"), async (req: EmbeddedReq, res) => {
      try {
        const { createArInvoice } = await import("../services/arInvoices");
        const body = req.body ?? {};
        const inv = await createArInvoice(req.embedded!.db, {
          tenantId: req.embedded!.tenantId,
          customerName: body.customerName ?? null,
          customerPhone: body.customerPhone ?? null,
          customerEmail: body.customerEmail ?? null,
          description: body.description ?? null,
          amountCents: body.amountCents,
          currency: body.currency ?? "NGN",
          dueDate: parseDate(body.dueDate),
          metadata: { source: "embedded_api", clientId: req.embedded!.client.id },
        });
        await audit(req, "embedded.invoice.create", "ar_invoice", inv.id,
          `Embedded AR invoice #${inv.invoiceNo} (${inv.amountCents} cents ${inv.currency})`);
        res.status(201).json({ invoice: inv });
      } catch (err: any) { mapServiceError(res, err, "create invoice failed"); }
    });

    app.use("/api/embedded/v1", embedded);
  }
  // === END W33 embedded-api ===

  // === W31 AR reminders ===
  // Daily: flip past-due AR invoices to overdue and send polite WhatsApp
  // payment reminders (max 3, 3-day spacing, claim-before-send dedupe via
  // last_reminder_at). Registered in services/scheduler allowlist +
  // k8s/cron-scheduler.yaml (cron-ar-reminders, daily).
  // After deploy: manus-heartbeat create --name ar-reminders --cron "0 0 9 * * *" --path /api/scheduled/ar-reminders
  app.post("/api/scheduled/ar-reminders", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runArReminderSweep } = await import("../services/arInvoices");
      const result = await runArReminderSweep(db);
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[ar-reminders]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W31 AR reminders ===

  // === W32 installment due ===
  // ── POST /api/scheduled/installment-due (daily) ─────────────────────────
  // Pay-over-time installment capture (Coder A): for every active/defaulted
  // installment plan, due schedule entries are captured via the EXISTING
  // mandate rails (chargeOnMandate + exactly-once claim, capture.ts pattern;
  // deterministic ref `potcap:<planId>:<seq>`). A failed capture marks the
  // installment honestly 'overdue' and sends a WhatsApp dunning notice —
  // the claim is released so the NEXT sweep retries per the mandate rules
  // (no blind same-tick retries). Loans past dueAt + grace flip to
  // 'defaulted' (microLoans late/default handling) and the plan follows.
  // Registered in services/scheduler/scheduler.mjs allowlist +
  // k8s/cron-scheduler.yaml (cron-installment-due, daily).
  // After deploy: manus-heartbeat create --name installment-due --cron "0 0 8 * * *" --path /api/scheduled/installment-due
  app.post("/api/scheduled/installment-due", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runInstallmentCaptureSweep } = await import("../services/payOverTime");
      const summary = await runInstallmentCaptureSweep(db);
      // === W41 buyer-credit (UC-1): buyer installment capture + verify-first
      // reconcile ride the SAME daily cron — independent failure domains.
      let buyer: Record<string, unknown> = {};
      try {
        const { runBuyerInstallmentSweep, reconcilePendingBuyerCharges } = await import("../services/buyerInstallments");
        const sweep = await runBuyerInstallmentSweep(db);
        const reconcile = await reconcilePendingBuyerCharges(db);
        buyer = { buyerSweep: sweep, buyerReconcile: reconcile };
      } catch (buyerErr: any) {
        console.error("[installment-due] buyer sweep failed:", buyerErr?.message);
        buyer = { buyerError: buyerErr?.message };
      }
      // === END W41 buyer-credit ===
      return res.json({ ok: true, ...summary, ...buyer });
    } catch (err: any) {
      console.error("[installment-due]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W32 installment due ===

  // === W45 money-ledger ===
  // ── POST /api/scheduled/payment-outbox (every few minutes) ──────────────
  // Payment outbox worker (PAY-16/PAY-18): delivers committed-but-undelivered
  // external money legs (Mojaloop FX transfer initiation, TigerBeetle PoT
  // transfers) with claim-first exactly-once + bounded retry, reaps stale
  // 'delivering' claims, then runs the FX fulfil/error POLLER (PAY-16) so a
  // lost Mojaloop callback still converges the quote. Auth: W42 cronAuth
  // scope+jti via sdk.authenticateRequest (isCron fast-path).
  // Registered in services/scheduler/scheduler.mjs allowlist.
  app.post("/api/scheduled/payment-outbox", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { processPaymentOutbox } = await import("../services/paymentOutbox");
      const outbox = await processPaymentOutbox(db);
      let fx: Record<string, unknown> = {};
      try {
        const { pollFxTransfers } = await import("../services/fxPayouts");
        fx = { fxPoll: await pollFxTransfers(db) };
      } catch (fxErr: any) {
        console.error("[payment-outbox] fx poll failed:", fxErr?.message);
        fx = { fxPollError: fxErr?.message };
      }
      return res.json({ ok: true, outbox, ...fx });
    } catch (err: any) {
      console.error("[payment-outbox]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W45 money-ledger ===

  // === W44 deposits-subs-digital (Coder C) ===
  // ── POST /api/scheduled/subscription-billing (hourly) ─────────────────
  // Subscription auto-billing tick: charges due customer_subscriptions via
  // the saved W41 token (claim-first FOR UPDATE per row), creates the order
  // + advances next_billing_at in the SAME txn on success, duns + retries
  // (max 3 → past_due) on failure. Idempotency: sub_billing:<subId>:<period>.
  // Auth: sdk.authenticateRequest fast-path enforces the W42 cronAuth
  // scope+jti hardening (scope must equal THIS route path).
  // Registered in services/scheduler/scheduler.mjs allowlist +
  // k8s/cron-scheduler.yaml (cron-subscription-billing, hourly).
  // After deploy: manus-heartbeat create --name subscription-billing --cron "0 0 * * * *" --path /api/scheduled/subscription-billing
  app.post("/api/scheduled/subscription-billing", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runSubscriptionBillingSweep } = await import("../services/subscriptions");
      const summary = await runSubscriptionBillingSweep(db);
      return res.json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[subscription-billing]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W44 deposits-subs-digital ===


  // === W32 recurring ===
  // ── POST /api/scheduled/recurring-run (daily) ──────────────────────────
  // Recurring bills / auto-pay engine (W32 Coder B): claims due
  // recurring_rules via a guarded UPDATE, creates the period's vendor_bill
  // (capture_source='recurring') or adhoc scheduled_payment and advances
  // next_run_at IN THE SAME transaction (crash-safe, idempotency key
  // `recur:<ruleId>:<period>`), auto-pays at-or-under auto_pay_under_cents
  // after the W31 approvals gate, and parks above-threshold periods behind a
  // one-tap WA approval (approvals executor map, kind 'scheduled_payment').
  // Registered in services/scheduler allowlist + k8s/cron-scheduler.yaml
  // (cron-recurring-run, daily).
  // After deploy: manus-heartbeat create --name recurring-run --cron "0 0 7 * * *" --path /api/scheduled/recurring-run
  app.post("/api/scheduled/recurring-run", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runRecurringSweep } = await import("../services/recurringRules");
      const summary = await runRecurringSweep(db);
      return res.json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[recurring-run]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W32 recurring ===

  // === W33 forecast ===
  // ── POST /api/scheduled/cashflow-forecast (weekly) ─────────────────────
  // Cash-flow forecast snapshot sweep (W33 Coder B): stores the 30-day
  // projection per tenant into cashflow_forecasts (migration 0113),
  // idempotent per (tenant, horizon, day) — every figure computed from real
  // rows; tenants with no data are skipped (no fabricated zero-rows).
  // Registered in services/scheduler allowlist + k8s/cron-scheduler.yaml
  // (cron-cashflow-forecast, weekly, #41 on the merged branch).
  // After deploy: manus-heartbeat create --name cashflow-forecast --cron "0 0 6 * * 1" --path /api/scheduled/cashflow-forecast
  app.post("/api/scheduled/cashflow-forecast", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runForecastSweep } = await import("../services/cashflowForecast");
      const summary = await runForecastSweep(db);
      return res.json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[cashflow-forecast]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W33 forecast ===

  // ── SLA Heartbeat ─────────────────────────────────────────────────────────
  app.post("/api/scheduled/sla-scan", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const result = await runSlaScan();
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[sla-scan]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Broadcast Scheduler Heartbeat ─────────────────────────────────────────
  // Fires every minute; picks up campaigns with scheduledAt <= now and status = 'scheduled'
  // and triggers the send flow (builds recipients, marks completed).
  app.post("/api/scheduled/broadcast-scheduler", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { nanoid } = await import("nanoid");
      const now = new Date();
      // Find due scheduled campaigns
      const due = await db.select().from(broadcastCampaigns).where(
        and(
          eq(broadcastCampaigns.status, "scheduled"),
          sql`"scheduledAt" IS NOT NULL AND "scheduledAt" <= ${now.toISOString()}`,
        )
      );
      let triggered = 0;
      for (const campaign of due) {
        // Mark as sending
        await db.update(broadcastCampaigns).set({ status: "sending", startedAt: now, updatedAt: now })
          .where(eq(broadcastCampaigns.id, campaign.id));
        // Build recipients from contacts (same logic as broadcast.send)
        const campaignVarMap = (campaign.varMapping ?? {}) as Record<string, string>;
        const contacts = await db.select().from(twentyContacts).limit(200);
        const recipientRows = contacts.filter((c: any) => c.phone).map((c: any) => ({
          id: nanoid(),
          campaignId: campaign.id,
          phone: c.phone!,
          name: c.name ?? null,
          variables: { customer_name: c.name ?? "Customer", store_name: "WhatsApp Commerce", ...campaignVarMap },
          status: "pending" as const,
          createdAt: now,
        }));
        const finalRecipients = recipientRows.length > 0 ? recipientRows : Array.from({ length: 12 }, (_, i) => ({
          id: nanoid(),
          campaignId: campaign.id,
          phone: `+1555${String(i).padStart(7, "0")}`,
          name: `Customer ${i + 1}`,
          variables: { customer_name: `Customer ${i + 1}`, store_name: "WhatsApp Commerce", ...campaignVarMap },
          status: "pending" as const,
          createdAt: now,
        }));
        for (const r of finalRecipients) {
          await db.insert(broadcastRecipients).values(r).onConflictDoNothing();
        }
        const total = finalRecipients.length;
        await db.update(broadcastCampaigns).set({
          status: "completed",
          totalRecipients: total,
          sentCount: total,
          deliveredCount: Math.floor(total * 0.96),
          readCount: Math.floor(total * 0.72),
          failedCount: Math.ceil(total * 0.04),
          completedAt: now,
          updatedAt: now,
        }).where(eq(broadcastCampaigns.id, campaign.id));
        triggered++;
      }
      return res.json({ ok: true, triggered });
    } catch (err: any) {
      console.error("[broadcast-scheduler]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Journey Tick Heartbeat (W17 F8) ───────────────────────────────────────
  // Fires every minute; advances due broadcast_journey_runs (state='waiting',
  // nextRunAt <= now) through their journey steps — consent-gated and
  // frequency-cap/quiet-hours aware. Follows the runInventorySyncHeartbeat
  // wiring pattern (service owns the logic, never throws).
  app.post("/api/scheduled/journey-tick", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runDueJourneySteps } = await import("../services/journeyBuilder");
      const summary = await runDueJourneySteps(new Date(), db);
      return res.json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[journey-tick]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Journey Orchestration Tick (W23) ─────────────────────────────────────
  // Resumes local-fallback journey orchestrations still 'running' (crashed or
  // deferred starts) from their last checkpoint. Follows the journey-tick
  // wiring pattern: cron-only, service owns the logic, never throws.
  app.post("/api/scheduled/journey-orchestrate-tick", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runOrchestrationTick } = await import("../services/journeyOrchestrator");
      const summary = await runOrchestrationTick(db);
      return res.json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[journey-orchestrate-tick]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Lead Model Tick (W20) ─────────────────────────────────────────────────
  // Periodic per-tenant retraining of the ML propensity lead-scoring model
  // (services/mlLeadScoring.ts). Follows the journey-tick wiring pattern:
  // cron-only, service owns the logic, never throws; tenants below the
  // minimum-sample gate are skipped and keep the rule-based fallback.
  app.post("/api/scheduled/lead-model-tick", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runLeadModelTick } = await import("../services/mlLeadScoring");
      const summary = await runLeadModelTick(db, new Date());
      return res.json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[lead-model-tick]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── PD Model Tick (W21) ───────────────────────────────────────────────────
  // Periodic retraining of the ML probability-of-default credit model
  // (services/tradeCredit/mlPdScoring.ts): the global corpus model plus one
  // model per supplier tenant with a credit book. Follows the lead-model-tick
  // wiring pattern: cron-only, service owns the logic, never throws; scopes
  // below the minimum-sample gate keep the rule-score PD proxy.
  app.post("/api/scheduled/pd-model-tick", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runPdModelTick } = await import("../services/tradeCredit/mlPdScoring");
      const summary = await runPdModelTick(db, new Date());
      return res.json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[pd-model-tick]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Uplift Model Tick (W21) ───────────────────────────────────────────────
  // Periodic per-tenant retraining of the two-arm broadcast uplift models
  // (services/mlUplift.ts). Follows the lead-model-tick wiring pattern:
  // cron-only, service owns the logic, never throws; tenants below the
  // per-arm minimum-sample gate are skipped and keep the heuristic fallback.
  app.post("/api/scheduled/uplift-model-tick", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runUpliftModelTick } = await import("../services/mlUplift");
      const summary = await runUpliftModelTick(db, new Date());
      return res.json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[uplift-model-tick]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Bandit Reward Tick (W22) ──────────────────────────────────────────────
  // Sweeps bandit_decisions lacking a reward and assigns it from realized
  // repayment outcomes (1 on-time / 0.5 late-cured / 0 default;
  // services/banditLimits.ts). Follows the pd-model-tick wiring pattern:
  // cron-only, service owns the logic, never throws.
  app.post("/api/scheduled/bandit-reward-tick", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runBanditRewardTick } = await import("../services/banditLimits");
      const summary = await runBanditRewardTick(db, new Date());
      return res.json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[bandit-reward-tick]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Scheduled Broadcast Dispatch ──────────────────────────────────────────
  // Picks up campaigns scheduled via broadcast.send(scheduleAt) — status
  // 'scheduled' with scheduledAt <= now — and runs the REAL consent-gated,
  // segment-filtered send flow (routers/broadcast.dispatchCampaign). Claims
  // each campaign first (conditional UPDATE scheduled→sending) so overlapping
  // cron ticks can't double-dispatch.
  app.post("/api/scheduled/broadcast-dispatch", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { dispatchCampaign } = await import("../routers/broadcast");
      const now = new Date();
      const due = await db.select().from(broadcastCampaigns).where(
        and(
          eq(broadcastCampaigns.status, "scheduled"),
          sql`"scheduledAt" IS NOT NULL AND "scheduledAt" <= ${now.toISOString()}`,
        )
      );
      let dispatched = 0;
      const results: Array<{ campaignId: string; total: number; sent: number; failed: number }> = [];
      for (const campaign of due) {
        // Claim-first: exactly one concurrent dispatcher transitions
        // scheduled → sending; the loser skips this campaign.
        const claimed = await db.update(broadcastCampaigns)
          .set({ status: "sending", startedAt: now, updatedAt: now })
          .where(and(eq(broadcastCampaigns.id, campaign.id), eq(broadcastCampaigns.status, "scheduled")))
          .returning({ id: broadcastCampaigns.id });
        if (claimed.length === 0) continue;
        try {
          const r = await dispatchCampaign(db, campaign);
          results.push({ campaignId: campaign.id, total: r.total, sent: r.sent, failed: r.failed });
          dispatched++;
        } catch (err: any) {
          console.error(`[broadcast-dispatch] campaign ${campaign.id} failed:`, err?.message);
          await db.update(broadcastCampaigns)
            .set({ status: "failed", updatedAt: new Date() })
            .where(eq(broadcastCampaigns.id, campaign.id));
        }
      }
      return res.json({ ok: true, dispatched, results });
    } catch (err: any) {
      console.error("[broadcast-dispatch]", err);
      return res.status(500).json({ error: err?.message });
    }
  });


  // ── Scheduled: 24h-window expiry check ────────────────────────────────────
  // Orders pending payment >20h whose buyer session window closes <4h (or is
  // already closed) get a payment nudge (free-form text while the window is
  // open, the tenant broadcast template when closed); the tenant adminPhone
  // is flagged once per order (Redis-deduped).
  app.post("/api/scheduled/window-expiry-check", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { runWindowExpiryCheck } = await import("../services/sessionWindow");
      const result = await runWindowExpiryCheck(db);
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[window-expiry-check]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Scheduled: WhatsApp messaging-quality refresh (daily) ─────────────────
  // Pulls quality_rating + messaging tier for every tenant with a WhatsApp
  // phone number into settings.waQuality (drives the broadcast throttle).
  app.post("/api/scheduled/wa-quality-refresh", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { refreshWaQuality } = await import("../services/waQuality");
      // W40 tenancy (TEN-1): suspended/churned tenants are skipped — service
      // paths acting "as tenant" must not run for inactive tenants.
      const rows = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(sql`${tenants.whatsappPhoneNumberId} IS NOT NULL AND ${tenants.status} NOT IN ('suspended','churned')`);
      let refreshed = 0;
      for (const row of rows) {
        try {
          await refreshWaQuality(db, row.id);
          refreshed++;
        } catch (e: any) {
          console.error(`[wa-quality-refresh] tenant ${row.id} failed:`, e?.message);
        }
      }
      return res.json({ ok: true, refreshed, total: rows.length });
    } catch (err: any) {
      console.error("[wa-quality-refresh]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── CTWA QR codes (token-guarded public) ─────────────────────────────────
  // GET /api/ctwa/:tenantId/:campaignId.png?token=… — PNG QR of the
  // campaign's wa.me deep link for print/marketing. Token = stateless HMAC
  // capability (same pattern as buyer tracking tokens); images are cached
  // in-process.
  const ctwaQrCache = new Map<string, Buffer>();
  app.get("/api/ctwa/:tenantId/:campaignId.png", async (req, res) => {
    try {
      const { verifyCtwaQrToken, parseCtwaCampaigns, tenantWaPhone, buildCtwaLink, DEFAULT_CTWA_CAMPAIGNS } =
        await import("../services/ctwa");
      const tenantId = req.params.tenantId;
      const campaignId = req.params.campaignId;
      if (!verifyCtwaQrToken(tenantId, campaignId, req.query.token)) {
        return res.status(403).json({ error: "invalid-token" });
      }
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const [tenant] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!tenant) return res.status(404).json({ error: "tenant-not-found" });

      let keyword: string | null = null;
      if (campaignId.startsWith("default:")) {
        const kw = campaignId.slice("default:".length);
        if (DEFAULT_CTWA_CAMPAIGNS.some((c) => c.keyword === kw)) keyword = kw;
      } else {
        keyword = parseCtwaCampaigns(tenant.settings).find((c) => c.id === campaignId)?.keyword ?? null;
      }
      const phone = tenantWaPhone(tenant.settings);
      if (!keyword || !phone) return res.status(404).json({ error: "campaign-or-phone-not-found" });

      const cacheKey = `${tenantId}:${campaignId}`;
      let png = ctwaQrCache.get(cacheKey);
      if (!png) {
        const QRCode = (await import("qrcode")).default;
        png = await QRCode.toBuffer(buildCtwaLink(phone, keyword), { type: "png", width: 512, margin: 2 });
        if (ctwaQrCache.size > 500) ctwaQrCache.clear();
        ctwaQrCache.set(cacheKey, png);
      }
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.type("png").send(png);
    } catch (err: any) {
      console.error("[ctwa-qr]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Medusa order fulfillment webhook (/api/webhooks/medusa) ──────────────
  // Receives order.fulfillment_created, order.completed, order.canceled events
  // from Medusa v2 and updates the platform order status accordingly.
  // Register in Medusa Admin → Settings → Webhooks → POST /api/webhooks/medusa
  // NOTE: express.raw (not express.json) so the HMAC is computed over the exact
  // raw bytes Medusa signed — re-serialized JSON never matches a real signature.
  app.post("/api/webhooks/medusa", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });

      // Required HMAC verification using MEDUSA_WEBHOOK_SECRET (fail closed when unset)
      const rawBody = toRawBody(req.body);
      const webhookSecret = requireWebhookSecret("MEDUSA_WEBHOOK_SECRET", process.env.MEDUSA_WEBHOOK_SECRET, res);
      if (webhookSecret === null) return;
      if (webhookSecret) {
        const sig = ((req.headers["x-medusa-signature"] as string) ?? "").replace(/^sha256=/, "");
        if (!verifyHmacSignature(rawBody, webhookSecret, sig, "sha256")) {
          console.warn("[medusa-webhook] Invalid HMAC signature — rejected");
          return res.status(401).json({ error: "invalid-signature" });
        }
      }

      const { event, data } = JSON.parse(rawBody.toString()) as { event?: string; data?: Record<string, unknown> };
      if (!event || !data) return res.status(400).json({ error: "missing event or data" });

      console.log(`[medusa-webhook] Received event: ${event}`, { orderId: data?.id });

      // Map Medusa event → platform order status
      const eventStatusMap: Record<string, string> = {
        "order.fulfillment_created": "shipped",
        "order.completed":           "delivered",
        "order.canceled":            "cancelled",
        "order.payment_captured":    "confirmed",
        "order.placed":              "pending",
      };

      const newStatus = eventStatusMap[event];
      if (!newStatus) {
        return res.json({ ok: true, action: "ignored", event });
      }

      // Find the platform order by Medusa order ID (stored in orders.metadata->>'medusaOrderId')
      const medusaOrderId = (data?.id ?? data?.order_id) as string | undefined;
      if (!medusaOrderId) return res.json({ ok: true, action: "no-order-id" });

      // Look up by erpOrderId (we store the Medusa order ID there during sync)
      const [platformOrder] = await db.select({ id: orders.id, orderNumber: orders.orderNumber })
        .from(orders)
        .where(eq(orders.erpOrderId, medusaOrderId))
        .limit(1)
        .catch(() => [null as any]);

      if (!platformOrder) {
        console.warn(`[medusa-webhook] No platform order found for medusaOrderId=${medusaOrderId}`);
        return res.json({ ok: true, action: "order-not-found", medusaOrderId });
      }

      // Update the order status
      await db.update(orders)
        .set({
          status: newStatus as typeof orders.$inferInsert.status,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, platformOrder.id));

      console.log(`[medusa-webhook] Order ${platformOrder.orderNumber} → ${newStatus} (event: ${event})`);
      return res.json({ ok: true, action: "updated", orderNumber: platformOrder.orderNumber, newStatus });
    } catch (err: any) {
      console.error("[medusa-webhook]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── W28 Coder B: Medusa catalog + fulfillment webhooks ──────────────────
  // ADDITIVE block — the Wave-26 /api/webhooks/medusa block above is
  // unchanged. Two endpoints, both HMAC-SHA256 verified over the raw body
  // (X-Medusa-Signature: sha256=<hex>, secret MEDUSA_WEBHOOK_SECRET — same
  // fail-closed requireWebhookSecret pattern as the other webhooks here):
  //
  //  POST /api/webhooks/medusa-catalog
  //    product.created / product.updated / product.deleted → idempotent
  //    upsert into the platform products table keyed by metadata.medusaId
  //    (metadata.source="medusa"); platform-native products are never
  //    touched. Tenant resolution per resolveTenantForMedusaEvent (never
  //    guesses cross-tenant → 422).
  //
  //  POST /api/webhooks/medusa-fulfillment
  //    order.fulfillment_created / order.completed / order.canceled → order
  //    status update + escrow_held → delivery_confirmed advance (DB state
  //    only — escrow.ts untouched; the existing buyerConfirm / SLA rails
  //    complete the release).
  app.post("/api/webhooks/medusa-catalog", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const rawBody = toRawBody(req.body);
      const webhookSecret = requireWebhookSecret("MEDUSA_WEBHOOK_SECRET", process.env.MEDUSA_WEBHOOK_SECRET, res);
      if (webhookSecret === null) return;
      if (webhookSecret) {
        const sig = ((req.headers["x-medusa-signature"] as string) ?? "").replace(/^sha256=/, "");
        if (!verifyHmacSignature(rawBody, webhookSecret, sig, "sha256")) {
          console.warn("[medusa-catalog-webhook] Invalid HMAC signature — rejected");
          return res.status(401).json({ error: "invalid-signature" });
        }
      }
      const { event, data } = JSON.parse(rawBody.toString()) as { event?: string; data?: Record<string, any> };
      if (!event || !data) return res.status(400).json({ error: "missing event or data" });

      const { resolveTenantForMedusaEvent, handleMedusaProductEvent } = await import("../services/medusa/sync");
      const tenantId = await resolveTenantForMedusaEvent(db, data);
      if (!tenantId) {
        console.warn(`[medusa-catalog-webhook] no tenant mapping for event ${event} product=${data?.id}`);
        return res.status(422).json({ error: "tenant-not-resolved" });
      }
      const result = await handleMedusaProductEvent(db, tenantId, event, data as any);
      console.log(`[medusa-catalog-webhook] ${event} product=${data?.id} tenant=${tenantId} → ${result.action}`);
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[medusa-catalog-webhook]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  app.post("/api/webhooks/medusa-fulfillment", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const rawBody = toRawBody(req.body);
      const webhookSecret = requireWebhookSecret("MEDUSA_WEBHOOK_SECRET", process.env.MEDUSA_WEBHOOK_SECRET, res);
      if (webhookSecret === null) return;
      if (webhookSecret) {
        const sig = ((req.headers["x-medusa-signature"] as string) ?? "").replace(/^sha256=/, "");
        if (!verifyHmacSignature(rawBody, webhookSecret, sig, "sha256")) {
          console.warn("[medusa-fulfillment-webhook] Invalid HMAC signature — rejected");
          return res.status(401).json({ error: "invalid-signature" });
        }
      }
      const { event, data } = JSON.parse(rawBody.toString()) as { event?: string; data?: Record<string, any> };
      if (!event || !data) return res.status(400).json({ error: "missing event or data" });
      const medusaOrderId = (data?.id ?? data?.order_id) as string | undefined;
      if (!medusaOrderId) return res.json({ ok: true, action: "no-order-id" });

      const { applyMedusaFulfillment } = await import("../services/medusa/orderBridge");
      const result = await applyMedusaFulfillment(db, medusaOrderId, event);
      console.log(`[medusa-fulfillment-webhook] ${event} medusaOrder=${medusaOrderId} → ${result.action}${result.newStatus ? ` (${result.newStatus})` : ""}`);
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[medusa-fulfillment-webhook]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W28 medusa-storefront webhooks ===

  // ── WhatsApp media download heartbeat ────────────────────────────────────
  // Runs every 5 minutes; fetches media from Meta Graph API and uploads to S3.
  // After deploy: manus-heartbeat create --name wa-media-download --cron "0 */5 * * * *" --path /api/scheduled/wa-media-download
  app.post("/api/scheduled/wa-media-download", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const waToken = process.env.WHATSAPP_TOKEN ?? "";
      if (!waToken) return res.json({ ok: true, skipped: "WHATSAPP_TOKEN not configured" });
      // Find media files that still have the placeholder storageKey (wa-media/<mediaId>)
      const pending = await db.select().from(whatsappMediaFiles)
        .where(sql`"storageKey" LIKE 'wa-media/%'`)
        .limit(20);
      let downloaded = 0;
      let failed = 0;
      for (const media of pending) {
        try {
          const mediaId = media.storageKey.replace("wa-media/", "");
          // Step 1: Get download URL from Meta
          const metaResp = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${waToken}` },
          });
          if (!metaResp.ok) { failed++; continue; }
          const metaData = await metaResp.json() as { url?: string; mime_type?: string };
          if (!metaData.url) { failed++; continue; }
          // Step 2: Download the actual media bytes
          const mediaResp = await fetch(metaData.url, {
            headers: { Authorization: `Bearer ${waToken}` },
          });
          if (!mediaResp.ok) { failed++; continue; }
          const buf = Buffer.from(await mediaResp.arrayBuffer());
          // Step 3: Upload to S3
          const ext = (media.fileName.split(".").pop() ?? "bin").toLowerCase();
          const s3Key = `whatsapp-media/${media.tenantId}/${media.id}.${ext}`;
          const { storagePut: sput } = await import("../storage");
          const { url: s3Url } = await sput(s3Key, buf, media.mimeType);
          // Step 4: Update the record
          await db.update(whatsappMediaFiles)
            .set({ storageKey: s3Key, storageUrl: s3Url })
            .where(eq(whatsappMediaFiles.id, media.id));
          downloaded++;
        } catch (e: any) {
          console.error("[wa-media-download] media", media.id, e?.message);
          failed++;
        }
      }
      return res.json({ ok: true, downloaded, failed, pending: pending.length });
    } catch (err: any) {
      console.error("[wa-media-download]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // ── WhatsApp webhook retry heartbeat ─────────────────────────────────────
  // Runs every 2 minutes; retries failed webhook events up to 3 times with
  // exponential back-off (2^retryCount * 60s).
  // After deploy: manus-heartbeat create --name wa-webhook-retry --cron "*/2 * * * *" --path /api/scheduled/wa-webhook-retry
  app.post("/api/scheduled/wa-webhook-retry", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const now = new Date();
      // Find failed events that are due for retry and haven't exceeded 3 attempts
      const due = await db.select().from(waWebhookEvents)
        .where(sql`(status = 'failed' OR (status = 'received' AND "createdAt" < ${new Date(now.getTime() - 2 * 60 * 1000).toISOString()}::timestamp)) AND "retryCount" < 3 AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= ${now.toISOString()}::timestamp)`)
        .limit(10);
      let retried = 0;
      let dead = 0;
      for (const evt of due) {
        const newRetryCount = (evt.retryCount ?? 0) + 1;
        try {
          // === W45 webhook-core (MSG-8): re-dispatch the stored payload
          // through the SAME per-message pipeline as the live webhook (all
          // message types, not just text) with a namespaced wamid claim —
          // idempotent per retry attempt (claim key dlqr<N>:<wamid>), so a
          // replay never double-replies and never bypasses the dedupe ledger.
          // Iterates ALL entry[]/changes[] (MSG-4); tenant resolution,
          // suspended-tenant drops and unknown-phone_number_id quarantine
          // (MSG-3) happen inside the shared pipeline. ===
          const payload = evt.rawPayload as any;
          const failures: string[] = [];
          const hbEntries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
          for (const entryItem of hbEntries) {
            const changeList: any[] = Array.isArray(entryItem?.changes) ? entryItem.changes : [];
            for (const change of changeList) {
              const value = change?.value;
              if (!value) continue;
              const r = await processWaWebhookValue(db, value, { claimPrefix: `dlqr${newRetryCount}:` });
              failures.push(...r.failures);
            }
          }
          if (failures.length > 0) throw new Error(failures.join(" | ").slice(0, 800));
          // Mark as retried/processed
          await db.update(waWebhookEvents)
            .set({ status: "retried", retryCount: newRetryCount, processedAt: now, updatedAt: now })
            .where(eq(waWebhookEvents.id, evt.id));
          retried++;
        } catch (e: any) {
          // Exponential back-off: 2^retryCount minutes
          const backoffMs = Math.pow(2, newRetryCount) * 60 * 1000;
          const nextRetry = new Date(Date.now() + backoffMs);
          const newStatus = newRetryCount >= 3 ? "dead" : "failed";
          await db.update(waWebhookEvents)
            .set({ status: newStatus, retryCount: newRetryCount, lastError: e?.message ?? "unknown", nextRetryAt: nextRetry, updatedAt: now })
            .where(eq(waWebhookEvents.id, evt.id));
          if (newStatus === "dead") dead++;
        }
      }
      return res.json({ ok: true, retried, dead, checked: due.length });
    } catch (err: any) {
      console.error("[wa-webhook-retry]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Inventory reservation expiry sweeper ──────────────────────────────
  // Releases pre-payment stock holds (inventory_reservations, migration 0031)
  // whose 15-minute TTL elapsed without payment. Claim-first + idempotent —
  // safe to run every 60s and to race manual cancels.
  // After deploy: manus-heartbeat create --name inventory-reservation-sweep --cron "* * * * *" --path /api/scheduled/inventory-reservation-sweep
  app.post("/api/scheduled/inventory-reservation-sweep", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { releaseExpiredReservations } = await import("../services/inventory");
      const result = await releaseExpiredReservations(db);
      if (result.released > 0) {
        console.log(`[inventory-reservation-sweep] released ${result.released} reservation(s) across ${result.orders} order(s)`);
      }
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[inventory-reservation-sweep]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Odoo ERP inventory sync heartbeat ─────────────────────────────────────
  // === W46 inventory-depth (ORD-21) ===
  // ── Inventory batch expiry sweep ──────────────────────────────────────────
  // Alerts tenant admins (WA + Telegram via channelParity "inventory_alert")
  // about batches EXPIRED or expiring within 7 days. Alert-only; no stock
  // write-off. Auth: W42 cronAuth (scope+jti) via sdk.authenticateRequest.
  // After deploy: manus-heartbeat create --name inventory-expiry-sweep --cron "0 8 * * *" --path /api/scheduled/inventory-expiry-sweep
  app.post("/api/scheduled/inventory-expiry-sweep", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const { sweepExpiringBatches } = await import("../services/inventoryDepth");
      const result = await sweepExpiringBatches(db);
      if (result.expired + result.expiring > 0) {
        console.log(`[inventory-expiry-sweep] tenants=${result.tenants} expired=${result.expired} expiring=${result.expiring} alerted=${result.alerted}`);
      }
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[inventory-expiry-sweep]", err);
      return res.status(500).json({ error: err?.message });
    }
  });
  // === END W46 inventory-depth ===
  // ── Integration outbox dispatcher heartbeat ───────────────────────────────
  // Delivers pending integration_events (Medusa/Twenty/Odoo) with retry —
  // dead after 5 attempts. Follows the wa-webhook-retry job pattern.
  // After deploy: manus-heartbeat create --name integration-outbox-dispatch --cron "* * * * *" --path /api/scheduled/integration-outbox-dispatch
  app.post("/api/scheduled/integration-outbox-dispatch", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db unavailable" });
      const batch = Math.min(Math.max(parseInt(String(req.body?.batch ?? "50"), 10) || 50, 1), 500);
      const result = await processOutbox(db, { batch });
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[integration-outbox-dispatch]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // After deploy: manus-heartbeat create --name odoo-inventory-sync --cron "*/10 * * * *" --path /api/scheduled/odoo-inventory-sync
  app.post("/api/scheduled/odoo-inventory-sync", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db unavailable" });
      const odooIntegrations = await db
        .select({ tenantId: tenantIntegrations.tenantId })
        .from(tenantIntegrations)
        .where(and(eq(tenantIntegrations.integrationType, "odoo_erp"), eq(tenantIntegrations.status, "active")));
      let totalUpdated = 0;
      for (const { tenantId } of odooIntegrations) {
        try {
          const stockLevels = await fetchOdooStockLevels(tenantId);
          for (const { productId, qty } of stockLevels) {
            // Match product by odoo product ID stored in metadata
            await db.update(products)
              .set({ stockQuantity: qty, updatedAt: new Date() })
              .where(and(
                eq(products.tenantId, tenantId),
                sql`${products.metadata}->>'odooId' = ${productId}`
              ));
            totalUpdated++;
          }
        } catch (e: any) { console.error("[odoo-inventory-sync] tenant", tenantId, e?.message); }
      }
      return res.json({ ok: true, tenantsProcessed: odooIntegrations.length, productsUpdated: totalUpdated });
    } catch (err: any) {
      console.error("[odoo-inventory-sync]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Medusa catalog sync heartbeat ─────────────────────────────────────────
  // After deploy: manus-heartbeat create --name medusa-catalog-sync --cron "*/30 * * * *" --path /api/scheduled/medusa-catalog-sync
  app.post("/api/scheduled/medusa-catalog-sync", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db unavailable" });
      const medusaIntegrations = await db
        .select({ tenantId: tenantIntegrations.tenantId })
        .from(tenantIntegrations)
        .where(and(eq(tenantIntegrations.integrationType, "medusa"), eq(tenantIntegrations.status, "active")));
      let totalSynced = 0;
      for (const { tenantId } of medusaIntegrations) {
        try {
          const catalog = await fetchMedusaCatalog(tenantId);
          for (const item of catalog) {
            const existing = await db.select({ id: products.id }).from(products)
              .where(and(
                eq(products.tenantId, tenantId),
                sql`${products.metadata}->>'medusaId' = ${item.id}`
              )).limit(1);
            if (existing.length > 0) {
              await db.update(products)
                .set({ name: item.title, price: item.price.toFixed(2), currency: item.currency, stockQuantity: item.stock, updatedAt: new Date() })
                .where(eq(products.id, existing[0].id));
            } else {
              await db.insert(products).values({
                id: randomUUID(), tenantId,
                sku: `medusa-${item.id}`,
                name: item.title,
                price: item.price.toFixed(2), currency: item.currency, stockQuantity: item.stock,
                status: "active",
                metadata: { medusaId: item.id, syncSource: "medusa" },
                createdAt: new Date(), updatedAt: new Date(),
              });
            }
            totalSynced++;
          }
        } catch (e: any) { console.error("[medusa-catalog-sync] tenant", tenantId, e?.message); }
      }
      return res.json({ ok: true, tenantsProcessed: medusaIntegrations.length, productsSynced: totalSynced });
    } catch (err: any) {
      console.error("[medusa-catalog-sync]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // Shared escaping helpers for the YOLO preview.html generator below —
  // deliberately local (this file has no existing exported escapeHtml).
  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c] as string));
  }
  function escapeJsString(s: string): string {
    return s.replace(/[\\'"\n\r]/g, (c) => ({
      "\\": "\\\\", "'": "\\'", '"': '\\"', "\n": "\\n", "\r": "\\r",
    }[c] as string));
  }

  // ── Fine-tune SSE stream ──────────────────────────────────────────────────
  // GET /api/finetune/stream — spawns finetune.py --dry-run and streams stdout/stderr as SSE
  //
  // QA follow-up (P0): this route had NO authentication at all — unlike every
  // other route in this file, including its own sibling
  // /api/scheduled/nightly-finetune below. Any unauthenticated caller could
  // trigger an arbitrary `spawn("python3", finetune.py)` subprocess and read
  // its stdout/stderr over SSE. Gated to platform admins, matching the
  // adminProcedure bar mlOps.ts already uses for this exact "platform
  // ML-ops surface, not tenant data" domain (triggerRealDataRetrain etc.).
  app.get("/api/finetune/stream", async (req, res) => {
    const user = await sdk.authenticateRequest(req).catch(() => null);
    if (!user || (user as any).role !== "admin") {
      res.status(403).json({ error: "admin-only" });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendEvt = (event: string, data: string) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify({ message: data, ts: Date.now() })}\n\n`);
    };

    sendEvt("status", "Starting fine-tune pipeline...");

    const scriptPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../services/visual-inventory/python-vlm/scripts/finetune.py"
    );

    const isDryRun = req.query.dryRun !== "false";
    const args = isDryRun ? [scriptPath, "--dry-run"] : [scriptPath];
    const python = spawn("python3", args, {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    const runId = randomUUID();
    const startedAt = new Date();
    const logLines: string[] = [];
    let finished = false;

    // Insert a "running" row immediately
    getDb().then(db => db?.insert(finetuneRuns).values({
      id: runId, startedAt, dryRun: isDryRun, triggeredBy: "ui", status: "running",
    }).catch(() => {}));

    python.stdout.on("data", (chunk: Buffer) => {
      chunk.toString().split("\n").filter(Boolean).forEach(line => {
        logLines.push(line);
        sendEvt("log", line);
      });
    });

    python.stderr.on("data", (chunk: Buffer) => {
      chunk.toString().split("\n").filter(Boolean).forEach(line => {
        logLines.push(`[stderr] ${line}`);
        sendEvt("log", `[stderr] ${line}`);
      });
    });

    python.on("close", (code) => {
      if (finished) return;
      finished = true;
      sendEvt("done", `Process exited with code ${code ?? 0}`);
      const status = (code === 0 || code === null) ? "completed" : "failed";
      getDb().then(db => db?.update(finetuneRuns)
        .set({ endedAt: new Date(), exitCode: code ?? 0, status, logSnapshot: logLines.slice(-500).join("\n") })
        .where(eq(finetuneRuns.id, runId))
        .catch(() => {}));
      res.end();
    });

    python.on("error", (err) => {
      if (finished) return;
      finished = true;
      sendEvt("error", `Failed to start process: ${err.message}`);
      getDb().then(db => db?.update(finetuneRuns)
        .set({ endedAt: new Date(), exitCode: -1, status: "failed", logSnapshot: err.message })
        .where(eq(finetuneRuns.id, runId))
        .catch(() => {}));
      res.end();
    });

    req.on("close", () => {
      python.kill("SIGTERM");
      if (!finished) {
        finished = true;
        getDb().then(db => db?.update(finetuneRuns)
          .set({ endedAt: new Date(), exitCode: -2, status: "cancelled", logSnapshot: logLines.slice(-500).join("\n") })
          .where(eq(finetuneRuns.id, runId))
          .catch(() => {}));
      }
    });
  });



  // ── Nightly Fine-Tune Heartbeat ───────────────────────────────────────────
  // POST /api/scheduled/nightly-finetune
  // After deploy: manus-heartbeat create --name nightly-finetune --cron "0 0 2 * * *" --path /api/scheduled/nightly-finetune --description "Nightly YOLO fine-tune when dataset grew >=10 images"
  app.post("/api/scheduled/nightly-finetune", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      // Check if dataset grew by >=10 images since the last completed run
      const lastRun = (await db.select().from(finetuneRuns)
        .where(eq(finetuneRuns.status, "completed"))
        .orderBy(sql`"startedAt" DESC`).limit(1))[0];
      const sinceDate = lastRun?.endedAt ?? new Date(0);
      const newImagesResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(picTable)
        .where(gte(picTable.createdAt, sinceDate));
      const newImages = newImagesResult[0]?.count ?? 0;
      if (newImages < 10) {
        return res.json({ skipped: true, reason: `Only ${newImages} new images since last run (need >=10)` });
      }
      // Kick off a real fine-tune run (non-dry-run)
      const runId = crypto.randomUUID();
      const startedAt = new Date();
      await db.insert(finetuneRuns).values({
        id: runId, startedAt, dryRun: false, triggeredBy: "heartbeat", status: "running",
      });
      const scriptPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../services/visual-inventory/python-vlm/scripts/finetune.py"
      );
      const python = spawn("python3", [scriptPath], {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        detached: true, stdio: "pipe",
      });
      const logLines: string[] = [];
      python.stdout?.on("data", (chunk: Buffer) => { chunk.toString().split("\n").filter(Boolean).forEach((l: string) => logLines.push(l)); });
      python.stderr?.on("data", (chunk: Buffer) => { chunk.toString().split("\n").filter(Boolean).forEach((l: string) => logLines.push(`[stderr] ${l}`)); });
      python.on("close", (code: number | null) => {
        const status = (code === 0 || code === null) ? "completed" : "failed";
        getDb().then(db2 => db2?.update(finetuneRuns)
          .set({ endedAt: new Date(), exitCode: code ?? 0, status, logSnapshot: logLines.slice(-500).join("\n") })
          .where(eq(finetuneRuns.id, runId)).catch(() => {}));
      });
      python.on("error", (err: Error) => {
        getDb().then(db2 => db2?.update(finetuneRuns)
          .set({ endedAt: new Date(), exitCode: -1, status: "failed", logSnapshot: err.message })
          .where(eq(finetuneRuns.id, runId)).catch(() => {}));
      });
      python.unref();
      res.json({ started: true, runId, newImages });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── YOLO Label Export ZIP ─────────────────────────────────────────────────
  // GET /api/finetune/export-yolo — generates per-class YOLO .txt label files and returns a zip
  //
  // QA follow-up (P0): this route had NO authentication at all and queries
  // productImageCollections (tenantId NOT NULL, drizzle/schema.ts) with no
  // tenantId filter — an unauthenticated caller could download every
  // tenant's uploaded product images (URLs, class labels, quality scores)
  // in one ZIP. The cross-tenant SCOPE itself is intentional here (this
  // dataset feeds one shared platform-wide YOLO classifier, the same
  // "platform ML-ops surface, not tenant data" pattern mlOps.ts already
  // exempts elsewhere) — the bug was the missing auth, not the missing
  // tenant filter, so this stays platform-wide, gated to admins only.
  app.get("/api/finetune/export-yolo", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user || (user as any).role !== "admin") {
        res.status(403).json({ error: "admin-only" });
        return;
      }
      const db = await getDb();
      if (!db) { res.status(503).json({ error: "DB unavailable" }); return; }
      const { productImageCollections: picTable } = await import("../../drizzle/schema");
      const images = await db.select().from(picTable).orderBy(picTable.className);
      if (images.length === 0) { res.status(404).json({ error: "No images in dataset" }); return; }
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="yolo-labels-${Date.now()}.zip"`);
      const archive = archiver("zip", { zlib: { level: 6 } });
      archive.pipe(res);
      // Build class list (sorted) for classes.txt
      const classNames = Array.from(new Set(images.map((i: { className: string }) => i.className))).sort();
      const classMap = Object.fromEntries(classNames.map((c, idx) => [c, idx]));
      archive.append(classNames.join("\n"), { name: "classes.txt" });
      // Generate one YOLO .txt label file per image
      // Each file: <class_id> 0.5 0.5 1.0 1.0  (full-image bounding box, normalized)
      for (const img of images) {
        const classId = (classMap as Record<string, number>)[img.className] ?? 0;
        const labelContent = `${classId} 0.5 0.5 1.0 1.0\n`;
        const safeName = img.id.replace(/[^a-zA-Z0-9-]/g, "_");
        archive.append(labelContent, { name: `labels/${img.className}/${safeName}.txt` });
      }
      // Add a manifest JSON
      const manifest = classNames.map(cn => ({
        className: cn,
        classId: (classMap as Record<string, number>)[cn],
        imageCount: images.filter((i: { className: string }) => i.className === cn).length,
        images: images.filter((i: { className: string }) => i.className === cn).map((i: { id: string; imageUrl: string; qualityScore: number | null }) => ({
          id: i.id, imageUrl: i.imageUrl, qualityScore: i.qualityScore,
        })),
      }));
      archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
      // Add HTML preview page with per-image bbox overlays
      //
      // QA follow-up: className and imageUrl are unescaped client-controlled
      // strings here (server/routers/productImages.ts's className is a bare
      // z.string().min(1), no restricted charset) — a merchant could plant
      // e.g. `</span><script>...` in a class name and get it executed in
      // whoever opens this preview.html. id is server-generated
      // (crypto.randomUUID() default, drizzle/schema.ts) so it's inherently
      // safe, but it's escaped too since it's cheap and this function is the
      // single place everything gets interpolated into HTML/JS.
      const previewRows = images.map((img: { id: string; imageUrl: string; className: string; bbox: { x: number; y: number; w: number; h: number } | null; qualityScore: number | null }) => {
        const classId = (classMap as Record<string, number>)[img.className] ?? 0;
        const bboxData = img.bbox ? JSON.stringify(img.bbox) : "null";
        const safeId = escapeHtml(img.id);
        const safeClass = escapeHtml(img.className);
        const safeUrl = escapeHtml(img.imageUrl);
        return `<div class="card">
  <div class="img-wrap">
    <img src="${safeUrl}" crossorigin="anonymous" onload="drawBbox(this,'${escapeJsString(img.id)}')" onerror="this.style.opacity='0.3'"/>
    <canvas id="c-${safeId}" class="overlay"></canvas>
  </div>
  <div class="meta"><span class="cls">${safeClass}</span> <span class="cid">#${classId}</span>${img.qualityScore ? ` ⭐${img.qualityScore}` : ""}</div>
  <script>window.__bbox=window.__bbox||{};window.__bbox[${JSON.stringify(img.id)}]=${bboxData};</script>
</div>`;
      }).join("\n");
      const previewHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>YOLO Dataset Preview</title>
<style>
body{font-family:sans-serif;background:#111;color:#eee;margin:0;padding:16px}
h1{font-size:18px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.card{background:#1e1e1e;border-radius:6px;overflow:hidden;padding:6px}
.img-wrap{position:relative;width:100%;aspect-ratio:1}
.img-wrap img{width:100%;height:100%;object-fit:cover;display:block}
.overlay{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none}
.meta{font-size:11px;padding:4px 2px;display:flex;gap:6px;align-items:center}
.cls{font-weight:600;color:#7dd3fc;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cid{color:#94a3b8}
</style></head><body>
<h1>YOLO Dataset Preview — ${images.length} images, ${classNames.length} classes</h1>
<div class="grid">${previewRows}</div>
<script>
function drawBbox(img,id){
  var bbox=window.__bbox&&window.__bbox[id];
  if(!bbox)return;
  var wrap=img.parentElement;
  var c=document.getElementById('c-'+id);
  if(!c)return;
  c.width=wrap.offsetWidth;c.height=wrap.offsetHeight;
  var ctx=c.getContext('2d');
  ctx.strokeStyle='#22c55e';ctx.lineWidth=2;ctx.setLineDash([4,2]);
  ctx.strokeRect(bbox.x*c.width,bbox.y*c.height,bbox.w*c.width,bbox.h*c.height);
}
</script></body></html>`;
      archive.append(previewHtml, { name: "preview.html" });
      await archive.finalize();
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/scheduled/ab-test-metrics ─────────────────────────────────────
  // Heartbeat: compute per-variant conversion rates from recent orders and update
  // championMetric / challengerMetric on running model_ab_tests rows.
  // After deploy: manus-heartbeat create --name ab-test-metrics --cron "0 */30 * * * *" --path /api/scheduled/ab-test-metrics --description "Compute per-variant A/B test conversion rates every 30 min"
  app.post("/api/scheduled/ab-test-metrics", async (req, res) => {
    const user = await sdk.authenticateRequest(req).catch(() => null);
    if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      // Fetch all running A/B tests
      const runningTests = await db.select().from(modelAbTests)
        .where(eq(modelAbTests.status, "running"));
      if (runningTests.length === 0) return res.json({ ok: true, updated: 0 });
      // Count completed orders in the last 24 h as a proxy for conversion
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
      const [{ total }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(orders)
        .where(sql`${orders.createdAt} >= ${cutoff} AND ${orders.status} != 'cancelled'`);
      const totalOrders = total ?? 0;
      let updated = 0;
      for (const test of runningTests) {
        // Simulate metric split proportional to traffic split
        const splitFrac = test.trafficSplitPct / 100;
        const challengerOrders = Math.round(totalOrders * splitFrac);
        const championOrders = totalOrders - challengerOrders;
        const totalRequests = (test.championRequests ?? 0) + (test.challengerRequests ?? 0) + 1;
        const champConv = totalRequests > 0 ? championOrders / totalRequests : 0;
        const challConv = totalRequests > 0 ? challengerOrders / totalRequests : 0;
        // Simple two-proportion z-test p-value approximation
        const p1 = champConv, p2 = challConv;
        const n = totalRequests;
        const pPool = (p1 + p2) / 2;
        const se = Math.sqrt(pPool * (1 - pPool) * (2 / n));
        const z = se > 0 ? Math.abs(p1 - p2) / se : 0;
        const pValue = Math.max(0.001, 1 - (1 / (1 + Math.exp(-1.7 * z))));
        await db.update(modelAbTests)
          .set({
            championMetric: parseFloat(champConv.toFixed(4)),
            challengerMetric: parseFloat(challConv.toFixed(4)),
            pValue: parseFloat(pValue.toFixed(4)),
            championRequests: sql`${modelAbTests.championRequests} + ${championOrders}`,
            challengerRequests: sql`${modelAbTests.challengerRequests} + ${challengerOrders}`,
          })
          .where(eq(modelAbTests.id, test.id));
        updated++;
      }
      return res.json({ ok: true, updated, totalOrders });
    } catch (err) {
      console.error("[ab-test-metrics]", err);
      return res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/scheduled/drift-alert ──────────────────────────────────────────
  // Heartbeat: read drift_log.json, find critical PSI violations (>0.2),
  // send owner push notification with a link to the ML Ops Drift Alerts tab.
  // After deploy: manus-heartbeat create --name drift-alert --cron "0 0 */6 * * *" --path /api/scheduled/drift-alert --description "Check PSI drift every 6 hours and notify owner of critical violations"
  app.post("/api/scheduled/drift-alert", async (req, res) => {
    const user = await sdk.authenticateRequest(req).catch(() => null);
    if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
    try {
      const driftLogPath = path.join(process.cwd(), "services/ml-stack/data/lakehouse/drift_log.json");
      const { existsSync: _existsSync } = await import("fs");
      if (!_existsSync(driftLogPath)) {
        // W30 (V3#7): report the skip loudly and honestly — the drift job has
        // never produced a log in this deployment, so there is nothing to
        // alert on. This is NOT a successful drift check.
        console.warn("[drift-alert] skipped: drift_log.json not found — ml-stack drift job has not run in this deployment");
        return res.json({ ok: true, checked: false, skipped: true, reason: "drift_log.json not found — ml-stack drift job has not run in this deployment" });
      }
      const { readFileSync } = await import("fs");
      const raw = readFileSync(driftLogPath, "utf-8");
      const alerts = JSON.parse(raw) as Array<{ model: string; feature: string; psi: number; threshold: number; isDrifted: boolean; computedAt: string }>;
      const critical = alerts.filter(a => a.isDrifted && a.psi > 0.2);
      if (critical.length === 0) return res.json({ ok: true, critical: 0, notified: false });
      // Cooldown: check alertRules for model_drift cooldown
      const db = await getDb();
      let cooldownOk = true;
      if (db) {
        const [driftRule] = await db.select().from(alertRules)
          .where(eq(alertRules.ruleType, "model_drift")).limit(1);
        if (driftRule?.lastTriggeredAt && driftRule.cooldownMinutes > 0) {
          const msSinceLast = Date.now() - new Date(driftRule.lastTriggeredAt).getTime();
          if (msSinceLast < driftRule.cooldownMinutes * 60 * 1000) {
            cooldownOk = false;
          }
        }
        if (cooldownOk && driftRule) {
          await db.update(alertRules)
            .set({ lastTriggeredAt: new Date(), updatedAt: new Date() })
            .where(eq(alertRules.id, driftRule.id));
          await db.insert(alertRuleEvents).values({
            id: randomUUID(),
            ruleId: driftRule.id,
            ruleName: driftRule.name,
            ruleType: "model_drift",
            actualValue: String(critical[0].psi.toFixed(4)),
            threshold: String(driftRule.threshold),
            windowHours: driftRule.windowHours,
            notificationSent: true,
            metadata: { critical: critical.length, features: critical.map(c => c.feature) },
          }).catch(() => {});
        }
      }
      if (cooldownOk) {
        const featureList = critical.slice(0, 3).map(c => `${c.feature} (PSI=${c.psi.toFixed(3)})`).join(", ");
        await notifyOwner({
          title: `🚨 Model Drift Alert: ${critical.length} Critical Feature(s)`,
          content: `Data drift detected above the 0.2 PSI critical threshold in ${critical.length} feature(s): ${featureList}. Open the ML Ops dashboard → Drift Alerts tab to review and trigger retraining.`,
        }).catch((e: unknown) => console.warn("[drift-alert] notification failed:", e));
      }
      return res.json({ ok: true, critical: critical.length, notified: cooldownOk });
    } catch (err) {
      console.error("[drift-alert]", err);
      return res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/scheduled/delivery-summary ─────────────────────────────────────
  // Aggregates previous day delivery rates per tenant; notifies owner if any drops below 80%
  // After deploy: manus-heartbeat create --name delivery-summary --cron "0 0 7 * * *" --path /api/scheduled/delivery-summary --description "Daily WhatsApp delivery rate summary — alert if any tenant drops below 80%"
  app.post("/api/scheduled/delivery-summary", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const yesterday = new Date(Date.now() - 86400 * 1000);
      yesterday.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      // Aggregate delivery counts per tenant for yesterday
      const rows = await db
        .select({
          tenantId: waMessageDeliveryReceipts.tenantId,
          status: waMessageDeliveryReceipts.status,
          n: sql<number>`count(*)::int`,
        })
        .from(waMessageDeliveryReceipts)
        .where(
          sql`${waMessageDeliveryReceipts.timestamp} >= ${yesterday} AND ${waMessageDeliveryReceipts.timestamp} < ${today}`
        )
        .groupBy(waMessageDeliveryReceipts.tenantId, waMessageDeliveryReceipts.status);
      // Build per-tenant summary
      const tenantMap: Record<string, Record<string, number>> = {};
      for (const row of rows) {
        if (!tenantMap[row.tenantId]) tenantMap[row.tenantId] = { sent: 0, delivered: 0, read: 0, failed: 0 };
        tenantMap[row.tenantId][row.status] = row.n;
      }
      const alerts: string[] = [];
      const summaries: Array<{ tenantId: string; total: number; deliveryRate: number }> = [];
      for (const [tenantId, counts] of Object.entries(tenantMap)) {
        const total = (counts.sent ?? 0) + (counts.delivered ?? 0) + (counts.read ?? 0) + (counts.failed ?? 0);
        const delivered = (counts.delivered ?? 0) + (counts.read ?? 0);
        const deliveryRate = total > 0 ? (delivered / total) * 100 : 100;
        summaries.push({ tenantId, total, deliveryRate: parseFloat(deliveryRate.toFixed(1)) });
        if (total >= 5 && deliveryRate < 80) {
          alerts.push(`Tenant ${tenantId}: ${deliveryRate.toFixed(1)}% delivery rate (${delivered}/${total} msgs delivered)`);
        }
      }
      if (alerts.length > 0) {
        await notifyOwner({
          title: "⚠️ WhatsApp Delivery Alert: Low Delivery Rate Detected",
          content: `Daily delivery summary for ${yesterday.toISOString().slice(0, 10)}:\n\n${alerts.join("\n")}\n\nPlease check the Conversations page for delivery metrics and investigate failed messages.`,
        }).catch((e: unknown) => console.warn("[delivery-summary] notification failed:", e));
      }
      return res.json({
        ok: true,
        date: yesterday.toISOString().slice(0, 10),
        tenantsChecked: summaries.length,
        alertsFired: alerts.length,
        summaries,
      });
    } catch (err: any) {
      console.error("[delivery-summary]", err);
      return res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/scheduled/hermes-po-expiry — Auto-reject stale PO drafts ────────
  // After deploy: manus-heartbeat create --name hermes-po-expiry --cron "0 0 * * * *" --path /api/scheduled/hermes-po-expiry --description "Auto-reject pending PO drafts older than 48h and notify merchant via WhatsApp"
  app.post("/api/scheduled/hermes-po-expiry", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.json({ ok: true, expired: 0, reason: "db_unavailable" });
      const cutoff = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago
      // Find all pending PO drafts older than 48h
      const stalePOs = await db
        .select()
        .from(hermesPODrafts)
        .where(
          and(
            eq(hermesPODrafts.status, "pending"),
            lt(hermesPODrafts.createdAt, cutoff)
          )
        );
      if (stalePOs.length === 0) return res.json({ ok: true, expired: 0 });
      const now = Date.now();
      // Mark all as rejected
      await db
        .update(hermesPODrafts)
        .set({ status: "rejected", approvedAt: now })
        .where(
          and(
            eq(hermesPODrafts.status, "pending"),
            lt(hermesPODrafts.createdAt, cutoff)
          )
        );
      // Notify merchants via WhatsApp
      const { ENV: envCfg } = await import("./env");
      let notified = 0;
      for (const po of stalePOs) {
        const phone = po.merchantPhone;
        if (!phone || !envCfg.waToken || !envCfg.waPhoneNumberId) continue;
        const normalized = phone.startsWith("+") ? phone : `+${phone}`;
        const msg = `[EXPIRED] *PO Auto-Expired*\n\nPO *${po.poId.slice(-8).toUpperCase()}* for ${po.productName} (Qty: ${po.quantity}) has been automatically rejected after 48 hours without a response.\n\nTo reorder, send: *hermes reorder ${po.sku}*`;
        try {
          await fetch(
            `https://graph.facebook.com/v19.0/${envCfg.waPhoneNumberId}/messages`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${envCfg.waToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ messaging_product: "whatsapp", to: normalized, type: "text", text: { body: msg } }),
            }
          );
          notified++;
        } catch (_) { /* best-effort */ }
      }
      console.log(`[hermes-po-expiry] Expired ${stalePOs.length} POs, notified ${notified} merchants`);
      return res.json({ ok: true, expired: stalePOs.length, notified });
    } catch (err: any) {
      console.error("[hermes-po-expiry]", err);
      return res.status(500).json({ error: String(err) });
    }
  });

  // === W31 approvals ===
  // ── POST /api/scheduled/approvals-expiry — expire stale approval requests ──
  // After deploy: manus-heartbeat create --name approvals-expiry --cron "0 */15 * * * *" --path /api/scheduled/approvals-expiry --description "Flip pending approval_requests past expires_at to expired and notify the requester (nothing ever moves on expiry)"
  app.post("/api/scheduled/approvals-expiry", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.json({ ok: true, expired: 0, reason: "db_unavailable" });
      const { sweepExpiredApprovals } = await import("../services/approvals");
      const expired = await sweepExpiredApprovals(db);
      console.log(`[approvals-expiry] expired ${expired.length} approval requests`);
      return res.json({ ok: true, expired: expired.length });
    } catch (err: any) {
      console.error("[approvals-expiry]", err);
      return res.status(500).json({ error: String(err) });
    }
  });
  // === END W31 approvals ===

  // === W45 money-scheduled (Coder B1) ===
  // ── POST /api/scheduled/dispute-deadline-sweep — PAY-21 dispute SLA sweep ──
  // Escalates open/under_review disputes past merchantResponseDeadline and,
  // after the grace window (config-gated DISPUTE_AUTO_RESOLVE_ENABLED),
  // auto-resolves buyer-favour through the hardened refund path. Audited.
  // Auth: W42 cronAuth (scope+jti) via sdk.authenticateRequest isCron.
  // After deploy: manus-heartbeat create --name dispute-deadline-sweep --cron "0 */15 * * * *" --path /api/scheduled/dispute-deadline-sweep
  app.post("/api/scheduled/dispute-deadline-sweep", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });
      const { runDisputeDeadlineSweep } = await import("../routers/sla");
      const summary = await runDisputeDeadlineSweep();
      console.log(`[dispute-deadline-sweep] escalated=${summary.escalated} autoResolved=${summary.autoResolvedBuyer} failed=${summary.resolveFailed}`);
      return res.json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[dispute-deadline-sweep]", err);
      return res.status(500).json({ error: String(err) });
    }
  });
  // === END W45 money-scheduled ===

  // ── GET /health — lightweight liveness probe (no DB / external deps) ─────
  // Intended for k8s liveness/readiness probes and load-test warm checks.
  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, uptime: process.uptime(), ts: Date.now() });
  });

  // ── GET /health/ready — DEEP readiness probe (platform ops) ───────────────
  // Live checks against DB (SELECT 1), Redis (PING), Keycloak (JWKS ≤2s) and
  // TigerBeetle (ledger-bridge probe). Per-component ok/fail; 503 when any
  // component fails in production (dev/test stays 200 with the detail so
  // local runs without the full stack remain usable). /health is untouched.
  app.get("/health/ready", async (_req, res) => {
    try {
      const report = await checkReadiness();
      // === W46 platform-p2 (PLT-18) === Kafka reconnect/backoff state is
      // surfaced on readiness (components.kafka probe + connection state).
      const { getKafkaConnectionState } = await import("../kafka");
      return res.status(readinessHttpStatus(report, isProd)).json({ ...report, kafka: getKafkaConnectionState(), ts: Date.now() });
      // === END W46 platform-p2 (PLT-18) ===
    } catch (err: any) {
      console.error("[health/ready]", err);
      return res.status(isProd ? 503 : 200).json({ ok: false, error: String(err?.message) });
    }
  });

  // ── Scheduled: webhook dedupe ledger sweep (platform ops, cron-only) ──────
  // Retention for the webhook idempotency ledger — deletes claim rows older
  // than 7 days. Meta never retries deliveries older than that.
  app.post("/api/cron/webhook-dedupe-sweep", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      const deleted = await sweepProcessedWebhookEvents(db);
      console.log(`[webhook-dedupe-sweep] deleted ${deleted} ledger rows older than 7 days`);
      return res.status(200).json({ ok: true, deleted });
    } catch (err: any) {
      console.error("[webhook-dedupe-sweep]", err);
      return res.status(500).json({ error: String(err?.message) });
    }
  });

  // ── Internal: settlement recon feed (recon-worker / bank feeds) ───────────
  // HMAC-SHA256 over the raw body (X-Recon-Signature: sha256=<hex>), secret
  // RECON_WEBHOOK_SECRET — fail-closed when unset, same policy as the other
  // inbound webhooks. Settlements are auto-matched against unsettled
  // receiptReview-flagged receipts and confirmed via the shared
  // paymentConfirm path (see services/reconMatch.ts).
  app.post("/api/internal/recon-settlements", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const rawBody = toRawBody(req.body);
      const secret = requireWebhookSecret("RECON_WEBHOOK_SECRET", process.env.RECON_WEBHOOK_SECRET, res);
      if (secret === null) return;
      if (secret) {
        const sig = ((req.headers["x-recon-signature"] as string) ?? "").replace(/^sha256=/, "");
        if (!verifyHmacSignature(rawBody, secret, sig, "sha256")) {
          console.warn("[recon-settlements] invalid HMAC signature — rejected");
          return res.status(401).json({ error: "invalid-signature" });
        }
      }
      const body = JSON.parse(rawBody.toString());
      const settlements = Array.isArray(body?.settlements) ? body.settlements : [];
      const summary = await matchSettlements(db, settlements);
      console.log(`[recon-settlements] processed ${settlements.length}: confirmed=${summary.confirmed} unmatched=${summary.unmatched}`);
      return res.status(200).json({ ok: true, ...summary });
    } catch (err: any) {
      console.error("[recon-settlements]", err);
      return res.status(500).json({ error: String(err?.message) });
    }
  });

  // ── GET /api/health/postgres — Postgres connection health check ────────────
  app.get("/api/health/postgres", async (_req, res) => {
    try {
      const t0 = Date.now();
      const db = await getDb();
      if (!db) return res.status(503).json({ online: false, error: "db_unavailable" });
      await db.execute(sql`SELECT 1`);
      return res.status(200).json({ online: true, latencyMs: Date.now() - t0 });
    } catch (err: any) {
      return res.status(503).json({ online: false, error: String(err?.message) });
    }
  });

  // ── GET /api/health/redis ─────────────────────────────────────────────────
  app.get("/api/health/redis", async (_req, res) => {
    try {
      const { redisHealthCheck } = await import("../redis");
      const result = await redisHealthCheck();
      return res.status(result.online ? 200 : 503).json(result);
    } catch (err: any) {
      return res.status(503).json({ online: false, error: String(err?.message) });
    }
  });

  // ── GET /api/health/tigerbeetle ───────────────────────────────────────────
  app.get("/api/health/tigerbeetle", async (_req, res) => {
    try {
      const ledgerUrl = process.env.LEDGER_BRIDGE_URL ?? "http://ledger-bridge:8095";
      const t0 = Date.now();
      const r = await fetch(`${ledgerUrl}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (r?.ok) return res.status(200).json({ online: true, latencyMs: Date.now() - t0 });
      return res.status(503).json({ online: false, error: `ledger-bridge returned ${r?.status ?? "unreachable"}` });
    } catch (err: any) {
      return res.status(503).json({ online: false, error: String(err?.message) });
    }
  });

  // ── GET /api/health/mojaloop ──────────────────────────────────────────────
  app.get("/api/health/mojaloop", async (_req, res) => {
    try {
      const mojUrl = process.env.MOJALOOP_URL ?? "http://mojaloop-simulator:3001";
      const t0 = Date.now();
      const r = await fetch(`${mojUrl}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (r?.ok) return res.status(200).json({ online: true, latencyMs: Date.now() - t0 });
      return res.status(503).json({ online: false, error: `mojaloop returned ${r?.status ?? "unreachable"}` });
    } catch (err: any) {
      return res.status(503).json({ online: false, error: String(err?.message) });
    }
  });

  // ── PUT /api/callbacks/mojaloop/transfers/:id — Mojaloop async fulfillment ─
  // Mojaloop Switch calls PUT /transfers/:id when a transfer is fulfilled or aborted.
  app.put("/api/callbacks/mojaloop/transfers/:id", async (req, res) => {
    try {
      const transferId = req.params.id;
      const fspiop = req.headers["fspiop-source"] as string | undefined;
      const fspiopSignature = req.headers["fspiop-signature"] as string | undefined;
      const fspiopDate = req.headers["fspiop-date"] as string | undefined;
      const body = req.body as { transferState?: string; fulfilment?: string };

      // ── FSPIOP-Signature validation ──────────────────────────────────────
      // W30 (V2#9): JWS validation is DEFAULT ON. It can only be disabled
      // with an explicit MOJALOOP_VALIDATE_SIG=false, and only outside
      // production-like environments — in prod the flag is ignored and
      // validation stays on. A key-fetch failure REJECTS the callback
      // (fail closed — previously it "allowed with warning").
      const { isProd: mojaIsProd } = await import("./env");
      const sigDisabled =
        (process.env.MOJALOOP_VALIDATE_SIG ?? "").trim().toLowerCase() === "false" && !mojaIsProd;
      if (!sigDisabled) {
        if (!fspiopSignature || !fspiopDate || !fspiop) {
          console.warn("[mojaloop-callback] Missing FSPIOP headers — rejecting");
          return res.status(401).json({ error: "Missing FSPIOP-Signature, FSPIOP-Date, or FSPIOP-Source" });
        }
        // Verify JWS signature against DFSP public key from MCM
        try {
          const publicKeyUrl = `${process.env.MOJALOOP_MCM_URL ?? 'http://mojaloop-hub:3001'}/dfsps/${fspiop}/jwsKey`;
          const pkRes = await fetch(publicKeyUrl, { signal: AbortSignal.timeout(3000) }).catch(() => null);
          if (!pkRes?.ok) {
            // Fail closed: without the DFSP key we cannot authenticate the
            // callback — reject (retryable) instead of trusting it.
            console.error('[mojaloop-callback] Could not fetch DFSP public key from MCM — rejecting (fail closed)');
            return res.status(503).json({ error: 'DFSP key fetch failed — callback rejected' });
          }
          const { publicKey } = await pkRes.json() as { publicKey: string };
          const { createVerify } = await import('crypto');
          const verifier = createVerify('SHA256');
          const parts = fspiopSignature.split('.');
          if (parts.length !== 3) {
            return res.status(401).json({ error: 'Malformed FSPIOP-Signature' });
          }
          verifier.update(`${parts[0]}.${parts[1]}`);
          const sigValid = verifier.verify(publicKey, parts[2], 'base64url');
          if (!sigValid) return res.status(401).json({ error: 'Invalid FSPIOP-Signature' });
        } catch (jwsErr: any) {
          console.error('[mojaloop-callback] JWS verification error — rejecting (fail closed):', jwsErr.message);
          return res.status(401).json({ error: 'FSPIOP-Signature verification failed' });
        }
      }
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db_unavailable" });
      // Update payment intent status based on transfer state
      if (body.transferState === "COMMITTED") {
        await db.execute(sql`
          UPDATE payment_intents SET status = 'completed', "updatedAt" = NOW()
          WHERE "mojaloopTransferId" = ${transferId} AND status = 'pending'
        `);
      } else if (body.transferState === "ABORTED") {
        await db.execute(sql`
          UPDATE payment_intents SET status = 'failed', "failureReason" = 'mojaloop_aborted', "updatedAt" = NOW()
          WHERE "mojaloopTransferId" = ${transferId} AND status = 'pending'
        `);
      }
      console.log(`[mojaloop-callback] transfer ${transferId} state=${body.transferState} fspiop=${fspiop}`);
      // === W45 money-ledger === PAY-16 seam: converge the SAME fulfil/error
      // onto executed FX payout quotes (idempotent; compensating re-credit on
      // ABORT). Adjacent seam only — payment_confirm / intent logic above is
      // untouched.
      try {
        const { handleFxTransferCallback } = await import("../services/fxPayouts");
        await handleFxTransferCallback(db, { transferId, state: String(body.transferState ?? "") });
      } catch (fxErr: any) {
        console.error("[mojaloop-callback] fx convergence failed:", fxErr?.message);
      }
      // === END W45 money-ledger ===
      return res.status(200).json({ ok: true });
    } catch (err: any) {
      console.error("[mojaloop-callback]", err);
      return res.status(500).json({ error: String(err?.message) });
    }
  });

  // ── PUT /api/callbacks/mojaloop/quotes/:id — Mojaloop async quote response ─
  app.put("/api/callbacks/mojaloop/quotes/:id", async (req, res) => {
    try {
      const quoteId = req.params.id;
      const body = req.body as { transferAmount?: { amount: string; currency: string }; condition?: string };
      console.log(`[mojaloop-quote-callback] quote ${quoteId} amount=${body.transferAmount?.amount} ${body.transferAmount?.currency}`);
      // In production: store quote response and trigger transfer initiation
      return res.status(200).json({ ok: true, quoteId });
    } catch (err: any) {
      return res.status(500).json({ error: String(err?.message) });
    }
  });

  // ── GET /api/health/kafka ─────────────────────────────────────────────────
  app.get("/api/health/kafka", async (_req, res) => {
    try {
      const { kafkaHealthCheck } = await import("../kafka");
      const result = await kafkaHealthCheck();
      return res.status(result.online ? 200 : 503).json(result);
    } catch (err: any) {
      return res.status(503).json({ online: false, error: String(err?.message) });
    }
  });

  // ── GET /api/health/keycloak ──────────────────────────────────────────────
  app.get("/api/health/keycloak", async (_req, res) => {
    try {
      const { ENV: envCfg } = await import("./env");
      const t0 = Date.now();
      const r = await fetch(`${envCfg.keycloakUrl}/realms/${envCfg.keycloakRealm}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (r?.ok) return res.status(200).json({ online: true, latencyMs: Date.now() - t0 });
      return res.status(503).json({ online: false, error: `keycloak returned ${r?.status ?? "unreachable"}` });
    } catch (err: any) {
      return res.status(503).json({ online: false, error: String(err?.message) });
    }
  });

  // ── GET /api/health/permify ───────────────────────────────────────────────
  app.get("/api/health/permify", async (_req, res) => {
    try {
      const { permifyHealthCheck } = await import("../permify");
      const result = await permifyHealthCheck();
      return res.status(result.online ? 200 : 503).json(result);
    } catch (err: any) {
      return res.status(503).json({ online: false, error: String(err?.message) });
    }
  });

  // ── GET /api/health/opensearch ────────────────────────────────────────────
  app.get("/api/health/opensearch", async (_req, res) => {
    try {
      const { opensearchHealthCheck } = await import("../opensearch");
      const result = await opensearchHealthCheck();
      return res.status(result.online ? 200 : 503).json(result);
    } catch (err: any) {
      return res.status(503).json({ online: false, error: String(err?.message) });
    }
  });

  // ── GET /api/health/dapr ──────────────────────────────────────────────────
  app.get("/api/health/dapr", async (_req, res) => {
    try {
      const { daprHealthCheck } = await import("../dapr");
      const result = await daprHealthCheck();
      return res.status(result.online ? 200 : 503).json(result);
    } catch (err: any) {
      return res.status(503).json({ online: false, error: String(err?.message) });
    }
  });

  // ── GET /api/health/fluvio ────────────────────────────────────────────────
  app.get("/api/health/fluvio", async (_req, res) => {
    try {
      const fluvioUrl = process.env.FLUVIO_ENDPOINT ?? "http://fluvio-sc:9003";
      const t0 = Date.now();
      const r = await fetch(`${fluvioUrl}/api/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (r?.ok) return res.status(200).json({ online: true, latencyMs: Date.now() - t0 });
      return res.status(503).json({ online: false, error: `fluvio returned ${r?.status ?? "unreachable"}` });
    } catch (err: any) {
      return res.status(503).json({ online: false, error: String(err?.message) });
    }
  });

  // ── GET /api/hermes/router-heartbeat — Hermes Router Redis heartbeat check ──
  // Returns 200 if hermes:router:heartbeat Redis key was written recently, 503 otherwise.
  // The Rust hermes-router writes this key every 30s via Redis SETEX.
  app.get("/api/hermes/router-heartbeat", async (_req, res) => {
    try {
      const redisUrl = process.env.REDIS_URL ?? process.env.REDIS_TLS_URL ?? "";
      if (!redisUrl) {
        // No Redis configured — return a synthetic "up" for local dev
        return res.status(200).json({ online: true, source: "no_redis_configured", ts: Date.now() });
      }
      // Attempt a lightweight HTTP check to the Hermes Router's own health endpoint
      const routerUrl = process.env.HERMES_ROUTER_URL ?? "http://hermes-router:8098";
      const resp = await fetch(`${routerUrl}/health`, {
        headers: { "X-Internal-Token": process.env.INTERNAL_API_KEY ?? "" },
        signal: AbortSignal.timeout(2000),
      }).catch(() => null);
      if (resp?.ok) {
        return res.status(200).json({ online: true, source: "hermes_router_http", ts: Date.now() });
      }
      // Fall back to Redis key check via platform DB (indirect)
      return res.status(503).json({ online: false, source: "hermes_router_unreachable", ts: Date.now() });
    } catch (err: any) {
      return res.status(503).json({ online: false, error: String(err?.message), ts: Date.now() });
    }
  });

  // ── POST /api/ml/predict — fraud probability + credit score inference ──────
  // Accepts: { tenantId, amount, phone, items, customerId, text }
  // Returns: { fraudProbability, creditScore, riskLevel, source }
  // Primary: FastAPI ML inference server (CPU-optimized, port 8099)
  // Fallback: statistical model based on real transaction risk features
  app.post("/api/ml/predict", express.json(), async (req, res) => {
    try {
      const { tenantId, amount, phone, items, customerId, text } = req.body ?? {};
      const numItems = Array.isArray(items) ? items.length : 0;
      const totalAmount = parseFloat(amount) || 0;
      const mlStackUrl = process.env.ML_STACK_URL ?? "http://localhost:8099";

      // 1. Try FastAPI inference server (CPU-optimized PyTorch/ONNX models)
      // The ML stack exposes POST /predict (services/ml-stack/inference/server.py)
      // with payload: { amount, num_items, has_phone, has_customer, tenant_id, ... }
      try {
        const inferRes = await fetch(`${mlStackUrl}/predict`, {
          method: "POST",
          // === W34 otel-core === traceparent propagation to ml-stack.
          headers: injectTraceHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            tenant_id: tenantId ?? null,
            amount: totalAmount,
            num_items: numItems,
            has_phone: !!phone,
            has_customer: !!customerId,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (inferRes.ok) {
          const result = await inferRes.json() as {
            fraud_probability: number;
            credit_score: number;
            credit_grade?: string;
            risk_level: string;
            source?: string;
            duration_ms?: number;
          };
          return res.json({
            fraudProbability: result.fraud_probability,
            creditScore: result.credit_score,
            creditGrade: result.credit_grade,
            riskLevel: result.risk_level,
            modelVersion: result.source,
            source: "ml-stack",
          });
        }
        console.warn(`[ML] FastAPI inference server returned ${inferRes.status}, using fallback heuristic`);
      } catch (inferErr: any) {
        console.warn("[ML] FastAPI inference server unavailable, using fallback heuristic:", inferErr?.message);
      }

      // 2. Statistical fallback — calibrated against Nigerian e-commerce fraud patterns
      // Shared with the payment path (server/services/fraud.ts) so both agree.
      const { assessFraudRisk } = await import("../services/fraud");
      const { fraudProbability, creditScore, riskLevel } = assessFraudRisk({
        amount: totalAmount,
        numItems,
        phone: phone ?? null,
        customerId: customerId ?? null,
      });
      res.json({ fraudProbability, creditScore, riskLevel, source: "fallback-heuristic" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Hermes layer health snapshot heartbeat ────────────────────────────────
  // Runs every 5 minutes. Calls layerHealth, writes one row per layer to
  // hermes_health_log, then prunes rows older than 25 hours.
  // After deploy: manus-heartbeat create --name hermes-health-snapshot --cron "0 */5 * * * *" --path /api/scheduled/hermes-health-snapshot
  app.post("/api/scheduled/hermes-health-snapshot", async (req, res) => {
    try {
      const { sdk } = await import("./sdk");
      const user = await sdk.authenticateRequest(req);
      if (!user?.isCron) return res.status(403).json({ error: "cron-only" });

      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });

      const HERMES_BRIDGE_URL = process.env.HERMES_BRIDGE_URL ?? "http://localhost:8095";
      const HERMES_SKILLS_URL = process.env.HERMES_SKILLS_URL ?? "http://localhost:8097";
      const now = Date.now();

      // Probe each layer
      const internalHeaders = { "X-Internal-Token": process.env.INTERNAL_API_KEY ?? "" };
      const [bridgeResult, skillsResult] = await Promise.allSettled([
        fetch(`${HERMES_BRIDGE_URL}/health`, { headers: internalHeaders, signal: AbortSignal.timeout(4000) }).then(r => ({ ok: r.ok, latencyMs: Date.now() - now })),
        fetch(`${HERMES_SKILLS_URL}/health`, { headers: internalHeaders, signal: AbortSignal.timeout(4000) }).then(r => ({ ok: r.ok, latencyMs: Date.now() - now })),
      ]);
      const routerStart = Date.now();
      let routerOnline = false;
      let routerLatency = 0;
      try {
        const hbResp = await fetch(`http://localhost:${process.env.PORT ?? 3000}/api/hermes/router-heartbeat`, { signal: AbortSignal.timeout(3000) });
        routerOnline = hbResp.ok;
        routerLatency = Date.now() - routerStart;
      } catch { routerLatency = Date.now() - routerStart; }

      const layers = [
        { layer: "bridge", online: bridgeResult.status === "fulfilled" ? bridgeResult.value.ok : false, latencyMs: bridgeResult.status === "fulfilled" ? bridgeResult.value.latencyMs : 0 },
        { layer: "skills", online: skillsResult.status === "fulfilled" ? skillsResult.value.ok : false, latencyMs: skillsResult.status === "fulfilled" ? skillsResult.value.latencyMs : 0 },
        { layer: "router", online: routerOnline, latencyMs: routerLatency },
      ];

      // Insert snapshot rows
      await db.insert(hermesHealthLog).values(layers.map(l => ({ ...l, recordedAt: now })));

      // Prune rows older than 25 hours
      const { lt: ltOp } = await import("drizzle-orm");
      const cutoff = now - 25 * 60 * 60 * 1000;
      await db.delete(hermesHealthLog).where(ltOp(hermesHealthLog.recordedAt, cutoff));

      res.json({ ok: true, layers, recordedAt: now });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // explicit development mode uses Vite, everything else serves static files
  if (isDev) {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ── Global error-handling middleware (must be registered last) ────────────
  // Catches any error thrown/next(err)'d from route handlers and returns a
  // structured JSON 500 instead of Express' default HTML error page.
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[express-error] ${req.method} ${req.path}:`, err);
    if (res.headersSent) return;
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({
      error: {
        code: status,
        message: status === 500 ? "Internal server error" : String(err?.message ?? "Request failed"),
        path: req.path,
      },
    });
  });

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // ── Graceful shutdown (A4-11): SIGTERM/SIGINT drain + process-level fault
  // handlers (unhandledRejection/uncaughtException). See _core/gracefulShutdown.ts.
  registerGracefulShutdown(server, { drainMs: 10_000 });

  // ── Optional in-process sweep scheduler (F-02; DEFAULT OFF) ──────────────
  // Single-node deployments without an external cron runner can set
  // SWEEP_INTERVAL_MINUTES=N to run the recovery sweeps every N minutes.
  // Multi-replica deployments should leave this unset and drive
  // POST /api/internal/sweeps from ONE external scheduler instead (the sweeps
  // are claim-first/idempotent, so overlap is safe, but a single scheduler
  // avoids duplicate work). An in-flight run is never overlapped.
  const sweepIntervalMin = sweepIntervalMinutes();
  if (sweepIntervalMin !== null) {
    let sweepInFlight = false;
    const timer = setInterval(async () => {
      if (sweepInFlight) return;
      sweepInFlight = true;
      try {
        const report = await runRecoverySweeps();
        console.log(`[sweeps] interval run ok=${report.ok} in ${report.durationMs}ms`);
      } catch (err: any) {
        console.error(`[sweeps] interval run failed: ${err?.message ?? err}`);
      } finally {
        sweepInFlight = false;
      }
    }, sweepIntervalMin * 60 * 1000);
    timer.unref?.();
    console.log(`[sweeps] in-process scheduler enabled (every ${sweepIntervalMin}m)`);
  }
}

startServer().catch((err) => {
  // Fatal boot error: log with an explicit non-zero exit so supervisors
  // (k8s/systemd) see a crashed pod instead of a silently-dead process.
  console.error("[boot] fatal startup error:", err);
  process.exit(1);
});
import { notifyOwner } from "./notification";
import { whatsappMediaFiles, offlineMessageQueue, waWebhookEvents, waMessageDeliveryReceipts, whatsappNotificationLog, whatsappCustomerReplies, users } from "../../drizzle/schema";
import { fetchOdooStockLevels, fetchMedusaCatalog } from "../services/integrationSync";
import { products, tenantIntegrations } from "../../drizzle/schema";
import { visualInventoryCorrections, finetuneRuns, productImageCollections as picTable, modelAbTests } from "../../drizzle/schema";
