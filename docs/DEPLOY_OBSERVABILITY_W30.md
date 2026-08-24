# W30 — Deploy & Observability remediation (Coder E)

Fixes for Wave-29 verified findings V3#1–#8, #19, #20.

## Compose bootability (V3#1, V3#5)
The `platform` service now sets every `REQUIRED_BY_ENV` variable
(`server/_core/env.ts`) with dev-safe defaults — override ALL of them in any
real deployment: `KEYCLOAK_URL`, `APP_URL`, `SECRETS_MASTER_KEY`,
`KYC_SERVICE_API_KEY`, `WHATSAPP_VERIFY_TOKEN`. TigerBeetle's host port moved
to `3001` (`TIGERBEETLE_HOST_PORT`); the platform keeps host port 3000.

## KYC mock guard (V3#2)
The kyc-verifier image default is now `VLM_MOCK_MODE=false`. Compose opts into
the mock explicitly (DEV-ONLY override). The sidecar `/health` echoes
`vlm_mock_mode`, and the platform boot gate probes it in production and
refuses to serve while the sidecar reports mock vision.

## Cron scheduler (V3#3, V3#20)
`services/scheduler/scheduler.mjs` is the single source of truth for the 34
`/api/scheduled/*` routes and their cadences. It signs HS256 cron JWTs with
`CRON_JWT` (accepted by the local cron fast-path in `server/_core/sdk.ts`) and
runs as:
- the `scheduler` compose service (daemon), or
- per-route k8s CronJobs (`k8s/cron-scheduler.yaml`, `--once` mode).

Manual authenticated invocation:
`curl -X POST -H "Authorization: Bearer $(CRON_JWT=… node services/scheduler/scheduler.mjs --print-token /api/scheduled/sla-scan)" https://host/api/scheduled/sla-scan`

## Hermes (V3#4)
`HERMES_BRIDGE_URL=http://hermes-bridge:8096` is set for the platform in
compose and k8s (new `k8s/hermes-bridge.yaml`). `INTERNAL_API_KEY` is now in
`REQUIRED_BY_ENV` (prod refuses to boot without it). `hermes.approvePO`
propagates supplier-email failure honestly: the PO moves to the retryable
`approved_email_failed` state and the mutation returns
`{ success: false, error: "supplier_email_failed", retryable: true }` —
re-approving retries the email.

## Recon / ML wiring (V3#8)
Compose sets `RECON_WORKER_URL=http://recon-worker:8096` and
`ML_STACK_URL=http://ml-inference:8099`. `infra.triggerReconciliation` fails
loudly (PRECONDITION_FAILED with a setup hint when unconfigured;
INTERNAL_SERVER_ERROR when unreachable).

## Dashboard honesty (V3#6, V3#7)
Platform dashboard charts are fed by real queries
(`analytics.revenueTrend`, `analytics.conversationSplitTrend`) and render
explicit "No data yet" empty states. AdminPortal integration cards use the
live `infra.infraHealth` probe where one exists and show
"Unknown — no live check" otherwise. `mlOps.getDriftMetrics` derives its
series from the real drift log and returns `available:false` when the log is
absent — no simulated metrics are served as real. The drift-alert cron
reports `skipped` loudly when no drift log exists.

## Mojaloop (V3 align D#14)
`MOJALOOP_VALIDATE_SIG` defaults to `true` in compose/k8s. The bundled
`mojaloop-simulator` is a DEV-ONLY stub — point `MOJALOOP_API_URL` at a real
Mojaloop hub for anything beyond local development.

## CI (V3#19)
`docker-build` job builds the platform and scheduler images; the SOC2
controls self-check is now a required (blocking) step.
