//! Reconciliation Worker — Periodic financial reconciliation.
//!
//! Cross-references PostgreSQL payment_intents with TigerBeetle ledger entries.
//! Detects discrepancies, ACTIVELY REPAIRS orphaned pending transfers (voids
//! them via the ledger bridge), persists results, and reports runs to the
//! platform via the existing POST {PLATFORM_URL}/api/internal/events endpoint.
//! Runs on a configurable interval (default: 5 minutes).

use anyhow::Result;
use axum::{
    extract::{Request, State}, http::StatusCode, middleware::{self, Next}, response::{IntoResponse, Json, Response},
    routing::{get, post}, Router,
};
use chrono::Utc;
use deadpool_postgres::{Config as PgConfig, Pool, Runtime};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{env, sync::Arc, time::Duration};
use tokio::{signal, time};
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Debug, Clone)]
struct Config {
    port: u16,
    ledger_bridge_url: String,
    database_url: String,
    recon_interval_secs: u64,
    platform_api_url: String,
    /// Sent to the PLATFORM (`server`) only: PLATFORM_API_KEY, falling back to INTERNAL_API_KEY.
    platform_api_key: String,
    /// QA-039: the shared internal secret (INTERNAL_API_KEY and nothing else). It is (a) what this service's OWN
    /// /recon/* routes require, and (b) what it presents to the ledger-bridge. It used to share a variable with
    /// `platform_api_key`, so setting PLATFORM_API_KEY to anything else would silently have changed the inbound
    /// secret AND broken every bridge call. Empty = unauthenticated (rollout stage / dev), see `key_posture`.
    internal_api_key: String,
    /// QA-039: REQUIRE_INTERNAL_API_KEY=true makes an unset/empty key a startup failure instead of an open service.
    require_internal_api_key: bool,
    /// Pending transfers older than this (seconds) whose payment is not in an
    /// active state are actively voided by the worker.
    orphan_threshold_secs: u64,
}

impl Config {
    fn from_env() -> Self {
        Self {
            port: env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8096),
            ledger_bridge_url: env::var("LEDGER_BRIDGE_URL")
                .unwrap_or_else(|_| "http://localhost:8095".into()),
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://wc_user:wc_secret@localhost:5432/whatsapp_commerce".into()),
            recon_interval_secs: env::var("RECON_INTERVAL_SECS")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(300),
            platform_api_url: env::var("PLATFORM_API_URL")
                .or_else(|_| env::var("PLATFORM_URL"))
                .unwrap_or_else(|_| "http://localhost:3000".into()),
            platform_api_key: normalize_key(
                env::var("PLATFORM_API_KEY").or_else(|_| env::var("INTERNAL_API_KEY")).unwrap_or_default(),
            ),
            internal_api_key: normalize_key(env::var("INTERNAL_API_KEY").unwrap_or_default()),
            require_internal_api_key: env::var("REQUIRE_INTERNAL_API_KEY").map(|v| v == "true").unwrap_or(false),
            orphan_threshold_secs: env::var("RECON_ORPHAN_THRESHOLD_SECS")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(900),
        }
    }
}

/// A secret that is only whitespace is no secret: treat it as unset, so `is_empty()` means the same thing
/// everywhere it is asked (an empty Secret value must not be able to look "configured" to one check and "unset"
/// to another).
fn normalize_key(raw: String) -> String {
    if raw.trim().is_empty() { String::new() } else { raw }
}

/// What the startup check decided about the inbound gate.
#[derive(Debug, PartialEq)]
enum KeyPosture {
    Enforced,
    /// Unauthenticated, with a loud warning — only reachable when REQUIRE_INTERNAL_API_KEY is not set (dev, the
    /// e2e stack, or the first stage of a rollout).
    OpenWithWarning,
}

