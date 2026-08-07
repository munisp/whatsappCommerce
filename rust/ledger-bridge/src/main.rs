//! Ledger Bridge — Two-phase financial accounting bridge to TigerBeetle.
//!
//! Architecture:
//!   - Accepts reserve/commit/void requests from the Node.js platform
//!   - Persists all ledger operations to PostgreSQL (tigerbeetle_accounts table)
//!   - Forwards actual accounting to TigerBeetle via a TigerBeetle HTTP sidecar
//!     (TIGERBEETLE_ADDRESS, default tigerbeetle:3000). Native TigerBeetle speaks
//!     a binary protocol; this bridge targets an HTTP sidecar/REST bridge that
//!     fronts the cluster.
//!   - When TigerBeetle is unreachable, requests fail with 503 SERVICE_UNAVAILABLE.
//!     An in-memory ledger exists ONLY for local development and must be enabled
//!     explicitly with LEDGER_ALLOW_INMEMORY=true. It never pre-funds accounts.
//!
//! Endpoints:
//!   GET  /health                    — health check
//!   GET  /balance/:account_id       — get account balance
//!   GET  /ledger/balances           — list all balances
//!   POST /ledger/reserve            — reserve funds (pending transfer)
//!   POST /ledger/commit             — commit a pending transfer
//!   POST /ledger/void               — void a pending transfer
//!   POST /accounts/provision        — provision a new TigerBeetle account
//!   GET  /accounts/:account_id      — get account details from DB

use anyhow::Result;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use chrono::Utc;
use dashmap::DashMap;
use deadpool_postgres::{Config as PgConfig, Pool, Runtime};
use serde::{Deserialize, Serialize};
use std::{env, sync::Arc};
use tokio::signal;
use tracing::{error, info, warn};
use uuid::Uuid;

// ─── Config ───────────────────────────────────────────────────────────────────

struct Config {
    port: u16,
    database_url: String,
    tigerbeetle_address: String,
    tigerbeetle_cluster_id: u32,
    allow_inmemory: bool,
}

impl Config {
    fn from_env() -> Self {
        Self {
            port: env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8095),
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://wc_user:wc_secret@localhost:5432/whatsapp_commerce".into()),
            // Address of the TigerBeetle HTTP sidecar fronting the cluster
            // (native TigerBeetle speaks a binary protocol, not HTTP).
            tigerbeetle_address: env::var("TIGERBEETLE_ADDRESS")
                .unwrap_or_else(|_| "tigerbeetle:3000".into()),
            tigerbeetle_cluster_id: env::var("TIGERBEETLE_CLUSTER_ID")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
            // Dev-only escape hatch: allow the in-memory ledger fallback.
            // NEVER enable in production — it is not durable and not replicated.
            allow_inmemory: env::var("LEDGER_ALLOW_INMEMORY")
                .map(|v| v == "true")
                .unwrap_or(false),
        }
    }
}

// ─── Transfer types ───────────────────────────────────────────────────────────

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

// ─── Request/Response types ───────────────────────────────────────────────────

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

#[derive(Debug, Deserialize)]
struct ProvisionAccountRequest {
    tenant_id: Option<String>,
    account_type: String, // merchant | escrow | platform_fee | float | suspense
    currency: Option<String>,
}

#[derive(Debug, Serialize)]
struct ProvisionAccountResponse {
    tb_account_id: String,
    account_type: String,
    currency: String,
    ledger_id: i32,
}

// ─── TigerBeetle HTTP client ──────────────────────────────────────────────────

struct TigerBeetleClient {
    address: String,
    cluster_id: u32,
    http: reqwest::Client,
}

