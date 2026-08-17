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