/// QA-039: fail CLOSED. A missing or empty INTERNAL_API_KEY used to mean "serve everything unauthenticated"; a
/// Deployment whose Secret was emptied (or whose env entry was dropped in a refactor) would have gone quietly
/// open. With REQUIRE_INTERNAL_API_KEY=true (set in the k8s manifest) that state now refuses to start instead.
fn key_posture(internal_api_key: &str, require: bool) -> Result<KeyPosture, String> {
    if !internal_api_key.is_empty() {
        Ok(KeyPosture::Enforced)
    } else if require {
        Err("REQUIRE_INTERNAL_API_KEY=true but INTERNAL_API_KEY is unset or empty — refusing to start with /recon/* unauthenticated".into())
    } else {
        Ok(KeyPosture::OpenWithWarning)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReconResult {
    run_id: Uuid,
    started_at: String,
    completed_at: String,
    total_checked: u64,
    matched: u64,
    discrepancies: u64,
    repairs_attempted: u64,
    repairs_succeeded: u64,
    alerts: Vec<ReconAlert>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReconAlert {
    severity: String,
    message: String,
    tenant_id: Option<String>,
    amount_diff: Option<f64>,
}

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    http: Client,
    pg: Option<Pool>,
    last_recon: Arc<tokio::sync::RwLock<Option<ReconResult>>>,
    recon_count: Arc<std::sync::atomic::AtomicU64>,
}

impl AppState {
    async fn new(cfg: Config) -> Self {
        let pg = connect_pg(&cfg.database_url).await;
        Self {
            config: Arc::new(cfg),
            http: Client::builder().timeout(Duration::from_secs(10)).build().unwrap(),
            pg,
            last_recon: Arc::new(tokio::sync::RwLock::new(None)),
            recon_count: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }
}

async fn connect_pg(url: &str) -> Option<Pool> {
    let mut cfg = PgConfig::new();
    cfg.url = Some(url.to_string());
    match cfg.create_pool(Some(Runtime::Tokio1), tokio_postgres::NoTls) {
        Ok(pool) => match pool.get().await {
            Ok(_) => { info!("PostgreSQL connected (recon-worker)"); Some(pool) }
            Err(e) => { warn!("PG pool get failed: {}", e); None }
        },
        Err(e) => { warn!("PG pool creation failed: {}", e); None }
    }
}

/// Classification of a /ledger/void response for repair decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VoidClassification {
    /// 2xx — the orphaned pending transfer was voided; repair confirmed.
    Voided,
    /// 400/409 — the transfer is already final (committed or voided);
    /// nothing left to repair.
    AlreadyFinal,
    /// 5xx or unreachable — transient bridge failure; retry next cycle.
    Retry,
}

/// AF-05: a completed intent with no `ledgerPendingId` is still ledger-tracked
/// when the server settled it with direct single-phase legs and recorded that
/// in `metadata.ledgerSettle.mode = "direct"` (server/services/paymentConfirm.ts
/// settleIntentLedger). Without this, every such intent — e.g. every wallet
/// top-up — raised "completed without ledger tracking" on every pass.
fn settled_by_direct_legs(mode: Option<&str>) -> bool {
    mode == Some("direct")
}

fn classify_void_status(status: Option<u16>) -> VoidClassification {
    match status {
        Some(s) if (200..300).contains(&s) => VoidClassification::Voided,
        Some(400) | Some(409) => VoidClassification::AlreadyFinal,
        _ => VoidClassification::Retry,
    }
}

/// ACTIVE REPAIR: void an orphaned pending transfer via the ledger bridge.
/// Returns Ok(true) when the void was confirmed, Ok(false) when the transfer
/// was already settled (nothing to repair), Err on bridge failure.
/// Builds (does not send) the void request, so what it carries can be tested without a bridge to talk to.
fn void_request(state: &AppState, pending_id: &str) -> reqwest::RequestBuilder {
    let mut req = state.http
        .post(format!("{}/ledger/void", state.config.ledger_bridge_url))
        .json(&serde_json::json!({ "pending_id": pending_id }));
    // QA-038: the bridge requires this once its own INTERNAL_API_KEY is set (see require_internal_key below).
    // QA-039: it is the INTERNAL key, not the platform key — they are different variables now.
    if !state.config.internal_api_key.is_empty() {
        req = req.header("X-Internal-Api-Key", &state.config.internal_api_key);
    }
    req
}

/// Builds (does not send) the recon report to the platform. This one carries the PLATFORM key, on purpose.
fn platform_events_request(state: &AppState, events: &[serde_json::Value]) -> reqwest::RequestBuilder {
    let mut req = state.http
        .post(format!("{}/api/internal/events", state.config.platform_api_url))
        .json(&serde_json::json!({ "events": events }));
    if !state.config.platform_api_key.is_empty() {
        req = req.header("X-Internal-Api-Key", &state.config.platform_api_key);
    }
    req
}

async fn void_orphan(state: &AppState, pending_id: &str) -> Result<bool, String> {
    let resp = void_request(state, pending_id).send().await;
    let (status, body) = match resp {
        Ok(r) => (Some(r.status().as_u16()), r.text().await.unwrap_or_default()),
        Err(e) => (None, e.to_string()),
    };
    match classify_void_status(status) {
        VoidClassification::Voided => Ok(true),
        VoidClassification::AlreadyFinal => Ok(false),
        VoidClassification::Retry => Err(format!(
            "void returned {}: {}",
            status.map(|s| s.to_string()).unwrap_or_else(|| "unreachable".into()),
            body
        )),
    }
}

// === W35 otel ===
#[tracing::instrument(name = "recon.run", skip(state), fields(component = "recon-worker"))]
// === END W35 otel ===
async fn run_recon(state: &AppState) -> ReconResult {
    let run_id = Uuid::new_v4();
    let started_at = Utc::now().to_rfc3339();
    let mut alerts = Vec::new();
    let mut total_checked = 0u64;
    let mut matched = 0u64;
    let mut repairs_attempted = 0u64;
    let mut repairs_succeeded = 0u64;

    // 1. Check ledger bridge health
    let mut ledger_reachable = false;
    match state.http.get(format!("{}/health", state.config.ledger_bridge_url)).send().await {
        Ok(r) if r.status().is_success() => {
            info!(run_id = %run_id, "ledger reachable");
            ledger_reachable = true;
        }
        Ok(r) => {
            warn!(run_id = %run_id, status = %r.status(), "ledger non-200");
            alerts.push(ReconAlert {
                severity: "warning".into(),
                message: format!("Ledger bridge returned {}", r.status()),
                tenant_id: None,
                amount_diff: None,
            });
        }
        Err(e) => {
            error!(run_id = %run_id, error = %e, "ledger unreachable");
            alerts.push(ReconAlert {
                severity: "critical".into(),
                message: format!("Ledger bridge unreachable: {}", e),
                tenant_id: None,
                amount_diff: None,
            });
        }
    }

    // 2. Cross-reference payment_intents with ledger balances
    if let Some(ref pool) = state.pg {
        match pool.get().await {
            Ok(client) => {
                // Fetch completed payment intents from last 24h
                // NB: payment_intents.status is the Postgres enum
                // payment_intent_status. tokio-postgres cannot decode a custom
                // enum into a Rust String, and Row::get PANICS on a decode
                // error — so the pass crashed whenever a completed/failed
                // intent existed in the last 24h (it only "worked" on an empty
                // table). Cast to text in SQL and parse with try_get below.
                let rows = client.query(
                    r#"SELECT id::text, "tenantId", "orderId",
                              CAST(amount AS float8) as amount,
                              status::text AS status, "ledgerPendingId",
                              metadata->'ledgerSettle'->>'mode' AS ledger_settle_mode
                       FROM payment_intents
                       WHERE status IN ('completed', 'failed')
                         AND "createdAt" > NOW() - INTERVAL '24 hours'
                       LIMIT 1000"#,
                    &[],
                ).await;

                match rows {
                    Ok(rows) => {
                        total_checked = rows.len() as u64;
                        for row in &rows {
                            // A row we cannot decode must surface as an alert
                            // (we could not verify it), never crash the run.
                            let parsed: Result<(String, String, f64, String, Option<String>, Option<String>), _> = (|| {
                                Ok::<_, tokio_postgres::Error>((
                                    row.try_get(0)?, row.try_get(1)?, row.try_get(3)?,
                                    row.try_get(4)?, row.try_get(5)?, row.try_get(6)?,
                                ))
                            })();
                            let (id, tenant_id, amount, status, ledger_id, settle_mode) = match parsed {
                                Ok(v) => v,
                                Err(e) => {
                                    error!(run_id = %run_id, error = %e, "unparseable payment_intents row");
                                    alerts.push(ReconAlert {
                                        severity: "high".into(),
                                        message: format!("Could not decode a payment_intents row during reconciliation: {}", e),
                                        tenant_id: None,
                                        amount_diff: None,
                                    });
                                    continue;
                                }
                            };
                            // Integer minor units, explicit round-half-up.
                            let expected_minor = (amount * 100.0).round() as i64;

                            // For completed payments, verify the ledger reflects
                            // the payment — comparing AMOUNTS, not just presence.
                            if status == "completed" {
                                if let Some(ref lid) = ledger_id {
                                    let ledger_url = format!("{}/balance/{}", state.config.ledger_bridge_url, lid);
                                    match state.http.get(&ledger_url).send().await {
                                        Ok(r) if r.status().is_success() => {
                                            let data = r.json::<serde_json::Value>().await.unwrap_or_default();
                                            let balance_minor = data["balance_minor"].as_i64()
                                                .or_else(|| data["balance"].as_f64().map(|b| (b * 100.0).round() as i64))
                                                .unwrap_or(0);
                                            let reserved_minor = data["reserved_minor"].as_i64()
                                                .or_else(|| data["reserved"].as_f64().map(|b| (b * 100.0).round() as i64))
                                                .unwrap_or(0);
                                            let observed_minor = balance_minor + reserved_minor;
                                            if observed_minor < expected_minor {
                                                // Ledger entry exists but does not
                                                // cover the completed payment.
                                                alerts.push(ReconAlert {
                                                    severity: "high".into(),
                                                    message: format!(
                                                        "Payment {} amount drift: expected {} minor units, ledger entry {} holds {}",
                                                        id, expected_minor, lid, observed_minor
                                                    ),
                                                    tenant_id: Some(tenant_id.clone()),
                                                    amount_diff: Some((expected_minor - observed_minor) as f64 / 100.0),
                                                });
                                            } else {
                                                matched += 1;
                                            }
                                        }
                                        _ => {
                                            alerts.push(ReconAlert {
                                                severity: "high".into(),
                                                message: format!(
                                                    "Payment {} completed ({} minor units) but ledger entry {} not found",
                                                    id, expected_minor, lid
                                                ),
                                                tenant_id: Some(tenant_id.clone()),
                                                amount_diff: Some(amount),
                                            });
                                        }
                                    }
                                } else if settled_by_direct_legs(settle_mode.as_deref()) {
                                    // AF-05: no two-phase reservation, but the
                                    // server posted the direct settle legs and
                                    // stamped metadata.ledgerSettle — tracked.
                                    matched += 1;
                                } else {
                                    // Completed payment with no ledger ID
                                    alerts.push(ReconAlert {
                                        severity: "medium".into(),
                                        message: format!(
                                            "Payment {} completed ({} minor units) without ledger tracking",
                                            id, expected_minor
                                        ),
                                        tenant_id: Some(tenant_id),
                                        amount_diff: Some(amount),
                                    });
                                }
                            } else {
                                matched += 1; // Failed payments don't need ledger entries
                            }
                        }
                        info!(run_id = %run_id, total = total_checked, matched = matched, "DB recon complete");
                    }
                    Err(e) => {
                        error!(run_id = %run_id, error = %e, "DB query failed");
                        alerts.push(ReconAlert {
                            severity: "critical".into(),
                            message: format!("DB query failed: {}", e),
                            tenant_id: None,
                            amount_diff: None,
                        });
                    }
                }

                // 3. ACTIVE REPAIR: void orphaned pending transfers — payments
                // stuck in a non-active state (or never initiated) whose
                // ledger reservation is older than the orphan threshold.
                if ledger_reachable {
                    // The status list must be labels of the payment_intent_status
                    // enum (initiated, pending, completed, failed, cancelled,
                    // refunded). This query used to list 'voided' and
                    // 'ledger_drift', which are not labels — Postgres rejected
                    // the whole statement ("invalid input value for enum"), so
                    // this repair pass could never run. Kept to the valid,
                    // non-active states the original list meant; guarded by
                    // server/reconWorkerSchema.test.ts.
                    let orphan_rows = client.query(
                        r#"SELECT id::text, "tenantId",
                                  CAST(amount AS float8) as amount,
                                  status::text AS status, "ledgerPendingId"
                           FROM payment_intents
                           WHERE "ledgerPendingId" IS NOT NULL
                             AND status IN ('pending', 'failed', 'cancelled')
                             AND "createdAt" < NOW() - make_interval(secs => $1)
                           LIMIT 500"#,
                        &[&(state.config.orphan_threshold_secs as f64)],
                    ).await;

                    match orphan_rows {
                        Ok(rows) => {
                            for row in &rows {
                                let parsed: Result<(String, String, f64, String, Option<String>), _> = (|| {
                                    Ok::<_, tokio_postgres::Error>((
                                        row.try_get(0)?, row.try_get(1)?, row.try_get(2)?,
                                        row.try_get(3)?, row.try_get(4)?,
                                    ))
                                })();
                                let (id, tenant_id, amount, status, ledger_id) = match parsed {
                                    Ok(v) => v,
                                    Err(e) => {
                                        error!(run_id = %run_id, error = %e, "unparseable orphan-candidate row");
                                        continue;
                                    }
                                };
                                let Some(lid) = ledger_id else { continue };
                                repairs_attempted += 1;
                                match void_orphan(state, &lid).await {
                                    Ok(true) => {
                                        repairs_succeeded += 1;
                                        warn!(run_id = %run_id, payment = %id, pending = %lid,
                                              "repaired orphan pending transfer (voided)");
                                    }
                                    Ok(false) => {
                                        repairs_succeeded += 1;
                                        info!(run_id = %run_id, payment = %id, pending = %lid,
                                              "orphan pending transfer already settled");
                                    }
                                    Err(e) => {
                                        alerts.push(ReconAlert {
                                            severity: "high".into(),
                                            message: format!(
                                                "Failed to void orphan pending transfer {} for payment {} (status {}): {}",
                                                lid, id, status, e
                                            ),
                                            tenant_id: Some(tenant_id),
                                            amount_diff: Some(amount),
                                        });
                                    }
                                }
                            }
                            if repairs_attempted > 0 {
                                info!(run_id = %run_id, attempted = repairs_attempted,
                                      succeeded = repairs_succeeded, "orphan repair pass complete");
                            }
                        }
                        Err(e) => {
                            warn!(run_id = %run_id, error = %e, "orphan pending query failed");
                        }
                    }
                }
            }
            Err(e) => {
                error!(run_id = %run_id, error = %e, "DB connection failed");
            }
        }
    }

    // 4. Persist/report recon result
    let discrepancies = alerts.len() as u64;
    let result = ReconResult {
        run_id,
        started_at: started_at.clone(),
        completed_at: Utc::now().to_rfc3339(),
        total_checked,
        matched,
        discrepancies,
        repairs_attempted,
        repairs_succeeded,
        alerts: alerts.clone(),
    };

    // Notify the platform via the EXISTING internal events endpoint:
    // POST {PLATFORM_URL}/api/internal/events with X-Internal-Api-Key and an
    // events array (the same ingestion path fluvio-consumer uses).
    if (discrepancies > 0 || repairs_attempted > 0) && !state.config.platform_api_url.is_empty() {
        let base_offset = Utc::now().timestamp_millis();
        let mut events: Vec<serde_json::Value> = alerts.iter().enumerate().map(|(i, a)| {
            serde_json::json!({
                "topic": "recon.discrepancy",
                "offset": base_offset + i as i64,
                "partition": 0,
                "tenantId": a.tenant_id,
                "eventType": "recon.alert",
                "payload": {
                    "runId": run_id.to_string(),
                    "severity": a.severity,
                    "message": a.message,
                    "amount_diff": a.amount_diff,
                },
            })
        }).collect();
        events.push(serde_json::json!({
            "topic": "recon.run",
            "offset": base_offset + events.len() as i64,
            "partition": 0,
            "eventType": "recon.run_completed",
            "payload": {
                "runId": run_id.to_string(),
                "total_checked": total_checked,
                "matched": matched,
                "discrepancies": discrepancies,
                "repairs_attempted": repairs_attempted,
                "repairs_succeeded": repairs_succeeded,
            },
        }));

        match platform_events_request(&state, &events).send().await {
            Ok(r) if r.status().is_success() => {
                info!(run_id = %run_id, "recon results reported to platform");
            }
            Ok(r) => {
                warn!(run_id = %run_id, status = %r.status(), "platform rejected recon report");
            }
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "failed to notify platform of recon results");
            }
        }
    }

    result
}

