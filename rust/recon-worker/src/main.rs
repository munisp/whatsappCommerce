//! Reconciliation Worker — Periodic financial reconciliation.
//!
//! Cross-references PostgreSQL payment_intents with TigerBeetle ledger entries.
//! Detects discrepancies, ACTIVELY REPAIRS orphaned pending transfers (voids
//! them via the ledger bridge), persists results, and reports runs to the
//! platform via the existing POST {PLATFORM_URL}/api/internal/events endpoint.
//! Runs on a configurable interval (default: 5 minutes).

use anyhow::Result;
use axum::{extract::State, response::Json, routing::{get, post}, Router};
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
    platform_api_key: String,
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
            platform_api_key: env::var("PLATFORM_API_KEY")
                .or_else(|_| env::var("INTERNAL_API_KEY"))
                .unwrap_or_default(),
            orphan_threshold_secs: env::var("RECON_ORPHAN_THRESHOLD_SECS")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(900),
        }
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

/// ACTIVE REPAIR: void an orphaned pending transfer via the ledger bridge.
/// Returns Ok(true) when the void was confirmed, Ok(false) when the transfer
/// was already settled (nothing to repair), Err on bridge failure.
async fn void_orphan(state: &AppState, pending_id: &str) -> Result<bool, String> {
    let resp = state.http
        .post(format!("{}/ledger/void", state.config.ledger_bridge_url))
        .json(&serde_json::json!({ "pending_id": pending_id }))
        .send()
        .await
        .map_err(|e| format!("void request failed: {}", e))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(true);
    }
    let body = resp.text().await.unwrap_or_default();
    // A 400/409 means the transfer is no longer pending (already committed or
    // voided) — nothing left to repair.
    if status.as_u16() == 400 || status.as_u16() == 409 {
        return Ok(false);
    }
    Err(format!("void returned {}: {}", status, body))
}

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
                let rows = client.query(
                    r#"SELECT id::text, "tenantId", "orderId",
                              CAST(amount AS float8) as amount,
                              status, "ledgerPendingId"
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
                            let id: String = row.get(0);
                            let tenant_id: String = row.get(1);
                            let amount: f64 = row.get(3);
                            let status: String = row.get(4);
                            let ledger_id: Option<String> = row.get(5);
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
                    let orphan_rows = client.query(
                        r#"SELECT id::text, "tenantId",
                                  CAST(amount AS float8) as amount,
                                  status, "ledgerPendingId"
                           FROM payment_intents
                           WHERE "ledgerPendingId" IS NOT NULL
                             AND status IN ('pending', 'failed', 'voided', 'ledger_drift')
                             AND "createdAt" < NOW() - make_interval(secs => $1)
                           LIMIT 500"#,
                        &[&(state.config.orphan_threshold_secs as f64)],
                    ).await;

                    match orphan_rows {
                        Ok(rows) => {
                            for row in &rows {
                                let id: String = row.get(0);
                                let tenant_id: String = row.get(1);
                                let amount: f64 = row.get(2);
                                let status: String = row.get(3);
                                let ledger_id: Option<String> = row.get(4);
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

        let mut req = state.http
            .post(format!("{}/api/internal/events", state.config.platform_api_url))
            .json(&serde_json::json!({ "events": events }));
        if !state.config.platform_api_key.is_empty() {
            req = req.header("X-Internal-Api-Key", &state.config.platform_api_key);
        }
        match req.send().await {
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

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().json().init();
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

    let port = state.config.port;
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/recon/trigger", post(trigger_recon_handler))
        .route("/recon/last", get(last_recon_handler))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!(addr = %addr, "Recon Worker listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(async { signal::ctrl_c().await.expect("ctrl_c") })
        .await?;
    Ok(())
}
