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
import { paymentTransactions, alertRules, alertRuleEvents, forecastSnapshots, tenants } from "../../drizzle/schema";
import { eq, and, gte, lte } from "drizzle-orm";
import { randomUUID } from "crypto";

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

  // tRPC API
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
