//! ledger-bridge — TigerBeetle HTTP bridge for WhatsApp Commerce
//!
//! Exposes a simple REST API that translates payment operations into
//! TigerBeetle double-entry ledger entries via the TigerBeetle HTTP proxy.
//!
//! Endpoints:
//!   POST /ledger/reserve   — Create a pending transfer (two-phase commit)
//!   POST /ledger/commit    — Post a pending transfer (finalise)
//!   POST /ledger/void      — Void a pending transfer (rollback)
//!   POST /ledger/transfer  — Single-phase transfer
//!   GET  /ledger/account/:id — Get account balance
//!   GET  /health           — Health check

use anyhow::Result;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::{env, sync::Arc};
use tracing::{error, info, warn};
use uuid::Uuid;

// ─── Config ───────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    tigerbeetle_url: String,
    client: reqwest::Client,
}

// ─── Request / Response Types ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ReserveRequest {
    account_id: String,
    amount: f64,
    currency: String,
    #[serde(rename = "ref")]
    reference: String,
}

#[derive(Debug, Serialize)]
struct ReserveResponse {
    pending_id: String,
    status: String,
}

#[derive(Debug, Deserialize)]
struct CommitRequest {
    pending_id: String,
}

#[derive(Debug, Deserialize)]
struct VoidRequest {
    pending_id: String,
}

#[derive(Debug, Deserialize)]
struct TransferRequest {
    debit_account_id: String,
    credit_account_id: String,
    amount: f64,
    currency: String,
    #[serde(rename = "ref")]
    reference: String,
}

#[derive(Debug, Serialize)]
struct TransferResponse {
    transfer_id: String,
    status: String,
}

#[derive(Debug, Serialize)]
struct AccountBalance {
    account_id: String,
    debits_posted: u64,
    credits_posted: u64,
    debits_pending: u64,
    credits_pending: u64,
    balance: i64,
    currency: String,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    service: String,
    tigerbeetle_url: String,
    tigerbeetle_reachable: bool,
    latency_ms: u64,
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/// POST /ledger/reserve — Create a pending two-phase transfer
async fn reserve(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ReserveRequest>,
) -> Result<Json<ReserveResponse>, (StatusCode, Json<serde_json::Value>)> {
    let pending_id = Uuid::new_v4().to_string();
    let amount_units = (req.amount * 100.0) as u64; // Convert to smallest currency unit

    let tb_payload = serde_json::json!({
        "id": pending_id,
        "debit_account_id": req.account_id,
        "credit_account_id": "system-escrow",
        "amount": amount_units,
        "currency": req.currency,
        "flags": { "pending": true, "linked": false },
        "user_data": req.reference,
    });

    match state
        .client
        .post(format!("{}/transfers", state.tigerbeetle_url))
        .json(&tb_payload)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            info!("ledger.reserve ok pending_id={} amount={} currency={}", pending_id, req.amount, req.currency);
            Ok(Json(ReserveResponse {
                pending_id,
                status: "pending".to_string(),
            }))
        }
        Ok(resp) => {
            let status = resp.status().as_u16();
            warn!("ledger.reserve tb_error status={}", status);
            // Return a synthetic pending_id so the payment can continue
            // (TigerBeetle is best-effort in this integration)
            Ok(Json(ReserveResponse {
                pending_id,
                status: format!("tb_error_{}", status),
            }))
        }
        Err(e) => {
            warn!("ledger.reserve unreachable: {}", e);
            Ok(Json(ReserveResponse {
                pending_id,
                status: "tb_unreachable".to_string(),
            }))
        }
    }
}

/// POST /ledger/commit — Post a pending transfer
async fn commit(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CommitRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let tb_payload = serde_json::json!({
        "pending_id": req.pending_id,
        "flags": { "post_pending_transfer": true },
    });

    match state
        .client
        .post(format!("{}/transfers", state.tigerbeetle_url))
        .json(&tb_payload)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            info!("ledger.commit ok pending_id={}", req.pending_id);
            Ok(Json(serde_json::json!({"status": "committed", "pending_id": req.pending_id})))
        }
        Ok(resp) => {
            warn!("ledger.commit tb_error status={}", resp.status());
            Ok(Json(serde_json::json!({"status": "tb_error", "pending_id": req.pending_id})))
        }
        Err(e) => {
            warn!("ledger.commit unreachable: {}", e);
            Ok(Json(serde_json::json!({"status": "tb_unreachable", "pending_id": req.pending_id})))
        }
    }
}

