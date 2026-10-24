# Architecture Decisions (W62 F15/F16/F17)

Append-only ADR log for the W61 graph-audit INFO findings.

## ADR-W62-01 (F15): Mutations without detected writes are intentional

The W61 AST-lite scan flagged 100 tRPC mutations with no statically-detected
drizzle write. W62 spot-verified a sample; all are write-less **by design**:

| Mutation | Why no drizzle write |
|---|---|
| shopifyIntegrationRouter.connect / .callback / .syncNow | Shopify external API + OAuth redirect; persistence via dedicated webhook path |
| tenantConfigRouter.uploadLogo / medusaOnboardingRouter.uploadImage | Object-storage upload (S3); URL stored via settings helper |
| mlOpsRouter.triggerRetraining / mlAbTestRouter.triggerRetrainingReal | ML pipeline trigger (external job) |
| temporalRouter.startWorkflow / startOnboarding / startOrderFulfillment / startBroadcast / startInventorySync | Temporal workflow start (deterministic IDs + REJECT_DUPLICATE) |
| keycloakRouter.testConnection | External connectivity probe |
| aiRouter.chat | AI provider call |
| searchRouter.indexMessage | OpenSearch indexing |
| reconciliationRouter.simulate | Read-only dry-run |
| whatsappMediaRouter.setUssdMode / setSmsFailover | Writes via dynamically-imported schema (`nlpSessions`) — scan false negative |
| infraRouter.provisionTbAccount / triggerReconciliation | TigerBeetle ledger / recon sidecar calls |

Decision: no change. The remaining ~90 are the same categories
(PSP/external calls, tenant settings JSON, storage uploads, ML triggers,
webhook dispatches) plus known scan false negatives (raw `sql`` writes,
server/db.ts helpers, dynamic `await import` dispatch).

## ADR-W62-02 (F16): Append-only / external-read tables

`processed_webhook_events` (dedupe ledger), `raw_webhook_events`,
`fluvio_event_log`, `wa_webhook_events`, audit/DLQ/ledger tables
(`payment_mismatch_quarantine`, `odoo_synced_invoices`, `float_income_entries`,
`merchant_credit_scores`, etc.) are intentionally write-mostly: read by
sweeps, dashboards, or external systems rather than tRPC queries. No reader
in the scan ≠ dead. See docs/table-ownership.md for the writer audit.

## ADR-W62-03 (F17): Infra declared but not adopted

The following infra components appear in manifests/docs but are deliberately
**not adopted** by the platform code. Rationale in each case: *not needed at
current scale; revisit when the stated trigger occurs.*

| Component | Status | Revisit when |
|---|---|---|
| Redpanda | Not adopted; Kafka (+ Fluvio side-publish) suffices | Kafka broker ops burden exceeds managed/self-hosted envelope |
| Sedona | Not adopted | Geospatial query volume justifies spatial indexing beyond current lat/lng columns |
| PostGIS | Not adopted (plain lat/lng columns + haversine) | Radius/search accuracy requirements exceed haversine-on-columns |
| GeoLibre | Not adopted | Multi-region geo serving required |
| NATS | Not adopted; Kafka/Dapr pubsub cover messaging | Edge/leaf-node messaging topology needed |
| Iceberg | Not adopted; analytics read from Postgres replicas | Lakehouse-scale analytical workloads |
| In-repo MinIO server | Not adopted; external S3-compatible endpoint used | Self-hosted object storage mandate |
| In-repo OpenSearch server | Not adopted; external OpenSearch endpoint | Self-hosted search mandate |
| Dapr state store | Not adopted (Dapr pubsub only); Redis is the state store | Multi-runtime state portability required |