async fn health_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let count = state.recon_count.load(std::sync::atomic::Ordering::Relaxed);
    let last = state.last_recon.read().await;
    Json(serde_json::json!({
        "status": "ok",
        "service": "recon-worker",
        "recon_count": count,
        "last_run": last.as_ref().map(|r| &r.completed_at),
        "last_discrepancies": last.as_ref().map(|r| r.discrepancies),
        "last_repairs_attempted": last.as_ref().map(|r| r.repairs_attempted),
        "last_repairs_succeeded": last.as_ref().map(|r| r.repairs_succeeded),
    }))
}

async fn trigger_recon_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let result = run_recon(&state).await;
    *state.last_recon.write().await = Some(result.clone());
    state.recon_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Json(serde_json::to_value(result).unwrap())
}

async fn last_recon_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let last = state.last_recon.read().await;
    match last.as_ref() {
        Some(r) => Json(serde_json::to_value(r).unwrap()),
        None => Json(serde_json::json!({ "status": "no_runs_yet" })),
    }
}


// === W35 otel ===
/// Fail-open OTel init (SPEC_W35 Coder B). OTEL_ENABLED (default false) gates
/// instrumentation; OTEL_EXPORTER_OTLP_ENDPOINT defaults to
/// http://otel-collector:4318. Exporter build failure -> warn + fmt-only.
/// Returns true when the OTLP tracer layer was installed.
fn init_telemetry(service_name: &str, default_directive: Option<&str>) -> bool {
    opentelemetry::global::set_text_map_propagator(
        opentelemetry_sdk::propagation::TraceContextPropagator::new(),
    );
    let enabled = std::env::var("OTEL_ENABLED")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    if !enabled {
        let sub = tracing_subscriber::fmt().json();
        if let Some(d) = default_directive {
            sub.with_env_filter(
                tracing_subscriber::EnvFilter::from_default_env()
                    .add_directive(d.parse().expect("valid directive")),
            )
            .init();
        } else {
            sub.init();
        }
        return false;
    }
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .unwrap_or_else(|_| "http://otel-collector:4318".to_string());
    match build_otel_tracer(&endpoint, service_name) {
        Ok(tracer) => {
            use tracing_subscriber::prelude::*;
            let mut filter = tracing_subscriber::EnvFilter::from_default_env();
            if let Some(d) = default_directive {
                filter = filter.add_directive(d.parse().expect("valid directive"));
            }
            tracing_subscriber::registry()
                .with(filter)
                .with(tracing_subscriber::fmt::layer().json())
                .with(tracing_opentelemetry::layer().with_tracer(tracer))
                .init();
            true
        }
        Err(e) => {
            tracing_subscriber::fmt().json().init();
            tracing::warn!(error = %e, "W35 otel: exporter setup failed; continuing uninstrumented");
            false
        }
    }
}

