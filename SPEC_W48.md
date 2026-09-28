# SPEC_W48 — Comprehensive Performance Tuning (server, client, mobile/PWA, sidecars, integrations)

Source audits (read yours FIRST — every finding has file:line evidence + fix sketch):
- /mnt/agents/output/w48/audit-api-db.md — 19 findings (3 P0)
- /mnt/agents/output/w48/audit-frontend-mobile.md — 12 findings (2 P0)
- /mnt/agents/output/w48/audit-sidecars.md — 30 findings (5 P0)
- /mnt/agents/output/w48/audit-integrations.md — 13 findings (2 Critical)

Total: 74 findings (12 P0/Critical). Mandate: fix ALL. IDs are contracts; journeys/tests must reference them.

## Performance budgets (become the contract — encode in tests/journeys where feasible)
- API reads p95 < 200ms, commerce writes p95 < 500ms (sim-harness measurable via journey step timing assertions where practical)
- Webhook ack (WA/TG/PSP) < 100ms of in-ack work — process post-ack
- Initial JS < 250KB gzip; LCP < 2.5s; INP < 200ms; 60fps lists (virtualization)
- Sidecar consumers: no per-message O(N) sweeps, no in-loop sleeping retries, no unbounded in-memory growth

## Global invariants (binding)
- paymentConfirm.ts: Coder A MAY make the minimal perf edit (post-commit receipt send, parallel hooks). Record the NEW md5 in the merge log; all other invariants on that file's money semantics stay (claim-first, idempotency, verify-before-compensate). No other coder touches it.
- Additive-only schema; hand-written migrations, journal idx+prevId chain on 0170 tip, cumulative snapshots = full column union.
- Fail-closed money, fail-open telemetry. Integer cents. Channel parity (WA+TG). Banner `// === W48 <topic> ===`.
- No TEMP STUB, no empty files, lockfiles frozen (except Coder B adding @tanstack/react-virtual + self-hosted fonts — B owns package.json/lockfile changes ONLY; others must not touch them).
- New env vars → env.example.txt. New cron/scheduled routes → cronAuth scope+jti + scheduler.mjs allowlist.

## Coder A — API + DB (audit-api-db.md + PERF-INT-1 from integrations) — 20 items
Branch w48/api-db. Migrations 0171-0172. Journeys J467-J476.
- PERF-API-1/INT-1: PSP webhooks ack-first, process post-ack (mirror WA pattern; dedupe intact).
- PERF-API-2: paymentConfirm minimal edit — parallelize maybe* hooks (Promise.allSettled), move WA receipt send post-commit/post-response. Record new md5.
- PERF-API-3: journeys.enroll batch (inArray select + multi-row insert, chunk 500).
- PERF-API-4: composite indexes (tenantId,status,createdAt DESC) on orders/conversations + other DDL from report (additive migrations).
- PERF-API-6/9: chat-path DB reads — Redis read-through cache for catalog context/menus/tenant settings with invalidation on product/tenant writes (use existing enqueueProductSync seam); keep fail-open on cache miss.
- conversation.getMessages phone filter pushdown (SQL not JS); compression middleware for API/tRPC JSON; listMyListings N+1; remaining P1/P2 per report.

## Coder B — Frontend + Mobile/PWA (audit-frontend-mobile.md) — 12+ items
Branch w48/frontend. No migrations. Journeys: none — instead add/extend client vitest (bundleSplit.test.ts update) + build metrics.
- PERF-FE-1: wire vite-plugin-pwa (autoUpdate, offline.html fallback, asset caching) + registration.
- PERF-FE-2: lazy-load Dashboard charts (recharts out of initial bundle; update bundleSplit.test.ts contract).
- PERF-FE-3: QueryClient defaults (staleTime 30s, refetchOnWindowFocus false).
- PERF-FE-4: virtualize Orders/Products/Conversations (+ portal conversations) — @tanstack/react-virtual (you own package.json + lockfile; minimal dep add).
- PERF-FE-5: polling discipline — visibility-gated, raised intervals.
- PERF-FE-6: self-host Inter/JetBrains Mono subsets + preload; FE-7 img lazy/dimensions; FE-8 portal manualChunks; FE-9 dep dedupe (client-side); FE-10 memo widgets; FE-11 memo TenantContext value; FE-12 useMutation for CSV validate; FE-13 viewport fix + mobile payload trimming where trivial.
- Gate: pnpm/npm build succeeds; bundleSplit test green; report initial-chunk gzip sizes before/after in the commit message.

## Coder C — Sidecars Go/Rust/Python (audit-sidecars.md) — 30 items
Branch w48/sidecars. No TS migrations. Verify compiles with the sandbox toolchain: Go at $HOME/sdk/go/bin (if missing: install per /tmp pattern or apt golang), Rust via apt cargo/rustc (or $HOME/sdk/cargo). Run `go build ./...` / `cargo check` / `python -m py_compile` for every touched service and paste results in your report.
- PERF-SC-1: fix double-import build breaker in go-orchestrator; then go build ALL go services.
- PERF-SC-2: message-processor dedup — time-bucketed eviction, no per-message retain().
- PERF-SC-3: consumer retry → bounded backoff + DLQ handoff, batch fetch + async/commit-batch (notification-service + hermes-bridge).
- PERF-SC-4: webhook-ingestor producer map mutex (or sync.Map / single writer).
- PERF-SC-5/17: ml-stack — pooled psycopg2 (or asyncpg), inference off the event loop (run_in_executor / worker).
- SC-8: hermes-bridge ingest detached context; SC-9: JWKS cache outside write lock + timeout; SC-12: fluvio offset persistence + span sampling; SC-13: ledger-bridge bounded transfer cache (LRU+TTL); SC-14: hermes-router short-id panic fix; SC-15: Temporal start retry policy + workflow-id dedup; SC-16: Redis eviction policy split (volatile-lru for cache keys, noeviction for idempotency/approval — document + config); SC-18: ai-agent inverted condition fix. Then remaining P1/P2.

## Coder D — Integrations & budgets (audit-integrations.md minus INT-1) — 12 items
Branch w48/integrations. Migrations 0173-0174 (only if needed). Journeys J477-J486.
- PERF-INT-2: PSP legacy adapters — timeout (AbortController 10s) + retry-with-backoff + circuit breaker on initiate/verify.
- PERF-INT-3: fraud gate — replace self-HTTP loopback with direct function call or add hard timeout (≤800ms) + fail-open-bounded; document choice.
- PERF-INT-4: portal agent reply routes through waSender (v21.0, timeout, ban circuit, metering).
- PERF-INT-5: Permify check cache (30-60s TTL, invalidation on membership/role writes; fail-closed semantics preserved on cache miss+Permify down).
- PERF-INT-6: phone_number_id→tenant lookup cache + parallelize fan-out where safe.
- Remaining Medium/Low per report + publish the p95 budget table as docs/PERFORMANCE_BUDGETS.md (from the audit's 9 critical paths) + wire 2-3 journey timing assertions as smoke budgets.

## Merger (after A-D push)
Merge into w48-merged; journal re-chain 0170→0174; snapshots union; runner J467-J486 order; sim count = actual; gates: tsc 0 / full vitest 0 fail / full sim N/N / authz 8/8 / paymentConfirm NEW md5 recorded + money semantics journeys green / TEMP STUB 0 / empties / journal verify / transcripts regen / go build + cargo check all sidecars green / bundle budget report. Push + merge-log.md + message lead.
