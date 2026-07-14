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
import { paymentTransactions } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

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
      // Count unreconciled (pending/failed) transactions in the last 24 hours
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
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
      const ALERT_THRESHOLD = 0.05; // alert if >5% unreconciled
      if (discrepancyRate > ALERT_THRESHOLD) {
        await notifyOwner({
          title: "⚠️ Reconciliation Alert: High Discrepancy Rate",
          content: `Nightly reconciliation check detected ${unreconciled} unreconciled transactions out of ${total} in the last 24 hours (${(discrepancyRate * 100).toFixed(1)}% discrepancy rate — threshold: ${(ALERT_THRESHOLD * 100).toFixed(0)}%). Please review the Reconciliation Simulation dashboard for details.`,
        }).catch((e: unknown) => console.warn("[reconciliation-alert] notification failed:", e));
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