/// POST /ledger/void — Void a pending transfer
async fn void_transfer(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VoidRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let tb_payload = serde_json::json!({
        "pending_id": req.pending_id,
        "flags": { "void_pending_transfer": true },
    });

    match state
        .client
        .post(format!("{}/transfers", state.tigerbeetle_url))
        .json(&tb_payload)
        .send()
        .await
    {
        Ok(_) => {
            info!("ledger.void ok pending_id={}", req.pending_id);
            Ok(Json(serde_json::json!({"status": "voided", "pending_id": req.pending_id})))
        }
        Err(e) => {
            warn!("ledger.void unreachable: {}", e);
            Ok(Json(serde_json::json!({"status": "tb_unreachable", "pending_id": req.pending_id})))
        }
    }
}

/// POST /ledger/transfer — Single-phase transfer
async fn transfer(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TransferRequest>,
) -> Result<Json<TransferResponse>, (StatusCode, Json<serde_json::Value>)> {
    let transfer_id = Uuid::new_v4().to_string();
    let amount_units = (req.amount * 100.0) as u64;

    let tb_payload = serde_json::json!({
        "id": transfer_id,
        "debit_account_id": req.debit_account_id,
        "credit_account_id": req.credit_account_id,
        "amount": amount_units,
        "currency": req.currency,
        "flags": { "pending": false },
        "user_data": req.reference,
    });

    match state
        .client
        .post(format!("{}/transfers", state.tigerbeetle_url))
        .json(&tb_payload)
        .send()
        .await
    {
        Ok(_) => Ok(Json(TransferResponse {
            transfer_id,
            status: "posted".to_string(),
        })),
        Err(e) => {
            error!("ledger.transfer failed: {}", e);
            Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "ledger_unavailable"})),
            ))
        }
    }
}

/// GET /ledger/account/:id — Get account balance
async fn account_balance(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
) -> Result<Json<AccountBalance>, (StatusCode, Json<serde_json::Value>)> {
    match state
        .client
        .get(format!("{}/accounts/{}", state.tigerbeetle_url, account_id))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let data: serde_json::Value = resp.json().await.unwrap_or_default();
            Ok(Json(AccountBalance {
                account_id: account_id.clone(),
                debits_posted: data["debits_posted"].as_u64().unwrap_or(0),
                credits_posted: data["credits_posted"].as_u64().unwrap_or(0),
                debits_pending: data["debits_pending"].as_u64().unwrap_or(0),
                credits_pending: data["credits_pending"].as_u64().unwrap_or(0),
                balance: data["balance"].as_i64().unwrap_or(0),
                currency: data["currency"].as_str().unwrap_or("USD").to_string(),
            }))
        }
        _ => Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "account_not_found"})),
        )),
    }
}

/// GET /health
async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let start = std::time::Instant::now();
    let reachable = state
        .client
        .get(format!("{}/health", state.tigerbeetle_url))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    let latency_ms = start.elapsed().as_millis() as u64;

    Json(HealthResponse {
        status: if reachable { "ok".to_string() } else { "degraded".to_string() },
        service: "ledger-bridge".to_string(),
        tigerbeetle_url: state.tigerbeetle_url.clone(),
        tigerbeetle_reachable: reachable,
        latency_ms,
    })
}

// ─── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("ledger_bridge=info".parse()?),
        )
        .json()
        .init();

    let tigerbeetle_url = env::var("TIGERBEETLE_URL")
        .unwrap_or_else(|_| "http://tigerbeetle-proxy:3002".to_string());
    let port = env::var("PORT").unwrap_or_else(|_| "8095".to_string());

    info!("ledger-bridge starting port={} tigerbeetle={}", port, tigerbeetle_url);

    let state = Arc::new(AppState {
        tigerbeetle_url,
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()?,
    });

    let app = Router::new()
        .route("/ledger/reserve", post(reserve))
        .route("/ledger/commit", post(commit))
        .route("/ledger/void", post(void_transfer))
        .route("/ledger/transfer", post(transfer))
        .route("/ledger/account/:id", get(account_balance))
        .route("/health", get(health))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    info!("ledger-bridge listening on :{}", port);
    axum::serve(listener, app).await?;
    Ok(())
}
