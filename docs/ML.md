# ML Models

WhatsApp Commerce ships two statistical/ML models. Both are **pure
TypeScript, dependency-free**, per-tenant, deterministic in tests, and
fail-open: a model fault must never break a business path.

| Model | Service | Storage | Output |
|---|---|---|---|
| Audit-stream anomaly detection | `server/services/auditAnomaly.ts` | `anomaly_alerts` (drizzle 0062) | alerts + auto-incidents |
| Lead propensity scoring | `server/services/mlLeadScoring.ts` | `lead_score_models` | `{ propensity, confidence, fallbackUsed }` |

---

## 1. Audit-stream anomaly detection (W20)

### Purpose
Behavioral anomaly detection over the SOC2 audit stream (`audit_chain`,
W19). Flags off-hours or high-volume bursts of sensitive activity — purge
executions, retention-policy upserts, customer data exports, incident
creation — and abnormal actor velocity.

### Features / signals
Per tenant, three signal families are scored per scan window (default 1h):

1. **Event-type rate per hour-of-day.** For each event type observed in the
   window, its count is compared against an EWMA baseline for that
   `(eventType, hourOfDay)` bucket learned from 14 days of history. Catches
   "purge at 03:00 when purges only ever happen at 10:00".
2. **Actor velocity.** Events per `actorId` in the window vs that actor's
   EWMA hourly baseline. Catches scripted bulk actions from a single account.
3. **Sensitive-event rate.** Count of `SENSITIVE_EVENT_TYPES`
   (`retention_purge`, `retention_policy_upsert`, `customer_data_export`,
   `incident_created`) in the window vs their EWMA baseline.

### Scoring
Each signal produces a **robust z-score**:

```
z = (observed − ewmaMean) / max(1.4826 · MAD(hourlyCounts), MIN_SIGMA)
score = clamp(z / Z_CAP, 0, 1)        // Z_CAP = 6, MIN_SIGMA = 0.5
```

The MAD-based dispersion is robust to historical outliers; `MIN_SIGMA`
guarantees that a never-before-seen event still scores high (baseline mean 0,
sigma 0.5 → 3 occurrences ≈ score 1.0). The **aggregate anomaly score is the
maximum** of the per-signal scores — any single strong signal is actionable.

### Training / baselines
There is no offline training step: baselines are folded online from the last
14 days (`BASELINE_WINDOW_MS`) of `audit_chain` rows with EWMA smoothing
(`EWMA_ALPHA = 0.3`, newest buckets dominate).

**Cold start:** fewer than `BASELINE_MIN_EVENTS` (20) baseline events →
`scanAuditAnomaliesTx` returns `{ baselineBuilding: true }` and writes **no
alerts**. The detector never alerts on a tenant it has not yet learned.

### Threshold & actions
- Alert threshold: **0.8** default, overridable via env
  **`AUDIT_ANOMALY_THRESHOLD`** (0..1) or per-call override.
- Score **≥ 0.95** additionally auto-opens a **critical incident** in the
  `incidents` register (same insert shape as the compliance router).
- Alerts are written to `anomaly_alerts` and are **idempotent per
  `(tenant_id, signal, window_bucket)`** (unique index +
  `onConflictDoNothing`): re-scanning the same bucket never duplicates.
- Alert lifecycle: `open → acknowledged | dismissed` via
  `compliance.updateAnomalyAlert`.

### Determinism
The clock is injectable (`opts.now` / the `now` input on
`compliance.anomalyScan`), so tests and journey J96 are fully deterministic.
No randomness is used anywhere in scoring.

### Fail-open contract
`scanAuditAnomaliesTx` never throws. Internal errors are caught and returned
as `{ alertsCreated: 0, error }` so a detector bug can never break a
compliance caller.

### Drift monitoring
Baselines are self-updating (EWMA over a rolling 14-day window), which
absorbs gradual drift. Operators monitor detector health via the ratio of
acknowledged-vs-dismissed alerts on the Compliance dashboard; a sustained
rise in dismissals signals baseline or threshold drift, tuned via
`AUDIT_ANOMALY_THRESHOLD`.

---

## 2. Lead propensity scoring (parallel W20 model — fixed contract)

> This section documents the **contract** for the model being delivered in
> `server/services/mlLeadScoring.ts` (table `lead_score_models`). The runtime
> entrypoint is `scoreCustomerMl(tenantId, customerId)` →
> `{ propensity, confidence, fallbackUsed }`.

### Model
Per-tenant **logistic regression** over customer interaction features.
Model parameters (weights, bias, feature version, training timestamp) are
persisted per tenant in `lead_score_models`, so each tenant's scorer is
learned only from its own data (no cross-tenant leakage).

