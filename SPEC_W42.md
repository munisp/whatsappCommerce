# SPEC_W42 — Remediation: platform reliability P1s (W36 audit)

Base: main @ 3491bac906ac9e849611eabd499afc87706cd522 (post-W41). BINDING. Sources: /mnt/agents/output/w36/audit-platform.md rows PLT-5..PLT-15 (P1 cluster) + p0-verification.md.

## Global invariants
- paymentConfirm.ts PINNED (md5 2f77ea4816d1adc5cb35473bd35d1697). Additive-only schema; hand-written migrations 0130+ (journal after 0129). Lockfiles FROZEN. Banner edits. Fail-closed on money paths; fail-open on telemetry. Honest-status doctrine. Fast-fail after 2 attempts; push incrementally.
- Journeys: A=J307–J311, B=J312–J316, C=J317–J321 (register; merger owns count).

## Coder A — messaging pipeline durability (PLT-5 Kafka drift, PLT-6 ingestor ACK, PLT-7 DLQ Vec, PLT-12 WA DLQ-insert)
1. PLT-6: webhook-ingestor must NOT 200-ack when Kafka publish fails — return 5xx (retryable) or persist to durable fallback + 202; fix + test.
2. PLT-5: broker drift — wacommerce.* Kafka events have no in-repo consumer (consumer reads Fluvio). Honest resolution: EITHER wire the Fluvio consumer bridge (read actual fluvio-consumer code first — if it can subscribe Kafka topics via config, document + config) OR migrate the side-publish to Fluvio directly (matching consumer) OR remove dead publish with honest doc. Choose the minimal real integration; NO better-mock.
3. PLT-7: message-processor in-memory Vec DLQ -> durable DLQ (Redis list or PG table — check what infra the service already has; pick existing).
4. PLT-12: WA webhook DLQ-insert failure currently only logged -> durable fallback (file/Redis) + alert via existing ops path.
Journeys: publish-fail -> 5xx; DLQ durability across restart (sim); dead-letter replay path. Branch w42/pipeline.

## Coder B — secrets/auth hardening (PLT-9 rotation, PLT-11 OTP caps, PLT-13 shared CRON_JWT, PLT-14 TLS)
1. PLT-9: secrets versioned key scheme (v1: -> multi-version read + current-version write; rotation runbook doc + re-encrypt sweep for a sample secret type; verify existing crypto helper design first).
2. PLT-11: OTP/PIN attempt caps -> distributed (Redis-backed or PG-backed counter) instead of per-replica memory; keep existing cap semantics.
3. PLT-13: per-job cron auth — CRON_JWT per-route scope claim (issuer includes route; verifier checks scope); replay protection via jti + short exp (check existing impl first, extend don't rewrite).
4. PLT-14: TLS rejectUnauthorized:false -> true with CA bundle env override (PG/Redis/OpenSearch clients) + honest dev-self-signed doc.
Journeys: rotation reads old+new; OTP cap shared across "replicas" (two app instances in sim); wrong-scope cron JWT 403; TLS misconfig honest error. Branch w42/secrets.

## Coder C — workflow/reliability (PLT-10 Temporal versioning, PLT-15 PGlite-only money paths, PLT pool leaks P2-adjacent)
1. PLT-10: Temporal workflow versioning — add patch/versioning markers to existing workflows (read temporal-workflows; use workflow.patch or deterministic version constants) + remove auto-approve stub activities flagged in audit (replace with real handler or honest fail).
2. PLT-15: document + extend the strongest money-path tests to a real-PG integration profile (docker-compose pg service exists? — check; if yes add integration test script gated behind PG_INTEGRATION=1, migrate + run W38 refund/clawback suite against real PG; if no, honest doc + PGlite limitation note in RESILIENCE.md).
3. PLT pool leaks (P2-17 from audit): withRetry client-swap leak fix + pool max queue bound.
Journeys: workflow version marker present + stub gone; integration profile honest-skip without PG; pool leak regression test. Branch w42/workflows.

## Merger (reuse warm coder)
Order A→B→C. Journal re-chain only if migrations created. Journey count = actual. Full gate: tsc 0 (8GB) / vitest 0 fail / sim N+N / authz / pin / lockfiles unchanged / no empties / no markers. merge-log + merged tree; lead fast-publishes.
