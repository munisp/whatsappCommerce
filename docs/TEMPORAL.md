# Temporal — how the pieces fit

Namespace `whatsapp-commerce` on the shared Temporal cluster (`temporal-frontend.temporal.svc.cluster.local:7233`,
UI at `temporal-web`). Task queue `whatsapp-commerce`.

## Moving parts

| Piece | Where | Role |
|---|---|---|
| Workflows | `services/temporal-workflows/workflows.ts` | Real `@temporalio/workflow` code, runs in Temporal's deterministic sandbox. Only pure imports allowed (guarded by `server/temporalWorkflowsStatic.test.ts`). |
| Activities | `services/temporal-workflows/activities.ts` | The only code that touches the outside world. Calls the server's tRPC `internalProcedure` endpoints. |
| Worker | `services/temporal-workflows/worker.ts` | Polls the queue; `GET /healthz` is 200 only while `RUNNING`. Exits non-zero on missing config (no idle "simulation mode"). |
| Internal API | `server/routers/temporalInternal.ts` | What the activities call. Needs `X-Internal-Token` = `INTERNAL_API_KEY`; a session (even admin) is not enough. |
| Client | `server/temporal.ts` | Starts workflows from the server. |
| Deploy | `services/temporal-workflows/Dockerfile`, `k8s-tools/temporal-worker.yaml` | Lean image; hand-applied (not Flux). |

## What is live

| Workflow | Status |
|---|---|
| `InventorySyncWorkflow` | **Backed.** Idempotent sync from `odoo_synced_products`; one tenant failing never aborts the rest. |
| `JourneyOrchestrationWorkflow` | **Backed.** The one place Temporal earns its keep (see below). The workflow only sequences; every step runs a registered journey activity server-side. |
| `TenantOnboardingWorkflow`, `OrderFulfillmentWorkflow`, `BroadcastCampaignWorkflow` | Workflow code is real and tested, but each activity fails with a non-retryable `ActivityNotImplemented`. **Deliberately not migrated** — see below. A step with no real backing never returns fabricated success. |
| `paymentSagaWorkflow` | **Does not exist** on any worker and is not implemented: there is no spec for it and it sits on the money path. The server must never start it on Temporal (guarded by `temporalWorkflowEnabled`). |

### Why only journeys, and why the rest stay where they are

Temporal is worth adopting where a flow needs durable multi-step sequencing that the platform does **not** already do:

- **Journey orchestration** — a chain of registered activities (discover → order → credit → inventory → audit) whose
  local fallback only *emulates* durability with checkpoints + a cron tick. On Temporal the retries, timers and replay are real.
- **Orders, broadcasts, onboarding** — already handled durably and idempotently by mature mechanisms in the platform
  (order/payment state machines with idempotency keys, the broadcast dispatcher with consent + rate limits, the onboarding
  copilot with resumable sessions). A second implementation on Temporal would add a path that can double-send or
  double-charge. They stay off until there is a concrete gap that Temporal fills.

### How a journey run works

```
server                                Temporal                     worker (activities)            server (internalProcedure)
startJourneyOrchestration ─start──▶  JourneyOrchestrationWorkflow
  records temporal_workflow_runs         │ getJourneyPlan ─────────────────────────────────────▶ temporalInternal.journeyPlan
  (runId = firstExecutionRunId)          │ for each step:
                                         │   runJourneyActivity(runId, name) ──────────────────▶ temporalInternal.runJourneyActivity
                                         │      └ runs ONE registered activity, checkpoints it in temporal_workflow_runs.result
                                         │ finishJourney(runId, completed|failed|cancelled) ───▶ temporalInternal.finishJourney
```

Properties (all proven against a real database in simulation journey **J467**):

- **Idempotent.** Each step carries the deterministic key `${runId}:${activityName}`. A step that already has a checkpoint is
  not re-executed (`{cached:true}`), so "ran, but the response was lost" retries are safe. A step that fails is retryable under the
  *same* key and the failure is recorded as `lastError` while the run stays `running`.
- **Server-owned data.** Tenant and params are read from the recorded run, never from the request. Step outputs stay in the run's
  checkpoints and never enter Temporal history (the response is just `{cached}`).
- **Always closed.** Failure and cancellation both close the run row (`failed` / `cancelled`, via a non-cancellable scope). A failure to
  close never masks the original error. Closing is idempotent; a closed run refuses further steps (409, not retried).
- **Contained.** A worker can only touch runs whose type is `JourneyOrchestrationWorkflow`; anything else is a 404.
- **Race-tolerant.** The server records the run row just after Temporal accepts the start; a fast worker waits (up to 10 s) for it.
- The cron tick (`runOrchestrationTick`) only resumes local (`local-…`) runs and ignores Temporal-owned ones.

## The switch: `TEMPORAL_ENABLED_WORKFLOWS`

Setting `TEMPORAL_ADDRESS` on the server does **not** move any flow onto Temporal. A workflow type
starts on Temporal only if it is named in `TEMPORAL_ENABLED_WORKFLOWS` (comma-separated, or `*`).
Default: none — every caller keeps its existing non-Temporal path (`started:false`, local record).

Do not enable a type until (a) its workflow exists, (b) every activity it calls is backed, and
(c) the flow's semantics actually fit. Today that is exactly:

```
TEMPORAL_ENABLED_WORKFLOWS=InventorySyncWorkflow,JourneyOrchestrationWorkflow
```

Known blockers for the others:

- `OrderFulfillmentWorkflow`: also needs a de-duplicated confirmation message (the order flow already notifies).
- `TenantOnboardingWorkflow`: `activateTenant` must go through `goLiveTenant()` so go-live gates cannot be bypassed.
- Payment saga: nothing to enable (no workflow).

Important: with `JourneyOrchestrationWorkflow` **enabled but no worker running**, `startJourneyOrchestration` returns
`mode:"temporal"` and skips local execution — journeys would sit `running` until a worker exists. Enable it only once the
worker is deployed and healthy. Disabled (the default) journeys run locally exactly as before.

Note: the server connects to Temporal lazily and remembers a failed first attempt for the life of the process; if Temporal was
unreachable at that moment, restart the server pods after fixing it (starts fall back to local records meanwhile, never lost).

## Tests

- Always on, hermetic (no database): `temporalActivities`, `temporalInternal` (auth + schemas), `temporalEnabledWorkflows`,
  `temporalWorkflowsStatic`.
- Always on, **real database** (PGlite via the simulation world, real HTTP server, the worker's own client): journeys
  **J467** (worker ⇄ platform contract: auth, inventory sync, journey steps, idempotent replay, closure, isolation) and
  **J468** (enable-list gate + what gets recorded), plus J317/J321.
- Opt-in (downloads the Temporal test server; ~30 s): `npm run test:temporal` — the workflows in the real sandbox with
  time skipping (7-day KYC waits run instantly), and the real worker process against a stand-in platform API.
- `npm run check` type-checks `services/temporal-workflows` (it used to be outside the tsconfig).

## Runbook

```bash
# one-time: register the namespace
kubectl -n temporal exec deploy/temporal-admintools -- temporal operator namespace create --namespace whatsapp-commerce --retention 72h
# deploy the worker
kubectl apply -f k8s-tools/temporal-worker.yaml
# run the pilot workflow once
kubectl -n temporal exec deploy/temporal-admintools -- temporal workflow start \
  --namespace whatsapp-commerce --task-queue whatsapp-commerce --type InventorySyncWorkflow \
  --workflow-id inventory-sync-manual-$(date +%s) --input '{}'
```
