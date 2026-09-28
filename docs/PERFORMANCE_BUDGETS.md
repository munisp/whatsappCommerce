# Performance Budgets (W48)

Source: SPEC_W48 + the four Wave-48 audits. These p95 budgets are the
platform contract; journeys J477–J486 encode smoke-budget timing assertions
for the integration paths, and `server/services/net/resilientFetch.ts`
(`INTEGRATION_TIMEOUTS`) codifies the per-integration timeout table.

## Critical-path p95 budgets

| Path | p95 budget | Top pre-W48 contributor (finding) | W48 fix |
|---|---|---|---|
| WA webhook ack (200) | < 300 ms | DLQ JSONB insert awaited before ack (PERF-INT-7) | ack first; DLQ insert + fallback post-ack |
| Inbound WA message → bot reply (menu path) | < 2.5 s | ~8–12 serial DB RTs, uncached tenant lookup, serial batch fan-out (PERF-INT-6) | cached phone_number_id→tenant lookup (Redis 300s + in-proc), per-value hoisting, Promise.allSettled across changes |
| Inbound → reply (NLP/LLM path) | < 8 s | LLM RTT with backoff + serial pre-chain (PERF-INT-6) | same pre-chain fixes; LLM client unchanged (already bounded) |
| Catalog/menu list (portal & bot) | < 400 ms | uncached Postgres reads (PERF-INT-9) | tenant-record read-through cache (waTenantLookup); menu/catalog caches owned by Coder A (PERF-API-6/9) |
| Order create (confirm_order) | < 2.5 s | self-HTTP fraud call, no timeout (PERF-INT-3) | direct in-process `predictMlScore` call, 800 ms bounded ml-stack probe, in-process heuristic fallback (bounded fail-open) |
| Payment link generation | < 6 s | serial PSP initiate + fetchStatus probe + provider hop (PERF-INT-11) | hard overall chain deadline (PAYMENT_INITIATE_DEADLINE_MS, 25s worst case); NLP inline link fetches bounded at 10s + breaker |
| Payment confirm webhook ack | < 500 ms | confirm + 7 serial post-confirm hooks before 200 (PERF-INT-1) | owned by Coder A (ack-first, post-ack hooks) |
| Portal dashboard load | < 1.5 s | Permify RTT on every admin procedure (PERF-INT-5) | Permify check TTL cache (45s default, 30–60s band) with write invalidation; fail-closed on miss+outage preserved |
| Portal agent reply send | < 1.5 s | raw Graph call, no timeout/circuit/metering (PERF-INT-4) | routed through waSender.sendWhatsAppText (v21.0, 12s timeout, ban circuit, metering) |

## Integration timeout table (INTEGRATION_TIMEOUTS)

| Integration | Timeout | Retry | Circuit breaker |
|---|---|---|---|
| PSP initiate/verify (Paystack/Flutterwave/Mojaloop legacy adapters) | 10 s | verify GETs: 1 retry w/ backoff; initiate POSTs: none (double-charge doctrine) | per-provider, trip after 5 consecutive failures, 30s cooldown |
| Fraud/ML scoring (order-create path) | 800 ms | none (in-process heuristic fallback) | n/a — bounded fail-open |
| OpenSearch interactive search | 3 s (OPENSEARCH_REQUEST_TIMEOUT_MS) | none | — |
| Permify check | 3 s | none | cache absorbs RTT; fail-closed on miss+outage |
| WA Graph send (waSender) | 12 s | retriable classification | banCircuitBreaker (per phone_number_id) |
| Telegram send | 5–30 s (telegramSender, per-op) | existing | — |
| moto_dispatch courier | 8 s | none | generic breaker |

## Webhook ack doctrine

WA, Telegram and PSP webhooks ack (200) immediately after signature
verification; ALL durable persistence (DLQ rows) and processing happen
post-ack. Failure of post-ack persistence falls back to the durable
Redis-list/JSONL-file chain (W42 PLT-12) and raises an ops alert.

## Measurement sketch

Wrap integration calls in the existing telemetry
(`server/_core/telemetry.ts`) with `integration`, `op`, `timeout_ms`
labels; emit `webhook.ack_ms` (WA/TG/PSP separately) and
`inbound.reply_ms` (wamid → first outbound send); alert on p95 > 80% of
budget. Journey smoke budgets: J477 (PSP adapter timeout/breaker), J478
(fraud-gate bound), J479 (portal reply via waSender), J480 (Permify cache),
J481 (tenant lookup cache), J482 (ack-first ordering), J484 (sweep), J486
(end-to-end timing assertions).