/// Build an OTLP/tonic span exporter and provider. Errors bubble up to
/// init_telemetry, which falls back to fmt-only logging (fail-open).
fn build_otel_tracer(
    endpoint: &str,
    service_name: &str,
) -> Result<opentelemetry_sdk::trace::SdkTracer, opentelemetry_otlp::ExporterBuildError> {
    use opentelemetry::trace::TracerProvider;
    use opentelemetry_otlp::WithExportConfig;
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(endpoint.to_string())
        .build()?;
    let provider = opentelemetry_sdk::trace::SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(
            opentelemetry_sdk::Resource::builder()
                .with_service_name(service_name.to_string())
                .build(),
        )
        .build();
    opentelemetry::global::set_tracer_provider(provider.clone());
    Ok(provider.tracer(service_name.to_string()))
}
// === END W35 otel ===

/// The real, single definition of the app's routing — main() and the tests below both call this, so a
/// mistake here (a route added to the wrong group) is something the tests can actually catch.
fn build_router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/recon/trigger", post(trigger_recon_handler))
        .route("/recon/last", get(last_recon_handler))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_internal_key));
    Router::new()
        .route("/health", get(health_handler))
        .merge(protected)
        .with_state(state)
}


/// Resolves when the process is asked to stop: SIGTERM (what Kubernetes sends on EVERY pod deletion — a rollout, a
/// drain, a scale-down, an eviction) or SIGINT (Ctrl-C).
///
/// QA-042: this used to wait for SIGINT only. As PID 1 in a container, a signal with no handler installed is IGNORED
/// (the kernel does not apply default actions to PID 1), so on every pod deletion the process simply kept running until
/// SIGKILL at the end of the grace period. For ledger-bridge that was a 30-second outage per pod termination: its
/// `tb-adapter` sidecar (Node) DOES handle SIGTERM and exits within ~3 s, leaving a live bridge answering
/// `503 ledger_unavailable` to every client whose keep-alive connection was pinned to it — measured: 150 failed reserves
/// in exactly 30.0 s at 5/s, from deleting ONE of two healthy replicas.
async fn shutdown_signal() {
    let ctrl_c = async { signal::ctrl_c().await.expect("install SIGINT handler") };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("shutdown signal received — draining and exiting");
}