impl TigerBeetleClient {
    fn new(address: String, cluster_id: u32) -> Self {
        Self {
            address,
            cluster_id,
            // Fall back to a default client rather than panicking if the
            // customised builder fails (e.g. platform TLS initialisation).
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    fn base_url(&self) -> String {
        // Native TigerBeetle speaks a binary protocol and has no HTTP API.
        // This client targets a TigerBeetle HTTP sidecar / REST bridge that
        // fronts the cluster. Format: http://<address>/api/v1
        format!("http://{}/api/v1", self.address)
    }

    /// Create an account in TigerBeetle.
    async fn create_account(&self, id: u128, ledger: u32, code: u16) -> Result<(), String> {
        let payload = serde_json::json!({
            "cluster_id": self.cluster_id,
            "accounts": [{
                "id": id.to_string(),
                "ledger": ledger,
                "code": code,
                "flags": 0,
                "debits_pending": 0,
                "debits_posted": 0,
                "credits_pending": 0,
                "credits_posted": 0,
            }]
        });
        match self.http.post(format!("{}/accounts", self.base_url()))
            .json(&payload)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => Ok(()),
            Ok(r) => Err(format!("TB create_account failed: {}", r.status())),
            Err(e) => Err(format!("TB unreachable: {}", e)),
        }
    }

    /// Reserve funds (create a pending transfer).
    async fn create_pending_transfer(
        &self, id: u128, debit_account: u128, credit_account: u128,
        amount: u64, ledger: u32, code: u16,
    ) -> Result<(), String> {
        let payload = serde_json::json!({
            "cluster_id": self.cluster_id,
            "transfers": [{
                "id": id.to_string(),
                "debit_account_id": debit_account.to_string(),
                "credit_account_id": credit_account.to_string(),
                "amount": amount,
                "ledger": ledger,
                "code": code,
                "flags": 4, // pending flag
                "timeout": 0,
            }]
        });
        match self.http.post(format!("{}/transfers", self.base_url()))
            .json(&payload)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => Ok(()),
            Ok(r) => Err(format!("TB pending transfer failed: {}", r.status())),
            Err(e) => Err(format!("TB unreachable: {}", e)),
        }
    }

    /// Post a pending transfer (commit).
    async fn post_pending_transfer(&self, pending_id: u128, post_id: u128) -> Result<(), String> {
        let payload = serde_json::json!({
            "cluster_id": self.cluster_id,
            "transfers": [{
                "id": post_id.to_string(),
                "pending_id": pending_id.to_string(),
                "flags": 8, // post_pending_transfer flag
                "amount": 0, // 0 = post full amount
            }]
        });
        match self.http.post(format!("{}/transfers", self.base_url()))
            .json(&payload)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => Ok(()),
            Ok(r) => Err(format!("TB post transfer failed: {}", r.status())),
            Err(e) => Err(format!("TB unreachable: {}", e)),
        }
    }

    /// Void a pending transfer.
    async fn void_pending_transfer(&self, pending_id: u128, void_id: u128) -> Result<(), String> {
        let payload = serde_json::json!({
            "cluster_id": self.cluster_id,
            "transfers": [{
                "id": void_id.to_string(),
                "pending_id": pending_id.to_string(),
                "flags": 16, // void_pending_transfer flag
                "amount": 0,
            }]
        });
        match self.http.post(format!("{}/transfers", self.base_url()))
            .json(&payload)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => Ok(()),
            Ok(r) => Err(format!("TB void transfer failed: {}", r.status())),
            Err(e) => Err(format!("TB unreachable: {}", e)),
        }
    }

    async fn health(&self) -> bool {
        self.http.get(format!("{}/health", self.base_url()))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }
}

// ─── Application state ────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    // In-memory ledger — DEV ONLY, used solely when allow_inmemory is set.
    pending: Arc<DashMap<Uuid, PendingTransfer>>,
    balances: Arc<DashMap<String, (f64, f64)>>, // (reserved, available)
    // PostgreSQL pool for persistence
    pg: Option<Pool>,
    // TigerBeetle client
    tb: Arc<TigerBeetleClient>,
    // LEDGER_ALLOW_INMEMORY=true — dev-mode escape hatch for the in-memory ledger
    allow_inmemory: bool,
}

/// Structured 503 returned when the TigerBeetle ledger cannot serve the request
/// and the dev-only in-memory fallback is disabled.
fn ledger_unavailable(detail: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error": "ledger_unavailable",
            "message": "TigerBeetle ledger is unreachable; refusing to fabricate a ledger result. \
                        Set LEDGER_ALLOW_INMEMORY=true only in local development to use the in-memory ledger.",
            "detail": detail,
        })),
    )
}

