import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { paymentTransactions, modelAbTests, datasetSnapshots } from "../../drizzle/schema";
import { desc, gte, sql, eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { load as yamlLoad } from "js-yaml";
import { spawn } from "child_process";

const MLRUNS_DIR = path.join(process.cwd(), "services/ml-stack/mlruns");

// ─── MLflow file reader helpers ───────────────────────────────────────────────

function readYaml(filePath: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return (yamlLoad as (s: string) => Record<string, unknown>)(content);
  } catch {
    return null;
  }
}

function readMetricFile(filePath: string): Array<{ timestamp: number; value: number; step: number }> {
  try {
    const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
    return lines.map(line => {
      const [ts, val, step] = line.trim().split(" ");
      return { timestamp: parseInt(ts), value: parseFloat(val), step: parseInt(step) };
    }).filter(r => !isNaN(r.value));
  } catch {
    return [];
  }
}

function getExperiments(): Array<{ id: string; name: string; createdAt: number }> {
  if (!fs.existsSync(MLRUNS_DIR)) return [];
  const entries = fs.readdirSync(MLRUNS_DIR);
  const experiments: Array<{ id: string; name: string; createdAt: number }> = [];
  for (const entry of entries) {
    if (entry === "0" || entry === ".trash") continue;
    const metaPath = path.join(MLRUNS_DIR, entry, "meta.yaml");
    const meta = readYaml(metaPath);
    if (meta) {
      experiments.push({
        id: entry,
        name: (meta.name as string) || entry,
        createdAt: (meta.creation_time as number) || 0,
      });
    }
  }
  return experiments;
}

function getRunsForExperiment(experimentId: string): Array<{
  runId: string; runName: string; status: string;
  startTime: number; endTime: number;
  metrics: Record<string, number>;
  metricHistory: Record<string, Array<{ step: number; value: number; timestamp: number }>>;
}> {
  const expDir = path.join(MLRUNS_DIR, experimentId);
  if (!fs.existsSync(expDir)) return [];
  const entries = fs.readdirSync(expDir).filter(e => e !== "meta.yaml" && e !== ".trash");
  const runs = [];
  for (const runId of entries) {
    const metaPath = path.join(expDir, runId, "meta.yaml");
    const meta = readYaml(metaPath);
    if (!meta) continue;
    const metricsDir = path.join(expDir, runId, "metrics");
    const metrics: Record<string, number> = {};
    const metricHistory: Record<string, Array<{ step: number; value: number; timestamp: number }>> = {};
    if (fs.existsSync(metricsDir)) {
      for (const mFile of fs.readdirSync(metricsDir)) {
        const history = readMetricFile(path.join(metricsDir, mFile));
        metricHistory[mFile] = history;
        if (history.length > 0) {
          metrics[mFile] = history[history.length - 1].value;
        }
      }
    }
    // status: 3 = FINISHED, 4 = FAILED, 1 = RUNNING, 2 = SCHEDULED
    const statusMap: Record<number, string> = { 1: "RUNNING", 2: "SCHEDULED", 3: "FINISHED", 4: "FAILED" };
    runs.push({
      runId,
      runName: (meta.run_name as string) || runId.slice(0, 8),
      status: statusMap[(meta.status as number)] || "UNKNOWN",
      startTime: (meta.start_time as number) || 0,
      endTime: (meta.end_time as number) || 0,
      metrics,
      metricHistory,
    });
  }
  return runs.sort((a, b) => b.startTime - a.startTime);
}

// ─── Simulated drift metrics (production: read from DuckDB warehouse) ─────────
function generateDriftTimeSeries(baseDate: number, points = 14): Array<{
  timestamp: number; psi: number; klDivergence: number; ksStatistic: number; label: string;
}> {
  const series = [];
  for (let i = points - 1; i >= 0; i--) {
    const ts = baseDate - i * 24 * 3600 * 1000;
    // Simulate gradually increasing drift over time
    const trend = i < 5 ? (5 - i) * 0.03 : 0;
    series.push({
      timestamp: ts,
      psi: parseFloat((0.02 + trend + Math.random() * 0.04).toFixed(4)),
      klDivergence: parseFloat((0.01 + trend * 0.5 + Math.random() * 0.02).toFixed(4)),
      ksStatistic: parseFloat((0.05 + trend * 0.3 + Math.random() * 0.03).toFixed(4)),
      label: new Date(ts).toISOString().slice(0, 10),
    });
  }
  return series;
}