### Features
Typical feature vector (fixed order, stored with the model row):
recency of last message/order, message frequency, order frequency, average
order value, cart-abandonment count, reply latency, promo-redemption rate.
Features are normalized with the training-set mean/std stored alongside the
weights so inference is bit-reproducible.

### Training
Batch retrain per tenant from historical labeled outcomes (e.g.
converted-within-7-days). Training is seeded (`seed` fixed per tenant/model
version) and uses deterministic shuffling, so the same training snapshot
produces byte-identical weights — required for reproducible tests.

**Retraining cadence:** nightly sweep for active tenants, plus on-demand
retrain after a minimum number of new labeled outcomes. Old model rows are
retained for rollback and drift comparison.

### Fallback contract
When a tenant has **no trained model** (insufficient labeled data), the
service falls back to the existing rules-based lead score and returns
`fallbackUsed: true`. Callers must treat `propensity` from a fallback as a
rules score, not an ML probability.

### Calibration / confidence
`propensity` is the logistic probability of conversion. `confidence`
expresses how much the score can be trusted — a function of training-set
size and feature coverage for the customer (e.g. many missing features or a
small training set → low confidence even when `propensity` is extreme). A
fallback score always reports `confidence` consistent with its rules origin
and `fallbackUsed: true`.

### Drift monitoring
Drift is monitored by comparing, per retrain, (a) feature-distribution
statistics (population stability index per feature) against the previous
model row in `lead_score_models`, and (b) score calibration (predicted vs
observed conversion rate by decile). Sustained PSI or calibration drift
triggers an earlier retrain or a rollback to the prior model row.

---

## 3. Broadcast uplift targeting (W21 — tranche 2)

### Purpose
Two-model **uplift scoring** for broadcast audience selection, layered on top
of the rule-based segment heuristics (`matchesSegment` in
`server/routers/broadcast.ts`). Instead of targeting "everyone who has not
ordered in ≥N days" (`noOrderSinceDays`), the merchant can rank candidates by
the modeled **incremental** effect of receiving the message.

### Approach: two per-tenant logistic regressions
- **Treatment model** — `P(purchase | received broadcast)`, trained on
  customers with ≥1 `sent` row in `broadcast_recipients` before the
  reference date.
- **Control model** — `P(purchase | no message)`, trained on comparable
  customers never messaged before the reference date.

Both are the same dependency-free full-batch gradient-descent logistic
regression as `mlLeadScoring` (fixed seed `2027`/`2028` per arm, fixed 400
iterations, L2) — deterministic: the same data retrains to byte-identical
weights.

### Features / labels
- **Features** (all normalized to [0,1], computed as-of the reference date):
  recency score, 90-day order frequency, lifetime monetary (log1p cents),
  reply rate (inbound WhatsApp replies per broadcast received, capped), and
  days-since-last-order (normalized).
- **Label**: the customer placed an order within **14 days** after the
  reference date (`now − 14d`). Customers with no pre-reference order
  history are excluded from both arms.
- **Uplift** = `pTreatment − pControl`, clamped to `[−1, 1]`.

### Storage
Registry table **`uplift_models`** (drizzle 0064): one row per
`(tenant_id, role, version)` with `weights_jsonb`, `feature_names`,
`trained_at`, `sample_count`, `logloss`. Each train bumps a shared version
for both arms together.

### Fallback contract
`scoreUplift(tenantId, customerId)` →
`{ uplift, confidence, fallbackUsed }` and **never throws**. Untrained
(either arm below the 40-sample gate), missing customer, malformed weights,
or any DB error → `{ uplift: null, fallbackUsed: true }`. In the broadcast
send path (`rankByUplift: true`), an untrained tenant silently keeps the
original `noOrderSinceDays` heuristic (`upliftRanked: false` in dry-run);
consent gates and marketing frequency caps apply identically in both modes.
When ranked, only customers with `uplift > 0.05` are kept, highest first.

### Cadence
Nightly per-tenant retrain via cron `POST /api/scheduled/uplift-model-tick`
(`runUpliftModelTick`), plus on-demand `broadcast.trainUpliftModel`.
Old rows are retained per version for rollback/drift comparison.

### Drift monitoring
Per retrain, compare each arm's log-loss and per-feature distribution
against the previous version's row in `uplift_models`; a sustained rise in
control-arm base rate or arm imbalance (treatment/control sample ratio)
signals audience-composition drift and should trigger review of the
`upliftThreshold`.

---