#[tokio::main]
async fn main() -> Result<()> {
    // === W35 otel ===
    let otel_enabled = init_telemetry("recon-worker", None);
    info!(otel_enabled, "telemetry initialized");
    // === END W35 otel ===
    let cfg = Config::from_env();
    let interval = cfg.recon_interval_secs;
    let state = AppState::new(cfg).await;

    info!(interval_secs = interval, "Recon Worker starting");

    // Background reconciliation loop
    let bg_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = time::interval(Duration::from_secs(interval));
        loop {
            ticker.tick().await;
            info!("Starting reconciliation run");
            let result = run_recon(&bg_state).await;
            info!(
                run_id = %result.run_id,
                total = result.total_checked,
                matched = result.matched,
                discrepancies = result.discrepancies,
                repairs_attempted = result.repairs_attempted,
                repairs_succeeded = result.repairs_succeeded,
                "Reconciliation complete"
            );
            *bg_state.last_recon.write().await = Some(result);
            bg_state.recon_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    });

    match key_posture(&state.config.internal_api_key, state.config.require_internal_api_key) {
        Ok(KeyPosture::Enforced) => info!("internal API key gate: ENFORCED on /recon/trigger and /recon/last"),
        Ok(KeyPosture::OpenWithWarning) => warn!("INTERNAL_API_KEY is not set — /recon/trigger and /recon/last are UNAUTHENTICATED (dev / rollout stage; set REQUIRE_INTERNAL_API_KEY=true in any real deployment)"),
        Err(e) => {
            error!("{}", e);
            std::process::exit(1);
        }
    }
    let port = state.config.port;
    let app = build_router(state);

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!(addr = %addr, "Recon Worker listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Constant-time byte comparison (duplicated from ledger-bridge deliberately: these are two independent
/// binary crates with no shared internal lib, and the function is short enough that a shared crate would
/// cost more than it saves). Mirrors what `subtle`/Go's `crypto/subtle.ConstantTimeCompare` do.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// QA-038: /recon/trigger runs the active ledger-repair pass and /recon/last exposes recon results — the
/// NetworkPolicy (QA-026) restricts WHO can reach the pod, this restricts WHAT they may ask it to do.
/// /health is exempt (kubelet's probe sends no header).
async fn require_internal_key(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if state.config.internal_api_key.is_empty() {
        return next.run(req).await;
    }
    let presented = ["x-internal-api-key", "x-internal-token", "x-api-key"]
        .iter()
        .find_map(|h| req.headers().get(*h))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(presented.as_bytes(), state.config.internal_api_key.as_bytes()) {
        // Method and path only — never the presented value (see ledger-bridge's require_internal_key).
        warn!(method = %req.method(), path = %req.uri().path(), "rejected request: missing or invalid internal API key");
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "invalid_internal_api_key" }))).into_response();
    }
    next.run(req).await
}