export const mlOpsRouter = router({
  // List all MLflow experiments
  getExperiments: protectedProcedure.query(async () => {
    return getExperiments();
  }),

  // Get all runs for a specific experiment
  getMlflowRuns: protectedProcedure
    .input(z.object({ experimentId: z.string() }))
    .query(async ({ input }) => {
      return getRunsForExperiment(input.experimentId);
    }),

  // Get all runs across all experiments (summary view)
  getAllRuns: protectedProcedure.query(async () => {
    const experiments = getExperiments();
    const allRuns = [];
    for (const exp of experiments) {
      const runs = getRunsForExperiment(exp.id);
      for (const run of runs) {
        allRuns.push({ ...run, experimentId: exp.id, experimentName: exp.name });
      }
    }
    return allRuns.sort((a, b) => b.startTime - a.startTime);
  }),

  // Training status: latest run per experiment
  getTrainingStatus: protectedProcedure.query(async () => {
    const experiments = getExperiments();
    const status = [];
    for (const exp of experiments) {
      const runs = getRunsForExperiment(exp.id);
      const latest = runs[0];
      if (latest) {
        status.push({
          experimentId: exp.id,
          experimentName: exp.name,
          latestRunId: latest.runId,
          latestRunName: latest.runName,
          status: latest.status,
          startTime: latest.startTime,
          endTime: latest.endTime,
          durationMs: latest.endTime - latest.startTime,
          metrics: latest.metrics,
          totalRuns: runs.length,
          finishedRuns: runs.filter(r => r.status === "FINISHED").length,
          failedRuns: runs.filter(r => r.status === "FAILED").length,
        });
      }
    }
    return status;
  }),

  // Drift metrics time series (reads from DuckDB warehouse in production)
  getDriftMetrics: protectedProcedure
    .input(z.object({ modelName: z.string().optional(), days: z.number().min(1).max(90).default(14) }))
    .query(async ({ input }) => {
      const baseDate = Date.now();
      const series = generateDriftTimeSeries(baseDate, input.days);
      const latest = series[series.length - 1];
      return {
        modelName: input.modelName ?? "fraud_detection",
        series,
        summary: {
          currentPsi: latest.psi,
          currentKlDivergence: latest.klDivergence,
          currentKsStatistic: latest.ksStatistic,
          alertLevel: latest.psi > 0.2 ? "critical" : latest.psi > 0.1 ? "warning" : "healthy",
          retrainRecommended: latest.psi > 0.2,
        },
      };
    }),

  // A/B model comparison: champion vs challenger metrics
  getAbComparison: protectedProcedure.query(async () => {
    const experiments = getExperiments();
    const comparisons = [];
    for (const exp of experiments) {
      const runs = getRunsForExperiment(exp.id).filter(r => r.status === "FINISHED");
      if (runs.length >= 2) {
        const [challenger, champion] = runs;
        comparisons.push({
          experimentName: exp.name,
          champion: {
            runId: champion.runId,
            runName: champion.runName,
            metrics: champion.metrics,
            startTime: champion.startTime,
          },
          challenger: {
            runId: challenger.runId,
            runName: challenger.runName,
            metrics: challenger.metrics,
            startTime: challenger.startTime,
          },
          winner: (() => {
            const champScore = champion.metrics["val_auc_roc"] ?? champion.metrics["val_auc"] ?? 0;
            const challScore = challenger.metrics["val_auc_roc"] ?? challenger.metrics["val_auc"] ?? 0;
            return challScore > champScore ? "challenger" : "champion";
          })(),
        });
      } else if (runs.length === 1) {
        comparisons.push({
          experimentName: exp.name,
          champion: {
            runId: runs[0].runId,
            runName: runs[0].runName,
            metrics: runs[0].metrics,
            startTime: runs[0].startTime,
          },
          challenger: null,
          winner: "champion",
        });
      }
    }
    return comparisons;
  }),

  // Trigger retraining (in production: calls the Python continuous_trainer.py via subprocess)
  triggerRetraining: protectedProcedure
    .input(z.object({ modelName: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input }) => {
      // In production: spawn `python3 services/ml-stack/training/continuous_trainer.py --model ${input.modelName}`
      // For now: return a simulated trigger response
      return {
        ok: true,
        jobId: `retrain-${input.modelName}-${Date.now()}`,
        message: `Retraining job queued for model: ${input.modelName}. Reason: ${input.reason ?? "manual trigger"}`,
        estimatedDurationMs: 120000,
      };
    }),

  // Recent transaction volume for training data pipeline status
  getDataPipelineStatus: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) {
      return {
        newTransactionsSinceLastTrain: 0,
        thresholdToRetrain: 5000,
        percentToThreshold: 0,
        lastPipelineRun: null,
      };
    }
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentTransactions)
      .where(gte(paymentTransactions.createdAt, new Date(Date.now() - 7 * 24 * 3600 * 1000)));
    const count = result[0]?.count ?? 0;
    return {
      newTransactionsSinceLastTrain: count,
      thresholdToRetrain: 5000,
      percentToThreshold: Math.min(100, Math.round((count / 5000) * 100)),
      lastPipelineRun: new Date(Date.now() - 3600 * 1000).toISOString(),
    };
  }),

  // Per-step metric history for all runs in an experiment — powers time-series charts
  getMetricHistory: protectedProcedure
    .input(z.object({ experimentId: z.string() }))
    .query(async ({ input }) => {
      const runs = getRunsForExperiment(input.experimentId);
      // Collect all metric names across runs
     const allMetrics = new Set<string>();
     runs.forEach(r => Object.keys(r.metricHistory).forEach(m => allMetrics.add(m)));
     // Build per-metric time-series: [{step, run1Name, run2Name, ...}]
     const charts: Record<string, Array<Record<string, number | string>>> = {};
      for (const metric of Array.from(allMetrics)) {
        // Find max steps across runs for this metric
        const maxSteps = Math.max(...runs.map(r => (r.metricHistory[metric] ?? []).length), 0);
        if (maxSteps === 0) continue;
        const byStep: Record<number, Record<string, number | string>> = {};
        for (const run of runs.slice(0, 5)) { // cap at 5 runs for readability
          const history = run.metricHistory[metric] ?? [];
          for (const point of history) {
            if (!byStep[point.step]) byStep[point.step] = { step: point.step };
            byStep[point.step][run.runName] = parseFloat(point.value.toFixed(6));
          }
        }
        charts[metric] = Object.values(byStep).sort((a, b) => (a.step as number) - (b.step as number));
      }
      return {
        experimentId: input.experimentId,
        metrics: Array.from(allMetrics),
        runNames: runs.slice(0, 5).map(r => r.runName),
        charts,
      };
    }),
  getDriftAlerts: protectedProcedure.query(async () => {
    const driftLogPath = path.join(process.cwd(), "services/ml-stack/data/lakehouse/drift_log.json");
    try {
      const raw = fs.readFileSync(driftLogPath, "utf-8");
      const alerts = JSON.parse(raw) as Array<{ model: string; feature: string; psi: number; threshold: number; isDrifted: boolean; computedAt: string }>;
      return { alerts, critical: alerts.filter(a => a.isDrifted && a.psi > 0.2).length,
               warning: alerts.filter(a => a.isDrifted && a.psi <= 0.2).length, total: alerts.length };
    } catch { return { alerts: [], critical: 0, warning: 0, total: 0 }; }
  }),
});

