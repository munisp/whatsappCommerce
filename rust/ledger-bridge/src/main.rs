//! Ledger Bridge — Two-phase financial accounting bridge to TigerBeetle.
//! reserve() → commit() / void() pattern for atomic payment settlement.

use anyhow::Result;
use axum::{extract::State, http::StatusCode, response::Json, routing::{get, post}, Router};
use chrono::Utc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::signal;
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum TransferStatus { Pending, Committed, Voided }

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingTransfer {
    id: Uuid,
    account_id: String,
    amount: f64,
    currency: String,
    reference: String,
    status: TransferStatus,
    created_at: String,
    settled_at: Option<String>,
}

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
    pending_id: Uuid,
    status: String,
    reserved_amount: f64,
    currency: String,
}

#[derive(Debug, Deserialize)]
struct CommitRequest { pending_id: Uuid }

#[derive(Debug, Deserialize)]
struct VoidRequest { pending_id: Uuid }

#[derive(Clone)]
struct LedgerState {
    pending: Arc<DashMap<Uuid, PendingTransfer>>,
    balances: Arc<DashMap<String, (f64, f64)>>,
}

impl LedgerState {
    fn new() -> Self {
        Self { pending: Arc::new(DashMap::new()), balances: Arc::new(DashMap::new()) }
    }

    fn reserve(&self, req: ReserveRequest) -> Result<ReserveResponse, String> {
        let pending_id = Uuid::new_v4();
        let mut entry = self.balances.entry(req.account_id.clone()).or_insert((0.0, 10_000_000.0));
        if entry.1 < req.amount {
            return Err(format!("insufficient funds: available={:.2}", entry.1));
        }
        entry.0 += req.amount;
        entry.1 -= req.amount;
        self.pending.insert(pending_id, PendingTransfer {
            id: pending_id, account_id: req.account_id, amount: req.amount,
            currency: req.currency.clone(), reference: req.reference,
            status: TransferStatus::Pending, created_at: Utc::now().to_rfc3339(), settled_at: None,
        });
        info!(pending_id = %pending_id, amount = req.amount, "funds reserved");
        Ok(ReserveResponse { pending_id, status: "reserved".into(), reserved_amount: req.amount, currency: req.currency })
    }

    fn commit(&self, pending_id: Uuid) -> Result<(), String> {
        let mut t = self.pending.get_mut(&pending_id).ok_or_else(|| format!("not found: {}", pending_id))?;
        if t.status != TransferStatus::Pending { return Err(format!("not pending: {:?}", t.status)); }
        if let Some(mut bal) = self.balances.get_mut(&t.account_id) { bal.0 -= t.amount; }
        t.status = TransferStatus::Committed;
        t.settled_at = Some(Utc::now().to_rfc3339());
        info!(pending_id = %pending_id, "transfer committed");
        Ok(())
    }

    fn void(&self, pending_id: Uuid) -> Result<(), String> {
        let mut t = self.pending.get_mut(&pending_id).ok_or_else(|| format!("not found: {}", pending_id))?;
        if t.status != TransferStatus::Pending { return Err(format!("not pending: {:?}", t.status)); }
        if let Some(mut bal) = self.balances.get_mut(&t.account_id) { bal.0 -= t.amount; bal.1 += t.amount; }
        t.status = TransferStatus::Voided;
        t.settled_at = Some(Utc::now().to_rfc3339());
        warn!(pending_id = %pending_id, "transfer voided");
        Ok(())
    }
}

async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "service": "ledger-bridge", "ts": Utc::now().to_rfc3339() }))
}

async fn reserve_handler(State(s): State<LedgerState>, Json(req): Json<ReserveRequest>) -> (StatusCode, Json<serde_json::Value>) {
    match s.reserve(req) {
        Ok(r) => (StatusCode::CREATED, Json(serde_json::to_value(r).unwrap())),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))),
    }
}

async fn commit_handler(State(s): State<LedgerState>, Json(req): Json<CommitRequest>) -> (StatusCode, Json<serde_json::Value>) {
    match s.commit(req.pending_id) {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "status": "committed", "pending_id": req.pending_id }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))),
    }
}

async fn void_handler(State(s): State<LedgerState>, Json(req): Json<VoidRequest>) -> (StatusCode, Json<serde_json::Value>) {
    match s.void(req.pending_id) {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "status": "voided", "pending_id": req.pending_id }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))),
    }
}

async fn balances_handler(State(s): State<LedgerState>) -> Json<serde_json::Value> {
    let b: std::collections::HashMap<String, serde_json::Value> = s.balances.iter()
        .map(|e| (e.key().clone(), serde_json::json!({ "reserved": e.0, "available": e.1 }))).collect();
    Json(serde_json::json!({ "balances": b, "pending_count": s.pending.len() }))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().json().init();
    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8095);
    let ledger = LedgerState::new();
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/ledger/reserve", post(reserve_handler))
        .route("/ledger/commit", post(commit_handler))
        .route("/ledger/void", post(void_handler))
        .route("/ledger/balances", get(balances_handler))
        .with_state(ledger);
    let addr = format!("0.0.0.0:{}", port);
    info!(addr = %addr, "Ledger Bridge starting");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).with_graceful_shutdown(async { signal::ctrl_c().await.expect("ctrl_c"); }).await?;
    Ok(())
}