// ─── Tests ────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    #[test]
    fn direct_leg_settlement_counts_as_tracked() {
        assert!(super::settled_by_direct_legs(Some("direct")));
        assert!(!super::settled_by_direct_legs(None));
        assert!(!super::settled_by_direct_legs(Some("")));
        assert!(!super::settled_by_direct_legs(Some("pending")));
    }

    use super::*;

    /// Void-response classification contract:
    ///   200       → voided (repair confirmed)
    ///   400/409   → already-final (nothing to repair)
    ///   5xx/None  → retry (transient bridge failure / unreachable)
    #[test]
    fn void_classification_contract() {
        assert_eq!(classify_void_status(Some(200)), VoidClassification::Voided);
        assert_eq!(classify_void_status(Some(201)), VoidClassification::Voided);
        assert_eq!(classify_void_status(Some(400)), VoidClassification::AlreadyFinal);
        assert_eq!(classify_void_status(Some(409)), VoidClassification::AlreadyFinal);
        assert_eq!(classify_void_status(Some(500)), VoidClassification::Retry);
        assert_eq!(classify_void_status(Some(502)), VoidClassification::Retry);
        assert_eq!(classify_void_status(Some(503)), VoidClassification::Retry);
        assert_eq!(classify_void_status(None), VoidClassification::Retry, "unreachable bridge must retry");
    }

    // ── QA-038: internal API key gate ───────────────────────────────────────────────────────────────────

    fn test_state(key: &str) -> AppState {
        AppState {
            config: Arc::new(Config {
                port: 8096,
                ledger_bridge_url: "http://127.0.0.1:1".into(), // unreachable on purpose — tests below never need it to answer
                database_url: String::new(),
                recon_interval_secs: 300,
                platform_api_url: "http://127.0.0.1:2".into(),
                platform_api_key: String::new(),
                internal_api_key: key.to_string(),
                require_internal_api_key: false,
                orphan_threshold_secs: 900,
            }),
            http: Client::new(),
            pg: None,
            last_recon: Arc::new(tokio::sync::RwLock::new(None)),
            recon_count: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    /// Not a duplicate of build_router — calls it, so a mistake in the real wiring is something these tests
    /// can catch (a hand-copied second router here would test only itself).
    fn app(state: AppState) -> Router {
        build_router(state)
    }

    fn req(method: &str, path: &str, key: Option<&str>) -> axum::http::Request<axum::body::Body> {
        let mut b = axum::http::Request::builder().method(method).uri(path);
        if let Some(k) = key { b = b.header("x-internal-api-key", k); }
        b.body(axum::body::Body::empty()).unwrap()
    }

    #[test]
    fn constant_time_eq_is_a_real_equality_check() {
        assert!(constant_time_eq(b"same-secret", b"same-secret"));
        assert!(!constant_time_eq(b"same-secret", b"different!!!"));
        assert!(!constant_time_eq(b"", b""));
    }

    #[tokio::test]
    async fn when_no_key_is_configured_recon_trigger_and_last_are_open() {
        use tower::ServiceExt;
        let res = app(test_state("")).oneshot(req("GET", "/recon/last", None)).await.unwrap();
        assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn once_configured_recon_trigger_refuses_no_key_and_the_repair_pass_never_runs() {
        use tower::ServiceExt;
        // If the middleware let this through, run_recon would try a real DB/bridge call and this test
        // would hang or error for the WRONG reason — a 401 here also proves the handler was never invoked.
        let res = app(test_state("s3cret")).oneshot(req("POST", "/recon/trigger", None)).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn once_configured_recon_last_refuses_the_wrong_key() {
        use tower::ServiceExt;
        let res = app(test_state("s3cret")).oneshot(req("GET", "/recon/last", Some("nope"))).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn once_configured_recon_last_accepts_the_right_key() {
        use tower::ServiceExt;
        let res = app(test_state("s3cret")).oneshot(req("GET", "/recon/last", Some("s3cret"))).await.unwrap();
        assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn health_never_requires_the_key() {
        use tower::ServiceExt;
        let res = app(test_state("s3cret")).oneshot(req("GET", "/health", None)).await.unwrap();
        assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn the_void_request_carries_the_configured_key_and_is_otherwise_the_request_we_expect() {
        // This is the call that actually VOIDS ledger reservations, so what it sends matters: the key (or the
        // bridge, once enforcing, would refuse every repair), the right method/URL, and the pending id.
        let req = void_request(&test_state("s3cret"), "pending-1").build().unwrap();
        assert_eq!(req.method(), "POST");
        assert_eq!(req.url().as_str(), "http://127.0.0.1:1/ledger/void");
        assert_eq!(req.headers().get("x-internal-api-key").unwrap(), "s3cret");
        let body = std::str::from_utf8(req.body().unwrap().as_bytes().unwrap()).unwrap().to_string();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap()["pending_id"], "pending-1");
    }

    // ── QA-039: separate secrets, fail closed ──────────────────────────────────────────────────────────

    fn state_with_both(internal: &str, platform: &str) -> AppState {
        let mut st = test_state(internal);
        let mut cfg = (*st.config).clone();
        cfg.platform_api_key = platform.to_string();
        st.config = Arc::new(cfg);
        st
    }

    #[test]
    fn the_bridge_gets_the_internal_key_and_the_platform_gets_the_platform_key_when_they_differ() {
        // Before QA-039 both came from one variable, so PLATFORM_API_KEY!=INTERNAL_API_KEY made every bridge call 401.
        let st = state_with_both("internal-secret", "platform-secret");
        let void = void_request(&st, "p1").build().unwrap();
        assert_eq!(void.headers().get("x-internal-api-key").unwrap(), "internal-secret");
        let report = platform_events_request(&st, &[serde_json::json!({"k": 1})]).build().unwrap();
        assert_eq!(report.url().as_str(), "http://127.0.0.1:2/api/internal/events");
        assert_eq!(report.headers().get("x-internal-api-key").unwrap(), "platform-secret");
    }

    #[tokio::test]
    async fn the_inbound_gate_checks_the_internal_key_not_the_platform_key() {
        use tower::ServiceExt;
        let st = || state_with_both("internal-secret", "platform-secret");
        let with_platform = app(st()).oneshot(req("GET", "/recon/last", Some("platform-secret"))).await.unwrap();
        assert_eq!(with_platform.status(), StatusCode::UNAUTHORIZED, "the platform key must not open /recon/*");
        let with_internal = app(st()).oneshot(req("GET", "/recon/last", Some("internal-secret"))).await.unwrap();
        assert_ne!(with_internal.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn a_whitespace_only_secret_is_treated_as_unset() {
        assert_eq!(normalize_key("   \n".into()), "");
        assert_eq!(normalize_key("".into()), "");
        assert_eq!(normalize_key("real-secret".into()), "real-secret");
    }

    #[test]
    fn key_posture_enforces_when_a_key_is_set_whatever_the_require_flag_says() {
        assert_eq!(key_posture("k", false), Ok(KeyPosture::Enforced));
        assert_eq!(key_posture("k", true), Ok(KeyPosture::Enforced));
    }

    #[test]
    fn key_posture_refuses_to_start_open_when_required() {
        let e = key_posture("", true).unwrap_err();
        assert!(e.contains("INTERNAL_API_KEY") && e.contains("refusing to start"), "{e}");
    }

    #[test]
    fn key_posture_only_allows_open_when_not_required() {
        assert_eq!(key_posture("", false), Ok(KeyPosture::OpenWithWarning));
    }

    #[test]
    fn with_no_key_configured_the_void_request_sends_no_key_header() {
        let req = void_request(&test_state(""), "pending-1").build().unwrap();
        assert!(req.headers().get("x-internal-api-key").is_none());
    }

    // ── QA-042: SIGTERM must stop the process ───────────────────────────────────────────────────────────

    /// Sends a REAL SIGTERM to this test process. If `shutdown_signal` did not install a SIGTERM handler, the signal
    /// would terminate the whole test binary (a failed run), which is exactly the production bug: nothing here
    /// registers a handler except the function under test.
    #[tokio::test]
    async fn sigterm_resolves_shutdown_signal() {
        let task = tokio::spawn(shutdown_signal());
        tokio::time::sleep(std::time::Duration::from_millis(300)).await; // let it install its handlers
        assert!(!task.is_finished(), "shutdown_signal must not resolve on its own");
        let status = std::process::Command::new("kill").args(["-TERM", &std::process::id().to_string()]).status().unwrap();
        assert!(status.success());
        tokio::time::timeout(std::time::Duration::from_secs(3), task)
            .await
            .expect("shutdown_signal did not resolve after SIGTERM")
            .unwrap();
    }

    #[test]
    fn the_server_is_wired_to_shutdown_signal_not_to_ctrl_c_alone() {
        // Only the PRODUCTION half of the file: this test module contains these very strings, so searching the whole
        // file would make the positive assertion vacuously true and the negative one impossible.
        let prod = include_str!("main.rs").split("#[cfg(test)]").next().unwrap();
        assert!(prod.contains(".with_graceful_shutdown(shutdown_signal())"), "axum::serve must use shutdown_signal()");
        assert!(!prod.contains("signal::ctrl_c().await.expect(\"ctrl_c\")"), "SIGINT-only shutdown is the QA-042 bug");
    }
}