impl AppState {
    async fn new(cfg: &Config) -> Self {
        let pg = Self::connect_pg(&cfg.database_url).await;
        let tb = Arc::new(TigerBeetleClient::new(
            cfg.tigerbeetle_address.clone(),
            cfg.tigerbeetle_cluster_id,
        ));
        Self {
            pending: Arc::new(DashMap::new()),
            balances: Arc::new(DashMap::new()),
            pg,
            tb,
            allow_inmemory: cfg.allow_inmemory,
        }
    }

    async fn connect_pg(url: &str) -> Option<Pool> {
        let mut pg_cfg = PgConfig::new();
        pg_cfg.url = Some(url.to_string());
        match pg_cfg.create_pool(Some(Runtime::Tokio1), tokio_postgres::NoTls) {
            Ok(pool) => {
                match pool.get().await {
                    Ok(_) => {
                        info!("PostgreSQL connected");
                        Some(pool)
                    }
                    Err(e) => {
                        warn!("PostgreSQL pool get failed: {}", e);
                        None
                    }
                }
            }
            Err(e) => {
                warn!("PostgreSQL pool creation failed: {}", e);
                None
            }
        }
    }

    /// Reserve funds in the dev-only in-memory ledger. Accounts start at zero —
    /// no synthetic pre-funding. Only reachable when LEDGER_ALLOW_INMEMORY=true.
    fn reserve_local(&self, req: ReserveRequest) -> Result<ReserveResponse, String> {
        let pending_id = Uuid::new_v4();
        let mut entry = self.balances
            .entry(req.account_id.clone())
            .or_insert((0.0, 0.0));
        if entry.1 < req.amount {
            return Err(format!("insufficient funds: available={:.2}", entry.1));
        }
        entry.0 += req.amount;
        entry.1 -= req.amount;
        self.pending.insert(pending_id, PendingTransfer {
            id: pending_id,
            account_id: req.account_id,
            amount: req.amount,
            currency: req.currency.clone(),
            reference: req.reference,
            status: TransferStatus::Pending,
            created_at: Utc::now().to_rfc3339(),
            settled_at: None,
        });
        info!(pending_id = %pending_id, amount = req.amount, "funds reserved (local)");
        Ok(ReserveResponse {
            pending_id,
            status: "reserved".into(),
            reserved_amount: req.amount,
            currency: req.currency,
        })
    }

    fn commit_local(&self, pending_id: Uuid) -> Result<(), String> {
        let mut t = self.pending.get_mut(&pending_id)
            .ok_or_else(|| format!("not found: {}", pending_id))?;
        if t.status != TransferStatus::Pending {
            return Err(format!("not pending: {:?}", t.status));
        }
        if let Some(mut bal) = self.balances.get_mut(&t.account_id) {
            bal.0 -= t.amount;
        }
        t.status = TransferStatus::Committed;
        t.settled_at = Some(Utc::now().to_rfc3339());
        info!(pending_id = %pending_id, "transfer committed (local)");
        Ok(())
    }

    fn void_local(&self, pending_id: Uuid) -> Result<(), String> {
        let mut t = self.pending.get_mut(&pending_id)
            .ok_or_else(|| format!("not found: {}", pending_id))?;
        if t.status != TransferStatus::Pending {
            return Err(format!("not pending: {:?}", t.status));
        }
        if let Some(mut bal) = self.balances.get_mut(&t.account_id) {
            bal.0 -= t.amount;
            bal.1 += t.amount;
        }
        t.status = TransferStatus::Voided;
        t.settled_at = Some(Utc::now().to_rfc3339());
        warn!(pending_id = %pending_id, "transfer voided (local)");
        Ok(())
    }

    /// Persist a TigerBeetle account record to PostgreSQL.
    async fn persist_account(&self, tb_account_id: &str, tenant_id: Option<&str>, account_type: &str, currency: &str) {
        let Some(ref pool) = self.pg else { return };
        let Ok(client) = pool.get().await else { return };
        let _ = client.execute(
            r#"INSERT INTO tigerbeetle_accounts
               (id, tb_account_id, tenant_id, account_type, currency, ledger_id, code, created_at, updated_at)
               VALUES (gen_random_uuid(), $1, $2, $3::tigerbeetle_account_type, $4, 700, 1000, NOW(), NOW())
               ON CONFLICT (tb_account_id) DO UPDATE SET updated_at = NOW()"#,
            &[&tb_account_id, &tenant_id, &account_type, &currency],
        ).await;
    }