## 4. PD credit model (parallel tranche-2 model — fixed contract)

> This section documents the **contract** for the probability-of-default
> model delivered in `server/services/tradeCredit/mlPdScoring.ts` (table
> **`credit_pd_models`**). The runtime entrypoint is
> `scorePd(tenantId, buyerId)` → `{ pd, confidence, fallbackUsed }`.

### Model
Per-tenant **logistic regression** over trade-credit repayment outcomes:
label = default (invoice unpaid past due + grace) within the observation
window; features follow the same RFM-plus-credit philosophy — repayment
history, utilization, outstanding vs limit (integer cents), order cadence,
tenor of requested terms, and prior delinquency count.

### Expected-loss pricing
The expected-loss fee for a credit sale is a deterministic function

```
fee = clamp( f(PD, LGD, tenorDays), TERMS_BANDS.minFeeBps, TERMS_BANDS.maxFeeBps )
```

where `LGD` (loss given default) is a fixed constant per policy and the
result is clamped by the per-tenor `TERMS_BANDS` so fees can never leave the
approved band regardless of model output. All money math is integer cents.

### Fallback contract
`scorePd` never throws. No trained `credit_pd_models` row, below the
minimum-sample gate, or any error → `{ pd: null (or policy default),
fallbackUsed: true }` and fee computation uses the flat policy rate inside
`TERMS_BANDS`. A model fault can never move a fee outside the band.

### Determinism / cadence / drift
Seeded, fixed-iteration training (same philosophy as the lead/uplift
models); nightly retrain tick plus on-demand retrain; per-version rows in
`credit_pd_models` enable rollback. Drift is monitored via calibration of
predicted PD vs observed default rate by decile and PSI on the repayment
features.

## 5. LLM copilot (W22) — merchant Q&A + SOC2 incident triage

### Purpose
Two copilot capabilities over the EXISTING provider wrapper
(`server/_core/llm.ts` `invokeLLM` — no new provider, no new deps), in
`server/services/llmCopilot.ts`:
- `triageIncident(tenantId, incidentId)` — structured SOC2 triage
  `{ severitySuggestion, likelyCause, runbookSteps[], postmortemDraft }`
  built from the incident row + related `anomaly_alerts` + a
  keyword-retrieved excerpt of `docs/SOC2/*.md` (read from disk, chunked by
  markdown section, cached in memory, scored by query-token overlap).
- `merchantAsk(tenantId, question)` — merchant Q&A grounded on a compact
  tenant-scoped AGGREGATE snapshot: today's `salesCents` (integer cents),
  order count, top products (30d), credit outstanding/limit (integer cents).

### Provider gating
The LLM is invoked ONLY when `COPILOT_LLM_ENABLED=1|true` AND the shared
wrapper has `LLM_API_KEY` configured. Default OFF — tests and the
simulation run deterministically on the fallback. See `env.example.txt`.

### Fallback contract (never throws)
Provider disabled, network/HTTP failure, or unparseable/underspecified
reply → deterministic heuristic fallback with `fallbackUsed: true`:
- triage: keyword severity rules (`purge/export/breach → critical`,
  `payment/webhook/outage → high`, …) + generic SOC2 response steps spliced
  with bullet lines from the retrieved runbook excerpt.
- ask: a template answer assembled from the aggregate snapshot,
  question-aware (sales / top products / credit), empty-snapshot safe.
Missing incident rows and DB faults degrade to the same contract; no code
path throws.

### Redaction
Every string entering a prompt passes `redactForPrompt()`: reuses
`compliance/fakeHttp.redactSecrets` for the configured provider key plus
deterministic regexes for phone numbers (8+ digits), e-mails, `Bearer`
tokens and `api_key/token/secret/password=…` pairs. Merchant questions are
redacted and truncated (500 chars) before assembly; triage prompts carry
aggregate alert signals only, never row-level customer data.

### Audit logging
Every invocation inserts one `copilot_queries` row (migration 0067):
`(id, tenant_id, kind 'triage'|'ask', prompt_hash sha256, fallback_used,
latency_ms, created_at)`. Hashes/aggregates only — raw prompts, answers and
PII are NEVER persisted. Insert failures are warn-and-continue.

### Prompt construction
`triage`: fixed JSON-output instruction + incident block + alert signal
block + runbook excerpt (≤1200 chars). `ask`: fixed instruction ("answer
only from the snapshot") + integer-cents snapshot block + redacted
question. LLM triage replies are parsed with a strict shape validator
(`severitySuggestion` enum, non-empty cause/steps/postmortem); ask replies
are plain text bounded to [10, 2000] chars.
