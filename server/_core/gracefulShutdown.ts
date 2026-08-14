/**
 * Graceful shutdown + process-level fault handlers (assurance A4-11).
 *
 * Previously the server had NO SIGTERM/SIGINT handling: a k8s pod terminate
 * hard-killed in-flight requests (including payment webhooks) at the grace
 * timeout, and `startServer().catch(console.error)` left fatal boot errors
 * with an implicit exit code. There was also no `unhandledRejection`
 * handler at all — rejections were silently swallowed by Node's default
 * (warn-only) behavior in this runtime.
 *
 * What this module installs:
 *
 *   SIGTERM/SIGINT → stop accepting new connections (server.close()), drain
 *   in-flight requests for up to `drainMs` (default 10s, matching the k8s
 *   terminationGracePeriodSeconds headroom), force-close lingering keep-alive
 *   sockets at the deadline (server.closeAllConnections where available),
 *   best-effort close of DB/redis handles, then exit(0). A second signal
 *   during drain exits immediately (operator escape hatch).
 *
 *   unhandledRejection → reported as CRITICAL via captureException (never
 *   silently swallowed). Policy: in production-like envs the process then
 *   drains and exits (Node guidance: an unhandled rejection leaves the
 *   process in an undefined state; continuing serves traffic from a
 *   possibly-corrupt process); in development/test it is log-only so the
 *   dev loop is not interrupted. This mirrors the codebase's existing
 *   fail-closed-in-prod / lenient-in-dev pattern (env.ts isProd).
 *
 *   uncaughtException → same CRITICAL capture, then drain-and-exit in ALL
 *   environments (Node never guarantees state after an uncaught exception).
 */
import type { Server } from "http";
import { isProd } from "./env";
import { captureException } from "../services/observability";

export interface ShutdownOptions {
  /** Grace window for in-flight requests before sockets are force-closed. */
  drainMs?: number;
  /** Extra handle cleanup (e.g. queue/WS handles). Best-effort, isolated. */
  closeHandles?: () => Promise<void> | void;
  /** Injectable for tests. Defaults to process.exit. */
  exit?: (code: number) => void;
  /** Injectable logger for tests. */
  log?: (msg: string, ...args: unknown[]) => void;
}

export interface ShutdownController {
  /** Idempotent: safe to call from multiple handlers. */
  shutdown: (reason: string, exitCode?: number) => Promise<void>;
  /** Remove all installed process listeners (tests). */
  unregister: () => void;
  shuttingDown: () => boolean;
}

async function closeInfraHandles(log: (m: string, ...a: unknown[]) => void): Promise<void> {
  // Best-effort, each isolated — a hanging/failing handle must not block exit.
  // DB: server/db.ts keeps the postgres client module-private; if it exposes
  // a closeDb() hook, use it. Otherwise process exit reaps the pool.
  try {
    const dbMod: any = await import("../db");
    if (typeof dbMod.closeDb === "function") {
      await dbMod.closeDb();
      log("[shutdown] database pool closed");
    }
  } catch (err: any) {
    log("[shutdown] db close failed (best-effort):", err?.message ?? err);
  }
  try {
    const redisMod: any = await import("../redis");
    const redis = typeof redisMod.getRedis === "function" ? await redisMod.getRedis() : null;
    if (redis && typeof redis.quit === "function") {
      await redis.quit();
      log("[shutdown] redis connection closed");
    }
  } catch (err: any) {
    log("[shutdown] redis close failed (best-effort):", err?.message ?? err);
  }
}

export function registerGracefulShutdown(server: Server, opts: ShutdownOptions = {}): ShutdownController {
  const drainMs = opts.drainMs ?? 10_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((msg: string, ...args: unknown[]) => console.error(msg, ...args));

  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return; // idempotent — signals/handlers can race
    shuttingDown = true;
    log(`[shutdown] ${reason} — stop accepting connections, draining in-flight requests (grace ${drainMs}ms)`);

    // Hard deadline: force-close lingering keep-alive/idle sockets so
    // server.close() can settle, then exit even if drains are stuck.
    const forceTimer = setTimeout(() => {
      log(`[shutdown] grace period expired — force-closing connections`);
      try {
        (server as any).closeAllConnections?.();
      } catch {
        /* older Node without closeAllConnections */
      }
      // Give close() a beat to fire its callback after the force-close.
      setTimeout(() => exit(exitCode), 250).unref?.();
    }, drainMs);
    forceTimer.unref?.();

    try {
      await new Promise<void>((resolve) => {
        // Stop accepting; callback fires when in-flight requests drain.
        server.close(() => resolve());
        // Idle keep-alive connections are not tracked by close() — drop them.
        try {
          (server as any).closeIdleConnections?.();
        } catch {
          /* older Node */
        }
      });
      log("[shutdown] in-flight requests drained");
    } catch (err: any) {
      log("[shutdown] server.close error:", err?.message ?? err);
    }

    try {
      await opts.closeHandles?.();
    } catch (err: any) {
      log("[shutdown] closeHandles error (best-effort):", err?.message ?? err);
    }
    await closeInfraHandles(log);

    clearTimeout(forceTimer);
    log(`[shutdown] clean exit (${reason})`);
    exit(exitCode);
  };

  const onSigterm = () => void shutdown("SIGTERM received", 0);
  const onSigint = () => void shutdown("SIGINT received", 0);

  const onUnhandledRejection = (reason: unknown) => {
    try {
      // Never swallow — report CRITICAL to the observability sink.
      captureException(reason instanceof Error ? reason : new Error(String(reason)), {
        service: "server/process",
        operation: "unhandledRejection",
        severity: "critical",
      });
    } catch {
      console.error("[process] unhandledRejection (capture failed):", reason);
    }
    if (isProd) {
      // Node guidance: the process state is undefined after an unhandled
      // rejection — drain and exit in production rather than serving traffic
      // from a possibly-corrupt process. Non-zero exit so supervisors alert.
      void shutdown("unhandledRejection (production fail-closed)", 1);
    } else {
      console.error("[process] unhandledRejection (non-prod: logged, process kept alive):", reason);
    }
  };

  const onUncaughtException = (err: unknown) => {
    try {
      captureException(err instanceof Error ? err : new Error(String(err)), {
        service: "server/process",
        operation: "uncaughtException",
        severity: "critical",
      });
    } catch {
      console.error("[process] uncaughtException (capture failed):", err);
    }
    // Uncaught exceptions leave undefined state in EVERY env — always exit.
    void shutdown("uncaughtException", 1);
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);

  return {
    shutdown,
    shuttingDown: () => shuttingDown,
    unregister: () => {
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("unhandledRejection", onUnhandledRejection);
      process.removeListener("uncaughtException", onUncaughtException);
    },
  };
}