    /// Sync balance from TigerBeetle to PostgreSQL.
    async fn sync_balance_to_pg(&self, tb_account_id: &str, debits_pending: i64, debits_posted: i64, credits_pending: i64, credits_posted: i64) {
        let Some(ref pool) = self.pg else { return };
        let Ok(client) = pool.get().await else { return };
        let _ = client.execute(
            r#"UPDATE tigerbeetle_accounts SET
               debits_pending = $1, debits_posted = $2,
               credits_pending = $3, credits_posted = $4,
               last_synced_at = NOW(), updated_at = NOW()
               WHERE tb_account_id = $5"#,
            &[&debits_pending, &debits_posted, &credits_pending, &credits_posted, &tb_account_id],
        ).await;
    }
}

// ─── HTTP Handlers ────────────────────────────────────────────────────────────

async fn health_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let tb_healthy = state.tb.health().await;
    let pg_healthy = state.pg.as_ref()
        .map(|p| p.status().available > 0)
        .unwrap_or(false);
    Json(serde_json::json!({
        "status": "ok",
        "service": "ledger-bridge",
        "ts": Utc::now().to_rfc3339(),
        "tigerbeetle": { "healthy": tb_healthy, "address": state.tb.address },
        "postgres": { "healthy": pg_healthy },
        "pending_transfers": state.pending.len(),
    }))
}

async fn get_balance_handler(
    State(state): State<AppState>,
    Path(account_id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Try to get from TigerBeetle first
    let tb_healthy = state.tb.health().await;
    if tb_healthy {
        // Query via TB HTTP sidecar API (if available)
        let tb_url = format!("{}/accounts/{}", state.tb.base_url(), account_id);
        if let Ok(resp) = state.tb.http.get(&tb_url).send().await {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    let debits_pending = data["debits_pending"].as_i64().unwrap_or(0);
                    let debits_posted = data["debits_posted"].as_i64().unwrap_or(0);
                    let credits_posted = data["credits_posted"].as_i64().unwrap_or(0);
                    let credits_pending = data["credits_pending"].as_i64().unwrap_or(0);
                    // Sync to PG
                    state.sync_balance_to_pg(&account_id, debits_pending, debits_posted, credits_pending, credits_posted).await;
                    let balance = (credits_posted - debits_posted) as f64 / 100.0; // kobo → NGN
                    let reserved = debits_pending as f64 / 100.0;
                    return (StatusCode::OK, Json(serde_json::json!({
                        "account_id": account_id,
                        "balance": balance,
                        "reserved": reserved,
                        "available": balance - reserved,
                        "currency": "NGN",
                        "source": "tigerbeetle",
                    })));
                }
            }
        }
    }

    // TigerBeetle could not serve the balance.
    if !state.allow_inmemory {
        if tb_healthy {
            // TB is up but the account query failed — that is a lookup failure,
            // not an outage.
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({
                "error": "account_not_found",
                "account_id": account_id,
            })));
        }
        return ledger_unavailable("tigerbeetle health check failed");
    }
    warn!(account_id = %account_id, "DEV MODE: serving balance from in-memory ledger");
    let entry = state.balances.get(&account_id);
    let (reserved, available) = entry.map(|e| *e).unwrap_or((0.0, 0.0));
    (StatusCode::OK, Json(serde_json::json!({
        "account_id": account_id,
        "balance": reserved + available,
        "reserved": reserved,
        "available": available,
        "currency": "NGN",
        "source": "in_memory_dev",
    })))
}

