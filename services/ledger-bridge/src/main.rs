//! ledger-bridge (services/) — DEPRECATED compatibility shim.
//!
//! The CANONICAL ledger bridge is `rust/ledger-bridge`. This service is a thin
//! proxy that forwards every endpoint to the canonical bridge so existing
//! deployments that point at this binary keep working while clients migrate.
//!
//! It exposes the SAME canonical contract:
//!   POST /transfer            — {debit_account_id, credit_account_id, amount
//!                                (integer minor units), ledger, code,
//!                                idempotency_key?} → forwarded as-is
//!   POST /ledger/reserve      — forwarded as-is
//!   POST /ledger/commit       — forwarded as-is
//!   POST /ledger/void         — forwarded as-is
//!   POST /ledger/reverse      — forwarded as-is
//!   POST /ledger/transfer     — legacy single-phase schema; translated to the
//!                               canonical /transfer contract before forwarding
//!   GET  /ledger/account/:id  — proxied to canonical GET /balance/:id
//!   GET  /health              — shim health + canonical bridge reachability
//!
//! Set CANONICAL_LEDGER_BRIDGE_URL (default http://ledger-bridge:8095) to the
//! address of the canonical rust/ledger-bridge deployment.

use anyhow::Result;
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use std::{env, sync::Arc};
use tracing::{info, warn};

// ─── Config / state ───────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    canonical_url: String,
    client: reqwest::Client,
}

// ─── Legacy request type ──────────────────────────────────────────────────────

/// Legacy single-phase transfer schema (major units, currency, ref).
/// Translated onto the canonical /transfer contract: amount becomes integer
/// minor units (explicit round-half-up) and the transfer becomes a two-phase
/// pending transfer under the canonical bridge's reserve semantics.
#[derive(Debug, Deserialize)]
struct LegacyTransferRequest {
    debit_account_id: String,
    credit_account_id: String,
    amount: f64,
    /// Accepted for backwards compatibility; the canonical bridge resolves
    /// currency from the ledger id.
    #[serde(default)]
    #[allow(dead_code)]
    currency: String,
    #[serde(rename = "ref")]
    reference: String,
}

// ─── Proxy helpers ────────────────────────────────────────────────────────────

/// Forward a JSON body to the canonical bridge and surface its status/body
/// verbatim. Network failures are 503 — never a fabricated success.
async fn proxy_post(state: &AppState, path: &str, body: serde_json::Value) -> (StatusCode, Json<serde_json::Value>) {
    let url = format!("{}{}", state.canonical_url, path);
    match state.client.post(&url).json(&body).send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let body = resp.json::<serde_json::Value>().await.unwrap_or_else(|_| {
                serde_json::json!({ "error": "unparseable_canonical_response" })
            });
            (status, Json(body))
        }
        Err(e) => {
            warn!("canonical ledger bridge unreachable for {}: {}", path, e);
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "ledger_unavailable",
                    "message": "canonical ledger bridge is unreachable",
                    "detail": e.to_string(),
                })),
            )
        }
    }
}

async fn proxy_get(state: &AppState, path: &str) -> (StatusCode, Json<serde_json::Value>) {
    let url = format!("{}{}", state.canonical_url, path);
    match state.client.get(&url).send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let body = resp.json::<serde_json::Value>().await.unwrap_or_else(|_| {
                serde_json::json!({ "error": "unparseable_canonical_response" })
            });
            (status, Json(body))
        }
        Err(e) => {
            warn!("canonical ledger bridge unreachable for {}: {}", path, e);
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "ledger_unavailable",
                    "message": "canonical ledger bridge is unreachable",
                    "detail": e.to_string(),
                })),
            )
        }
    }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/// POST /transfer — canonical contract, forwarded verbatim.
async fn transfer(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
    let json: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid_json", "detail": e.to_string() })),
            )
        }
    };
    proxy_post(&state, "/transfer", json).await
}

async fn reserve(State(state): State<Arc<AppState>>, body: Bytes) -> (StatusCode, Json<serde_json::Value>) {
    match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(v) => proxy_post(&state, "/ledger/reserve", v).await,
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "invalid_json", "detail": e.to_string() }))),
    }
}

async fn commit(State(state): State<Arc<AppState>>, body: Bytes) -> (StatusCode, Json<serde_json::Value>) {
    match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(v) => proxy_post(&state, "/ledger/commit", v).await,
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "invalid_json", "detail": e.to_string() }))),
    }
}

async fn void_transfer(State(state): State<Arc<AppState>>, body: Bytes) -> (StatusCode, Json<serde_json::Value>) {
    match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(v) => proxy_post(&state, "/ledger/void", v).await,
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "invalid_json", "detail": e.to_string() }))),
    }
}

async fn reverse(State(state): State<Arc<AppState>>, body: Bytes) -> (StatusCode, Json<serde_json::Value>) {
    match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(v) => proxy_post(&state, "/ledger/reverse", v).await,
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "invalid_json", "detail": e.to_string() }))),
    }
}

/// POST /ledger/transfer — legacy schema, translated to canonical /transfer.
async fn legacy_transfer(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LegacyTransferRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    if !req.amount.is_finite() || req.amount <= 0.0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_amount",
                "message": "amount must be a positive finite number",
            })),
        );
    }
    // Major units → integer minor units, explicit round-half-up.
    let amount_minor = (req.amount * 100.0).round();
    if amount_minor <= 0.0 || amount_minor >= u64::MAX as f64 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid_amount", "message": "amount out of range" })),
        );
    }
    let canonical = serde_json::json!({
        "debit_account_id": req.debit_account_id,
        "credit_account_id": req.credit_account_id,
        "amount": amount_minor as u64,
        "ledger": 1,
        "code": 1,
        "idempotency_key": if req.reference.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(req.reference) },
    });
    proxy_post(&state, "/transfer", canonical).await
}

/// GET /ledger/account/:id — proxied to canonical GET /balance/:id.
async fn account_balance(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    proxy_get(&state, &format!("/balance/{}", account_id)).await
}

/// GET /health — shim health plus canonical bridge reachability.
async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let start = std::time::Instant::now();
    let reachable = state
        .client
        .get(format!("{}/health", state.canonical_url))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    Json(serde_json::json!({
        "status": if reachable { "ok" } else { "degraded" },
        "service": "ledger-bridge-shim",
        "deprecated": true,
        "canonical_bridge_url": state.canonical_url,
        "canonical_reachable": reachable,
        "latency_ms": start.elapsed().as_millis() as u64,
    }))
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

    let canonical_url = env::var("CANONICAL_LEDGER_BRIDGE_URL")
        .or_else(|_| env::var("LEDGER_BRIDGE_URL"))
        .unwrap_or_else(|_| "http://ledger-bridge:8095".to_string());
    let port = env::var("PORT").unwrap_or_else(|_| "8095".to_string());

    warn!("services/ledger-bridge is DEPRECATED — proxying to canonical bridge at {}", canonical_url);
    info!("ledger-bridge shim starting port={} canonical={}", port, canonical_url);

    let state = Arc::new(AppState {
        canonical_url,
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()?,
    });

    let app = Router::new()
        .route("/transfer", post(transfer))
        .route("/ledger/reserve", post(reserve))
        .route("/ledger/commit", post(commit))
        .route("/ledger/void", post(void_transfer))
        .route("/ledger/reverse", post(reverse))
        .route("/ledger/transfer", post(legacy_transfer))
        .route("/ledger/account/:id", get(account_balance))
        .route("/health", get(health))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    info!("ledger-bridge shim listening on :{}", port);
    axum::serve(listener, app).await?;
    Ok(())
}
