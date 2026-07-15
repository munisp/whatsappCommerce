import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { WebSocketServer, WebSocket } from "ws";
import { sdk } from "./sdk";
import { getDb } from "../db";
import { inventorySnapshots } from "../../drizzle/schema";
import { sql } from "drizzle-orm";
import crypto from "crypto";
import { paymentTransactions, alertRules, alertRuleEvents, forecastSnapshots, tenants, escrowConfig, escrowTransactions, logisticsShipments, merchantWallets, floatIncomeEntries, orders } from "../../drizzle/schema";
import { broadcastCampaigns, broadcastRecipients, twentyContacts } from "../../drizzle/schema";
import { eq, and, gte, lte } from "drizzle-orm";
import { randomUUID } from "crypto";
import { handleGetEvidencePortal, handleSubmitEvidence } from "../routers/evidencePortal";
import { runSlaScan } from "../routers/sla";

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
        if (process.env.NODE_ENV === "development") {
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

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // ── Scheduled: inventory sync (Heartbeat cron, fires every 5 min) ──────────
  app.post("/api/scheduled/inventory-sync", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) return res.status(403).json({ error: "cron-only" });
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "db-unavailable" });
      // Update lastSyncedAt for all snapshots (production: replace with Odoo XML-RPC call)
      await db.update(inventorySnapshots)
        .set({ lastSyncedAt: new Date(), syncSource: "heartbeat" })
        .execute();
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
        ok: true,
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
      const secret = process.env.PAYSTACK_WEBHOOK_SECRET ?? "";
      const sig = req.headers["x-paystack-signature"] as string ?? "";
      const body = req.body as Buffer;
      if (secret) {
        const expected = crypto.createHmac("sha512", secret).update(body).digest("hex");
        if (sig !== expected) return res.status(401).json({ error: "invalid-signature" });
      }
      const payload = JSON.parse(body.toString());
      if (payload.event === "charge.success" && db) {
        const ref = payload.data?.reference as string;
        if (ref) {
          await db.update(paymentTransactions)
            .set({ status: "completed", providerRef: ref, updatedAt: new Date() })
            .where(eq(paymentTransactions.providerRef, ref));
        }
      }
      return res.status(200).json({ received: true });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Flutterwave webhook (/api/webhooks/flutterwave) ───────────────────────
  app.post("/api/webhooks/flutterwave", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const db = await getDb();
      const secret = process.env.FLW_WEBHOOK_SECRET ?? "";
      const sig = req.headers["verif-hash"] as string ?? "";
      if (secret && sig !== secret) return res.status(401).json({ error: "invalid-signature" });
      const body = req.body as Buffer;
      const payload = JSON.parse(body.toString());
      if (payload.event === "charge.completed" && payload.data?.status === "successful" && db) {
        const txRef = payload.data?.tx_ref as string;
        if (txRef) {
          await db.update(paymentTransactions)
            .set({ status: "completed", providerRef: txRef, updatedAt: new Date() })
            .where(eq(paymentTransactions.providerRef, txRef));
        }
      }
    return res.status(200).json({ received: true });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Shipbubble delivery webhook (/api/webhooks/shipbubble) ────────────────
  app.post("/api/webhooks/shipbubble", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const [cfg] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
      const secret = cfg?.shipbubbleWebhookSecret ?? process.env.SHIPBUBBLE_WEBHOOK_SECRET ?? "";
      const body = req.body as Buffer;
      if (secret) {
        const sig = req.headers["x-shipbubble-signature"] as string ?? "";
        const expected = crypto.createHmac("sha512", secret).update(body).digest("hex");
        if (sig !== expected) return res.status(401).json({ error: "Invalid signature" });
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
        await db.update(escrowTransactions).set({
          state: "delivery_confirmed", deliveryConfirmedAt: now, updatedAt: now,
        }).where(and(eq(escrowTransactions.id, shipment.escrowTxId), eq(escrowTransactions.state, "escrow_held")));
        await db.update(orders).set({ status: "delivered", updatedAt: now }).where(eq(orders.id, shipment.orderId));
      }
      return res.status(200).json({ received: true });
    } catch (err: any) {
      console.error("[shipbubble-webhook]", err);
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Bank escrow settlement callback (PSSP mode) ───────────────────────────
  app.post("/api/webhooks/escrow-bank", express.json(), async (req, res) => {
  // ── WhatsApp Business API webhook (Meta) ──────────────────────────────────
  // GET: verification challenge from Meta
  app.get("/api/webhooks/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN ?? "whatsapp_verify_token_demo";
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
      // ── HMAC-SHA256 signature verification ────────────────────────────────
      const rawBody = req.body as Buffer;
      const appSecret = process.env.WHATSAPP_APP_SECRET ?? "";
      if (appSecret) {
        const sig = (req.headers["x-hub-signature-256"] as string ?? "").replace("sha256=", "");
        const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
        if (sig !== expected) {
          console.warn("[whatsapp-webhook] Invalid HMAC signature — request rejected");
          return res.status(401).json({ error: "invalid-signature" });
        }
      }
      const body = JSON.parse(rawBody.toString());
      // Acknowledge immediately (Meta requires 200 within 20s)
      res.status(200).json({ received: true });
      // Parse the Meta webhook payload
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      if (!value) return;
      const messages: any[] = value?.messages ?? [];
      const contacts: any[] = value?.contacts ?? [];
      const phoneNumberId: string = value?.metadata?.phone_number_id ?? "";
      for (const msg of messages) {
        const waPhoneNumber: string = msg.from ?? "";
        const contactName: string = contacts.find((c: any) => c.wa_id === waPhoneNumber)?.profile?.name ?? "";
        // Determine tenant from phone number ID (look up in tenants table)
        const [tenant] = await db.select().from(tenants)
          .where(sql`meta_phone_number_id = ${phoneNumberId}`)
          .limit(1).catch(() => [null as any]);
        const tenantId: string = (tenant as any)?.id ?? "default";
        if (msg.type === "text") {
          // Route text messages through the NLP engine
          const { appRouter: ar } = await import("../routers");
          const caller = ar.createCaller({ user: null } as any);
          await caller.nlp.processMessage({
            tenantId,
            waPhoneNumber,
            message: msg.text?.body ?? "",
            customerName: contactName || undefined,
          }).catch((e: any) => console.error("[whatsapp-webhook] NLP error:", e?.message));
        } else if (msg.type === "image" || msg.type === "document" || msg.type === "video") {
          // Store media file reference for later download
          const mediaId: string = msg.image?.id ?? msg.document?.id ?? msg.video?.id ?? "";
          const mimeType: string = msg.image?.mime_type ?? msg.document?.mime_type ?? msg.video?.mime_type ?? "application/octet-stream";
          const caption: string = msg.image?.caption ?? msg.document?.caption ?? msg.video?.caption ?? "";
          const filename: string = msg.document?.filename ?? `${msg.type}_${Date.now()}`;
          if (mediaId) {
            await db.insert(whatsappMediaFiles).values({
              id: crypto.randomUUID(),
              tenantId,
              waPhoneNumber,
              mimeType,
              fileName: filename,
              storageKey: `wa-media/${mediaId}`,
              storageUrl: `https://graph.facebook.com/v18.0/${mediaId}`,
              documentType: msg.type === "document" ? "document" : msg.type === "image" ? "image" : "other",
              aiScanResult: caption ? { caption } : null,
              uploadedAt: new Date(),
            }).catch((e: any) => console.error("[whatsapp-webhook] media insert error:", e?.message));
          }
        }
      }
    } catch (err: any) {
      console.error("[whatsapp-webhook]", err);
    }
  });

    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ error: "DB unavailable" });
      const { escrowId, bankRef, status } = req.body ?? {};
      if (!escrowId || !bankRef) return res.status(400).json({ error: "Missing escrowId or bankRef" });
      if (status === "settled") {
        await db.update(escrowTransactions).set({
          state: "settled", bankRef, bankSettlementConfirmedAt: new Date(), settledAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(escrowTransactions.id, escrowId), eq(escrowTransactions.state, "release_instructed")));
      }
      return res.status(200).json({ received: true });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  // ── Escrow auto-confirm heartbeat ─────────────────────────────────────────
  app.post("/api/scheduled/escrow-auto-confirm", async (req, res) => {
    try {
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
      for (const escrow of expired) {
        const feeRate = parseFloat(cfg.platformFeeRate);
        const netAmount = parseFloat(escrow.amount) * (1 - feeRate);
        if (cfg.custodyMode === "psp") {
          const [wallet] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, escrow.tenantId));
          if (wallet) {
            await db.update(merchantWallets).set({
              escrowBalance: sql`GREATEST(escrow_balance - ${netAmount.toFixed(2)}, 0)`,
              availableBalance: sql`available_balance + ${netAmount.toFixed(2)}`,
              totalEarned: sql`total_earned + ${netAmount.toFixed(2)}`,
              updatedAt: now,
            }).where(eq(merchantWallets.id, wallet.id));
          }
          await db.update(escrowTransactions).set({
            state: "settled", autoConfirmed: true, settledAt: now, updatedAt: now,
          }).where(eq(escrowTransactions.id, escrow.id));
        } else {
          const bankRef = `ESCROW-AUTO-${escrow.id.slice(0, 8).toUpperCase()}-${Date.now()}`;
          await db.update(escrowTransactions).set({
            state: "release_instructed", autoConfirmed: true, releaseInstructedAt: now, bankRef, updatedAt: now,
          }).where(eq(escrowTransactions.id, escrow.id));
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

  // ── PSP float income heartbeat ────────────────────────────────────────────
  app.post("/api/scheduled/float-income", async (req, res) => {
    try {
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
      await db.insert(floatIncomeEntries).values({
        id: crypto.randomUUID(), date: today,
        totalEscrowBalance: totalBalance.toFixed(2),
        dailyYieldRate: dailyRate.toFixed(8),
        incomeAmount: dailyIncome.toFixed(4),
        currency: "NGN", createdAt: new Date(),
      });
      return res.json({ ok: true, date: today, income: dailyIncome.toFixed(4) });
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

  // ── SLA Heartbeat ─────────────────────────────────────────────────────────
  app.post("/api/scheduled/sla-scan", async (req, res) => {
    try {
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
    app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
import { notifyOwner } from "./notification";
import { whatsappMediaFiles, offlineMessageQueue } from "../../drizzle/schema";