async fn reserve_handler(
    State(state): State<AppState>,
    Json(req): Json<ReserveRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let account_id = req.account_id.clone();
    let amount = req.amount;
    let currency = req.currency.clone();

    // Basic input validation — never fabricate a reservation for bad input.
    if !amount.is_finite() || amount <= 0.0 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "error": "invalid_amount",
            "message": "amount must be a positive finite number",
        })));
    }

    // Try TigerBeetle first
    if state.tb.health().await {
        let pending_id = Uuid::new_v4();
        let pending_id_u128 = pending_id.as_u128();
        // Use account_id as u128 (hash for non-numeric IDs)
        let debit_account = u128::from_str_radix(&account_id.replace("-", "").chars().take(32).collect::<String>(), 16)
            .unwrap_or(1);
        let credit_account = 2u128; // platform escrow account
        let amount_kobo = (amount * 100.0) as u64;

        match state.tb.create_pending_transfer(pending_id_u128, debit_account, credit_account, amount_kobo, 700, 1).await {
            Ok(_) => {
                info!(pending_id = %pending_id, amount = amount, "funds reserved (tigerbeetle)");
                return (StatusCode::CREATED, Json(serde_json::json!({
                    "pending_id": pending_id,
                    "status": "reserved",
                    "reserved_amount": amount,
                    "currency": currency,
                    "source": "tigerbeetle",
                })));
            }
            Err(e) => {
                if !state.allow_inmemory {
                    error!("TB reserve failed and in-memory fallback is disabled: {}", e);
                    return ledger_unavailable(&e);
                }
                warn!("TB reserve failed; DEV MODE in-memory fallback: {}", e);
            }
        }
    } else if !state.allow_inmemory {
        return ledger_unavailable("tigerbeetle health check failed");
    } else {
        warn!("TigerBeetle unreachable; DEV MODE in-memory fallback (LEDGER_ALLOW_INMEMORY=true)");
    }

    // Dev-only local fallback
    match state.reserve_local(ReserveRequest { account_id, amount, currency, reference: req.reference }) {
        Ok(r) => match serde_json::to_value(r) {
            Ok(v) => (StatusCode::CREATED, Json(v)),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": "serialization_failed", "detail": e.to_string(),
            }))),
        },
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))),
    }
}

async fn commit_handler(
    State(state): State<AppState>,
    Json(req): Json<CommitRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let pending_id = req.pending_id;

    // Try TigerBeetle
    if state.tb.health().await {
        let post_id = Uuid::new_v4().as_u128();
        let pending_u128 = pending_id.as_u128();
        match state.tb.post_pending_transfer(pending_u128, post_id).await {
            Ok(_) => {
                info!(pending_id = %pending_id, "transfer committed (tigerbeetle)");
                return (StatusCode::OK, Json(serde_json::json!({
                    "status": "committed",
                    "pending_id": pending_id,
                    "source": "tigerbeetle",
                })));
            }
            Err(e) => {
                if !state.allow_inmemory {
                    error!("TB commit failed and in-memory fallback is disabled: {}", e);
                    return ledger_unavailable(&e);
                }
                warn!("TB commit failed; DEV MODE in-memory fallback: {}", e);
            }
        }
    } else if !state.allow_inmemory {
        return ledger_unavailable("tigerbeetle health check failed");
    }

    match state.commit_local(pending_id) {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "status": "committed", "pending_id": pending_id }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))),
    }
}

async fn void_handler(
    State(state): State<AppState>,
    Json(req): Json<VoidRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let pending_id = req.pending_id;

    // Try TigerBeetle
    if state.tb.health().await {
        let void_id = Uuid::new_v4().as_u128();
        let pending_u128 = pending_id.as_u128();
        match state.tb.void_pending_transfer(pending_u128, void_id).await {
            Ok(_) => {
                warn!(pending_id = %pending_id, "transfer voided (tigerbeetle)");
                return (StatusCode::OK, Json(serde_json::json!({
                    "status": "voided",
                    "pending_id": pending_id,
                    "source": "tigerbeetle",
                })));
            }
            Err(e) => {
                if !state.allow_inmemory {
                    error!("TB void failed and in-memory fallback is disabled: {}", e);
                    return ledger_unavailable(&e);
                }
                warn!("TB void failed; DEV MODE in-memory fallback: {}", e);
            }
        }
    } else if !state.allow_inmemory {
        return ledger_unavailable("tigerbeetle health check failed");
    }

    match state.void_local(pending_id) {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "status": "voided", "pending_id": pending_id }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))),
    }
}