// ── DB-backed A/B Test Management ────────────────────────────────────────────
export const mlAbTestRouter = router({
  list: protectedProcedure
    .input(z.object({ status: z.enum(["running", "concluded", "all"]).default("all") }).optional())
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const rows = await db.select().from(modelAbTests).orderBy(desc(modelAbTests.startedAt)).limit(50);
      if (input?.status && input.status !== "all") return rows.filter(r => r.status === input.status);
      return rows;
    }),
  create: protectedProcedure
    .input(z.object({
      modelName: z.string(),
      championVersion: z.string(),
      challengerVersion: z.string(),
      trafficSplitPct: z.number().min(5).max(50).default(20),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const [test] = await db.insert(modelAbTests).values({
        modelName: input.modelName,
        championVersion: input.championVersion,
        challengerVersion: input.challengerVersion,
        trafficSplitPct: input.trafficSplitPct,
        status: "running",
        notes: input.notes,
      }).returning();
      return test;
    }),
  conclude: protectedProcedure
    .input(z.object({
      id: z.string(),
      winner: z.enum(["champion", "challenger"]),
      championMetric: z.number().optional(),
      challengerMetric: z.number().optional(),
      pValue: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const [test] = await db.update(modelAbTests)
        .set({ status: "concluded", winner: input.winner, championMetric: input.championMetric,
               challengerMetric: input.challengerMetric, pValue: input.pValue, concludedAt: new Date() })
        .where(eq(modelAbTests.id, input.id)).returning();
      return test;
    }),
  triggerRetrainingReal: protectedProcedure
    .input(z.object({ modelName: z.string(), reason: z.string().optional(), dryRun: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      const scriptPath = path.join(process.cwd(), "services/ml-stack/training/continuous_trainer.py");
      const args = ["--model", input.modelName];
      if (input.dryRun) args.push("--dry-run");
      if (input.reason) args.push("--reason", input.reason);
      const jobId = `retrain-${input.modelName}-${Date.now()}`;
      const child = spawn("python3", [scriptPath, ...args], {
        detached: true, stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, MLFLOW_TRACKING_URI: "http://localhost:5000" },
      });
      child.unref();
      return { ok: true, jobId, pid: child.pid,
               message: `Retraining spawned for ${input.modelName}. Reason: ${input.reason ?? "manual"}`,
               dryRun: input.dryRun };
    }),
});

// ── Dataset Snapshots ─────────────────────────────────────────────────────────
export const datasetSnapshotRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(50).default(20) }).optional())
    .query(async ({ input }) => {
      const db = (await getDb())!;
      return db.select().from(datasetSnapshots).orderBy(desc(datasetSnapshots.createdAt)).limit(input?.limit ?? 20);
    }),
  create: protectedProcedure
    .input(z.object({
      label: z.string().optional(),
      totalImages: z.number(),
      bboxImages: z.number(),
      qualityImages: z.number(),
      classStats: z.record(z.string(), z.object({ total: z.number(), bbox: z.number(), quality: z.number() })),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [snap] = await db.insert(datasetSnapshots).values({
        label: input.label,
        totalImages: input.totalImages,
        bboxImages: input.bboxImages,
        qualityImages: input.qualityImages,
        classStats: input.classStats as Record<string, { total: number; bbox: number; quality: number }>,
        notes: input.notes,
        createdBy: ctx.user?.name ?? "system",
      }).returning();
      return snap;
    }),
});