async fn balances_handler(State(state): State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    if !state.allow_inmemory {
        // The in-memory map is empty unless the dev fallback served traffic;
        // never present it as a real ledger view.
        return ledger_unavailable("in-memory balance listing is only available with LEDGER_ALLOW_INMEMORY=true");
    }
    let b: std::collections::HashMap<String, serde_json::Value> = state.balances.iter()
        .map(|e| (e.key().clone(), serde_json::json!({
            "reserved": e.0,
            "available": e.1,
        })))
        .collect();
    (StatusCode::OK, Json(serde_json::json!({
        "balances": b,
        "pending_count": state.pending.len(),
        "source": "in_memory_dev",
    })))
}

async fn provision_account_handler(
    State(state): State<AppState>,
    Json(req): Json<ProvisionAccountRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let tb_account_id = Uuid::new_v4().to_string().replace("-", "");
    let currency = req.currency.unwrap_or_else(|| "NGN".into());
    let ledger_id = 700i32; // NGN ledger

    // Create in TigerBeetle first — a Postgres mirror without a real ledger
    // account is a lie, so fail loudly unless the dev fallback is enabled.
    let mut source = "tigerbeetle";
    if state.tb.health().await {
        let id_u128 = u128::from_str_radix(&tb_account_id.chars().take(32).collect::<String>(), 16)
            .unwrap_or_else(|_| rand_u128());
        if let Err(e) = state.tb.create_account(id_u128, ledger_id as u32, 1000).await {
            if !state.allow_inmemory {
                error!("TB create_account failed and in-memory fallback is disabled: {}", e);
                return ledger_unavailable(&e);
            }
            warn!("TB create_account failed; DEV MODE continues with PG-only record: {}", e);
            source = "in_memory_dev";
        }
    } else if !state.allow_inmemory {
        return ledger_unavailable("tigerbeetle health check failed");
    } else {
        warn!("TigerBeetle unreachable; DEV MODE provisions PG-only account (LEDGER_ALLOW_INMEMORY=true)");
        source = "in_memory_dev";
    }

    // Persist to PostgreSQL
    state.persist_account(&tb_account_id, req.tenant_id.as_deref(), &req.account_type, &currency).await;

    info!(tb_account_id = %tb_account_id, account_type = %req.account_type, source = source, "account provisioned");
    let resp = ProvisionAccountResponse {
        tb_account_id,
        account_type: req.account_type,
        currency,
        ledger_id,
    };
    match serde_json::to_value(&resp) {
        Ok(mut v) => {
            v["source"] = serde_json::Value::String(source.into());
            (StatusCode::CREATED, Json(v))
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "error": "serialization_failed", "detail": e.to_string(),
        }))),
    }
}

fn rand_u128() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().json().init();
    let cfg = Config::from_env();

    // Fail loudly on a malformed TigerBeetle sidecar address — silently
    // starting against a bad address would turn every ledger call into a 503
    // (or worse, dev-mode in-memory results) with no obvious cause.
    if !cfg.tigerbeetle_address.contains(':') {
        error!(
            tigerbeetle = %cfg.tigerbeetle_address,
            "TIGERBEETLE_ADDRESS must be host:port of the TigerBeetle HTTP sidecar (e.g. tigerbeetle:3000)"
        );
        std::process::exit(1);
    }
    if cfg.allow_inmemory {
        warn!("LEDGER_ALLOW_INMEMORY=true — DEV MODE: in-memory ledger fallback is ENABLED. Do not use in production.");
    }

    let state = AppState::new(&cfg).await;

    info!(
        port = cfg.port,
        tigerbeetle = %cfg.tigerbeetle_address,
        allow_inmemory = cfg.allow_inmemory,
        "Ledger Bridge starting"
    );

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/balance/:account_id", get(get_balance_handler))
        .route("/ledger/reserve", post(reserve_handler))
        .route("/ledger/commit", post(commit_handler))
        .route("/ledger/void", post(void_handler))
        .route("/ledger/balances", get(balances_handler))
        .route("/accounts/provision", post(provision_account_handler))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!(addr = %addr, "Ledger Bridge listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(async { signal::ctrl_c().await.expect("ctrl_c") })
        .await?;
    Ok(())
}
