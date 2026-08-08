//! Ledger Bridge — CANONICAL two-phase financial accounting bridge to TigerBeetle.
//!
//! This is the canonical ledger bridge. `services/ledger-bridge` is a thin
//! compatibility shim that proxies to this service.
//!
//! Architecture:
//!   - Accepts reserve/commit/void/transfer/reverse requests from the platform
//!   - Persists transfer records to PostgreSQL (ledger_transfers table, created
//!     automatically at startup) for idempotent replay and reversals
//!   - Forwards actual accounting to TigerBeetle via a TigerBeetle HTTP sidecar
//!     (TIGERBEETLE_ADDRESS, default tigerbeetle:3000). Native TigerBeetle speaks
//!     a binary protocol; this bridge targets an HTTP sidecar/REST bridge that
//!     fronts the cluster.
//!   - When TigerBeetle is unreachable, requests fail with 503 SERVICE_UNAVAILABLE.
//!     An in-memory ledger exists ONLY for local development and must be enabled
//!     explicitly with LEDGER_ALLOW_INMEMORY=true. It never pre-funds accounts.
//!
//! Money handling:
//!   - All ledger amounts are INTEGER MINOR UNITS (e.g. kobo, cents) end-to-end.
//!   - f64 is accepted only at the JSON edge and converted with explicit
//!     round-half-up (f64::round, which rounds half away from zero and therefore
//!     half-up for the positive amounts accepted here). Truncating casts such as
//!     `(amount * 100.0) as u64` are forbidden on this code path.
//!
//! Account handling:
//!   - Account ids must be explicit TigerBeetle account identifiers: a decimal
//!     u128 string, a 32-character hex string, or a canonical UUID. There is NO
//!     silent fallback account — unknown account ids are rejected with 400.
//!
//! Pending transfers:
//!   - Pending (two-phase) transfers are created with a non-zero timeout
//!     (PENDING_TIMEOUT_SECS, default 900s) so TigerBeetle auto-voids orphaned
//!     reservations instead of locking funds forever.
//!
//! Endpoints:
//!   GET  /health                    — health check
//!   GET  /balance/:account_id       — get account balance (integer minor units)
//!   GET  /ledger/balances           — list all balances (dev in-memory only)
//!   POST /transfer                  — canonical 2-phase pending transfer
//!                                     {debit_account_id, credit_account_id,
//!                                      amount (minor units), ledger, code,
//!                                      idempotency_key?} — idempotent on key
//!   POST /ledger/reserve            — reserve funds (pending transfer, major units)
//!   POST /ledger/commit             — commit a pending transfer
//!   POST /ledger/void               — void a pending transfer
//!   POST /ledger/reverse            — compensating reversal of a committed transfer
//!   POST /accounts/provision        — provision a new TigerBeetle account

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
    /// Timeout (seconds) applied to every pending transfer. After this period
    /// TigerBeetle automatically voids the pending transfer, so an abandoned
    /// reservation can never lock funds forever.
    pending_timeout_secs: u32,
    /// Explicit platform escrow account (credit side of /ledger/reserve).
    /// Must be a valid account id (decimal u128 / 32-hex / UUID). Required for
    /// the TigerBeetle path; the dev in-memory ledger does not need it.
    platform_escrow_account: Option<u128>,
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
            pending_timeout_secs: env::var("PENDING_TIMEOUT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(900),
            platform_escrow_account: env::var("PLATFORM_ESCROW_ACCOUNT_ID")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .and_then(|v| match parse_account_id(&v) {
                    Ok(id) => Some(id),
                    Err(e) => {
                        error!("PLATFORM_ESCROW_ACCOUNT_ID is invalid: {}", e);
                        None
                    }
                }),
        }
    }
}

// ─── Money helpers (integer minor units only) ─────────────────────────────────

/// Convert a major-unit amount (e.g. naira) to integer minor units (e.g. kobo)
/// with explicit round-half-up. `f64::round` rounds half away from zero, which
/// is round-half-up for the strictly-positive amounts accepted here.
fn major_to_minor(amount: f64) -> Result<u64, String> {
    if !amount.is_finite() || amount <= 0.0 {
        return Err("amount must be a positive finite number".into());
    }
    let minor = (amount * 100.0).round();
    if minor <= 0.0 || minor >= u64::MAX as f64 {
        return Err("amount out of range for minor-unit conversion".into());
    }
    Ok(minor as u64)
}

/// Validate an amount that is ALREADY in integer minor units (the /transfer
/// contract). Integer-valued floats are accepted at the edge; fractional values
/// are rounded half-up defensively and anything out of range is rejected.
fn minor_units(amount: f64) -> Result<u64, String> {
    if !amount.is_finite() || amount <= 0.0 {
        return Err("amount must be a positive finite number of minor units".into());
    }
    let minor = amount.round();
    if minor <= 0.0 || minor >= u64::MAX as f64 {
        return Err("amount out of range".into());
    }
    Ok(minor as u64)
}

// ─── Account id resolution (no silent fallbacks) ──────────────────────────────

/// Resolve an explicit account identifier to a TigerBeetle u128 account id.
/// Accepted forms: decimal u128 string, 32-character hex string, or canonical
/// UUID. Anything else is rejected — there is NO silent fallback account.
fn parse_account_id(raw: &str) -> Result<u128, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("account id is empty".into());
    }
    if let Ok(v) = s.parse::<u128>() {
        if v > 0 {
            return Ok(v);
        }
    }
    let hex: String = s.chars().filter(|c| *c != '-').collect();
    if hex.len() == 32 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        if let Ok(v) = u128::from_str_radix(&hex, 16) {
            if v > 0 {
                return Ok(v);
            }
        }
    }
    Err(format!(
        "unknown_account: {:?} is not a valid ledger account id (expected decimal u128, 32-hex, or UUID)",
        raw
    ))
}

// ─── Transfer types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum TransferStatus {
    Pending,
    Committed,
    Voided,
    Reversed,
}

impl TransferStatus {
    fn as_str(&self) -> &'static str {
        match self {
            TransferStatus::Pending => "pending",
            TransferStatus::Committed => "committed",
            TransferStatus::Voided => "voided",
            TransferStatus::Reversed => "reversed",
        }
    }
}

/// Dev-only in-memory pending transfer (LEDGER_ALLOW_INMEMORY=true only).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingTransfer {
    id: Uuid,
    account_id: String,
    amount_minor: u64,
    currency: String,
    reference: String,
    status: TransferStatus,
    created_at: String,
    settled_at: Option<String>,
}

/// Durable record of a transfer created through this bridge. Used for
/// idempotent replays and compensating reversals on the TigerBeetle path.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TransferRecord {
    id: Uuid,
    debit_account_id: u128,
    credit_account_id: u128,
    amount_minor: u64,
    ledger: u32,
    code: u16,
    status: TransferStatus,
    idempotency_key: Option<String>,
    reversal_of: Option<Uuid>,
    created_at: String,
    settled_at: Option<String>,
}

// ─── Request/Response types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ReserveRequest {
    account_id: String,
    /// Major-unit amount (e.g. naira); converted to minor units round-half-up.
    amount: f64,
    currency: String,
    #[serde(rename = "ref")]
    reference: String,
    /// Optional explicit credit-side account. Defaults to the configured
    /// PLATFORM_ESCROW_ACCOUNT_ID.
    credit_account_id: Option<String>,
    /// Optional idempotency key — a replay returns the original reservation.
    idempotency_key: Option<String>,
}

#[derive(Debug, Serialize)]
struct ReserveResponse {
    pending_id: Uuid,
    status: String,
    reserved_amount_minor: u64,
    currency: String,
}

/// Canonical transfer contract (matches the TS payment client):
/// POST /transfer {debit_account_id, credit_account_id, amount, ledger, code,
/// idempotency_key}. Creates a TWO-PHASE PENDING transfer (reserve semantics);
/// settle with /ledger/commit or roll back with /ledger/void.
#[derive(Debug, Deserialize)]
struct TransferRequest {
    debit_account_id: String,
    credit_account_id: String,
    /// Amount in INTEGER MINOR UNITS (e.g. kobo/cents).
    amount: f64,
    #[serde(default = "default_ledger")]
    ledger: u32,
    #[serde(default = "default_code")]
    code: u16,
    idempotency_key: Option<String>,
}

fn default_ledger() -> u32 { 1 }
fn default_code() -> u16 { 1 }

#[derive(Debug, Deserialize)]
struct CommitRequest {
    pending_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct VoidRequest {
    pending_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct ReverseRequest {
    pending_id: Uuid,
    reason: Option<String>,
}

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

    /// Reserve funds (create a pending transfer) with an explicit timeout so
    /// orphaned reservations auto-void instead of locking funds forever.
    #[allow(clippy::too_many_arguments)]
    async fn create_pending_transfer(
        &self, id: u128, debit_account: u128, credit_account: u128,
        amount_minor: u64, ledger: u32, code: u16, timeout_secs: u32,
    ) -> Result<(), String> {
        let payload = serde_json::json!({
            "cluster_id": self.cluster_id,
            "transfers": [{
                "id": id.to_string(),
                "debit_account_id": debit_account.to_string(),
                "credit_account_id": credit_account.to_string(),
                "amount": amount_minor,
                "ledger": ledger,
                "code": code,
                "flags": 4, // pending flag
                "timeout": timeout_secs,
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

    /// Single-phase posted transfer (used for compensating reversals).
    async fn create_posted_transfer(
        &self, id: u128, debit_account: u128, credit_account: u128,
        amount_minor: u64, ledger: u32, code: u16,
    ) -> Result<(), String> {
        let payload = serde_json::json!({
            "cluster_id": self.cluster_id,
            "transfers": [{
                "id": id.to_string(),
                "debit_account_id": debit_account.to_string(),
                "credit_account_id": credit_account.to_string(),
                "amount": amount_minor,
                "ledger": ledger,
                "code": code,
                "flags": 0, // posted immediately
                "timeout": 0,
            }]
        });
        match self.http.post(format!("{}/transfers", self.base_url()))
            .json(&payload)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => Ok(()),
            Ok(r) => Err(format!("TB posted transfer failed: {}", r.status())),
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
    // Balances are integer minor units: (reserved_minor, available_minor).
    pending: Arc<DashMap<Uuid, PendingTransfer>>,
    balances: Arc<DashMap<String, (u64, u64)>>,
    // Transfer records for idempotent replay and compensating reversals.
    records: Arc<DashMap<Uuid, TransferRecord>>,
    idem_index: Arc<DashMap<String, Uuid>>,
    // PostgreSQL pool for persistence
    pg: Option<Pool>,
    // TigerBeetle client
    tb: Arc<TigerBeetleClient>,
    // LEDGER_ALLOW_INMEMORY=true — dev-mode escape hatch for the in-memory ledger
    allow_inmemory: bool,
    // Timeout applied to every pending transfer (seconds)
    pending_timeout_secs: u32,
    // Explicit platform escrow account for /ledger/reserve (TigerBeetle path)
    platform_escrow_account: Option<u128>,
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

fn bad_request(code: &str, detail: String) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": code, "detail": detail })))
}

/// Deterministic transfer id derived from an idempotency key, so a retry of
/// the same logical operation targets the same TigerBeetle transfer id.
fn deterministic_id(key: &str) -> Uuid {
    Uuid::new_v5(&Uuid::NAMESPACE_URL, key.as_bytes())
}

impl AppState {
    async fn new(cfg: &Config) -> Self {
        let pg = Self::connect_pg(&cfg.database_url).await;
        let tb = Arc::new(TigerBeetleClient::new(
            cfg.tigerbeetle_address.clone(),
            cfg.tigerbeetle_cluster_id,
        ));
        let state = Self {
            pending: Arc::new(DashMap::new()),
            balances: Arc::new(DashMap::new()),
            records: Arc::new(DashMap::new()),
            idem_index: Arc::new(DashMap::new()),
            pg,
            tb,
            allow_inmemory: cfg.allow_inmemory,
            pending_timeout_secs: cfg.pending_timeout_secs,
            platform_escrow_account: cfg.platform_escrow_account,
        };
        state.ensure_transfer_table().await;
        state
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

    /// Create the transfer-record table if it does not exist. This backs
    /// idempotent replays and compensating reversals across restarts.
    async fn ensure_transfer_table(&self) {
        let Some(ref pool) = self.pg else { return };
        let Ok(client) = pool.get().await else { return };
        if let Err(e) = client.batch_execute(
            r#"CREATE TABLE IF NOT EXISTS ledger_transfers (
                   id UUID PRIMARY KEY,
                   debit_account_id TEXT NOT NULL,
                   credit_account_id TEXT NOT NULL,
                   amount_minor BIGINT NOT NULL,
                   ledger INTEGER NOT NULL,
                   code INTEGER NOT NULL,
                   status TEXT NOT NULL,
                   idempotency_key TEXT UNIQUE,
                   reversal_of UUID,
                   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                   settled_at TIMESTAMPTZ
               )"#,
        ).await {
            warn!("could not ensure ledger_transfers table: {}", e);
        }
    }

    /// Look up a transfer by idempotency key (memory first, then PostgreSQL).
    async fn find_by_idempotency_key(&self, key: &str) -> Option<TransferRecord> {
        if let Some(id) = self.idem_index.get(key) {
            if let Some(rec) = self.records.get(&id) {
                return Some(rec.clone());
            }
        }
        if let Some(ref pool) = self.pg {
            if let Ok(client) = pool.get().await {
                if let Ok(row) = client.query_one(
                    r#"SELECT id, debit_account_id, credit_account_id, amount_minor,
                              ledger, code, status, idempotency_key, reversal_of,
                              created_at::text, settled_at::text
                       FROM ledger_transfers WHERE idempotency_key = $1"#,
                    &[&key],
                ).await {
                    let id: Uuid = row.get(0);
                    let debit: String = row.get(1);
                    let credit: String = row.get(2);
                    let amount_minor: i64 = row.get(3);
                    let ledger: i32 = row.get(4);
                    let code: i32 = row.get(5);
                    let status: String = row.get(6);
                    let reversal_of: Option<Uuid> = row.get(8);
                    let created_at: String = row.get(9);
                    let settled_at: Option<String> = row.get(10);
                    let rec = TransferRecord {
                        id,
                        debit_account_id: debit.parse().unwrap_or(0),
                        credit_account_id: credit.parse().unwrap_or(0),
                        amount_minor: amount_minor as u64,
                        ledger: ledger as u32,
                        code: code as u16,
                        status: match status.as_str() {
                            "committed" => TransferStatus::Committed,
                            "voided" => TransferStatus::Voided,
                            "reversed" => TransferStatus::Reversed,
                            _ => TransferStatus::Pending,
                        },
                        idempotency_key: Some(key.to_string()),
                        reversal_of,
                        created_at,
                        settled_at,
                    };
                    self.records.insert(id, rec.clone());
                    self.idem_index.insert(key.to_string(), id);
                    return Some(rec);
                }
            }
        }
        None
    }

    /// Fetch a transfer record by id (memory first, then PostgreSQL).
    async fn find_record(&self, id: &Uuid) -> Option<TransferRecord> {
        if let Some(rec) = self.records.get(id) {
            return Some(rec.clone());
        }
        if let Some(ref pool) = self.pg {
            if let Ok(client) = pool.get().await {
                if let Ok(row) = client.query_one(
                    r#"SELECT id, debit_account_id, credit_account_id, amount_minor,
                              ledger, code, status, idempotency_key, reversal_of,
                              created_at::text, settled_at::text
                       FROM ledger_transfers WHERE id = $1"#,
                    &[id],
                ).await {
                    let debit: String = row.get(1);
                    let credit: String = row.get(2);
                    let amount_minor: i64 = row.get(3);
                    let ledger: i32 = row.get(4);
                    let code: i32 = row.get(5);
                    let status: String = row.get(6);
                    let rec = TransferRecord {
                        id: row.get(0),
                        debit_account_id: debit.parse().unwrap_or(0),
                        credit_account_id: credit.parse().unwrap_or(0),
                        amount_minor: amount_minor as u64,
                        ledger: ledger as u32,
                        code: code as u16,
                        status: match status.as_str() {
                            "committed" => TransferStatus::Committed,
                            "voided" => TransferStatus::Voided,
                            "reversed" => TransferStatus::Reversed,
                            _ => TransferStatus::Pending,
                        },
                        idempotency_key: row.get(7),
                        reversal_of: row.get(8),
                        created_at: row.get(9),
                        settled_at: row.get(10),
                    };
                    self.records.insert(rec.id, rec.clone());
                    return Some(rec);
                }
            }
        }
        None
    }

    /// Persist (upsert) a transfer record to memory and PostgreSQL.
    async fn save_record(&self, rec: &TransferRecord) {
        self.records.insert(rec.id, rec.clone());
        if let Some(ref key) = rec.idempotency_key {
            self.idem_index.insert(key.clone(), rec.id);
        }
        if let Some(ref pool) = self.pg {
            if let Ok(client) = pool.get().await {
                if let Err(e) = client.execute(
                    r#"INSERT INTO ledger_transfers
                       (id, debit_account_id, credit_account_id, amount_minor, ledger, code,
                        status, idempotency_key, reversal_of, created_at, settled_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NULL)
                       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status,
                           settled_at = CASE WHEN EXCLUDED.status IN ('committed','voided','reversed')
                                             THEN NOW() ELSE ledger_transfers.settled_at END"#,
                    &[
                        &rec.id,
                        &rec.debit_account_id.to_string(),
                        &rec.credit_account_id.to_string(),
                        &(rec.amount_minor as i64),
                        &(rec.ledger as i32),
                        &(rec.code as i32),
                        &rec.status.as_str(),
                        &rec.idempotency_key,
                        &rec.reversal_of,
                    ],
                ).await {
                    warn!("failed to persist ledger transfer {}: {}", rec.id, e);
                }
            }
        }
    }

    /// Update the status of a recorded transfer (memory + PostgreSQL).
    async fn mark_record_status(&self, id: &Uuid, status: TransferStatus) {
        if let Some(mut rec) = self.records.get_mut(id) {
            rec.status = status.clone();
            rec.settled_at = Some(Utc::now().to_rfc3339());
        }
        if let Some(ref pool) = self.pg {
            if let Ok(client) = pool.get().await {
                let _ = client.execute(
                    "UPDATE ledger_transfers SET status = $1, settled_at = NOW() WHERE id = $2",
                    &[&status.as_str(), id],
                ).await;
            }
        }
    }

    /// Reserve funds in the dev-only in-memory ledger. Accounts start at zero —
    /// no synthetic pre-funding. Only reachable when LEDGER_ALLOW_INMEMORY=true.
    fn reserve_local(&self, account_id: &str, amount_minor: u64, currency: &str, reference: &str, pending_id: Uuid) -> Result<ReserveResponse, String> {
        let mut entry = self.balances
            .entry(account_id.to_string())
            .or_insert((0, 0));
        if entry.1 < amount_minor {
            return Err(format!("insufficient funds: available_minor={}", entry.1));
        }
        entry.0 += amount_minor;
        entry.1 -= amount_minor;
        drop(entry);
        self.pending.insert(pending_id, PendingTransfer {
            id: pending_id,
            account_id: account_id.to_string(),
            amount_minor,
            currency: currency.to_string(),
            reference: reference.to_string(),
            status: TransferStatus::Pending,
            created_at: Utc::now().to_rfc3339(),
            settled_at: None,
        });
        info!(pending_id = %pending_id, amount_minor = amount_minor, "funds reserved (local)");
        Ok(ReserveResponse {
            pending_id,
            status: "reserved".into(),
            reserved_amount_minor: amount_minor,
            currency: currency.to_string(),
        })
    }

    fn commit_local(&self, pending_id: Uuid) -> Result<(), String> {
        let mut t = self.pending.get_mut(&pending_id)
            .ok_or_else(|| format!("not found: {}", pending_id))?;
        if t.status != TransferStatus::Pending {
            return Err(format!("not pending: {:?}", t.status));
        }
        if let Some(mut bal) = self.balances.get_mut(&t.account_id) {
            bal.0 = bal.0.saturating_sub(t.amount_minor);
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
            bal.0 = bal.0.saturating_sub(t.amount_minor);
            bal.1 += t.amount_minor;
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
        "pending_timeout_secs": state.pending_timeout_secs,
    }))
}

async fn get_balance_handler(
    State(state): State<AppState>,
    Path(account_id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    // All balances are reported in INTEGER MINOR UNITS.
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
                    let balance_minor = credits_posted - debits_posted;
                    let reserved_minor = debits_pending;
                    return (StatusCode::OK, Json(serde_json::json!({
                        "account_id": account_id,
                        "balance_minor": balance_minor,
                        "reserved_minor": reserved_minor,
                        "available_minor": balance_minor - reserved_minor,
                        "unit": "minor",
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
    let (reserved, available) = entry.map(|e| *e).unwrap_or((0, 0));
    (StatusCode::OK, Json(serde_json::json!({
        "account_id": account_id,
        "balance_minor": reserved + available,
        "reserved_minor": reserved,
        "available_minor": available,
        "unit": "minor",
        "currency": "NGN",
        "source": "in_memory_dev",
    })))
}

/// Shared reserve implementation used by both POST /transfer (canonical,
/// minor units, explicit accounts) and POST /ledger/reserve (legacy,
/// major units, escrow credit side).
#[allow(clippy::too_many_arguments)]
async fn do_reserve(
    state: &AppState,
    debit_account: u128,
    credit_account: u128,
    amount_minor: u64,
    ledger: u32,
    code: u16,
    currency: &str,
    reference: &str,
    idempotency_key: Option<String>,
    local_account_key: &str,
) -> (StatusCode, Json<serde_json::Value>) {
    // Idempotent replay: a previously processed key returns the original
    // reservation instead of creating a duplicate pending transfer.
    if let Some(ref key) = idempotency_key {
        if let Some(existing) = state.find_by_idempotency_key(key).await {
            return (StatusCode::OK, Json(serde_json::json!({
                "pending_id": existing.id,
                "status": existing.status.as_str(),
                "reserved_amount_minor": existing.amount_minor,
                "currency": currency,
                "replayed": true,
            })));
        }
    }

    let pending_id = idempotency_key
        .as_deref()
        .map(deterministic_id)
        .unwrap_or_else(Uuid::new_v4);

    // Try TigerBeetle first
    if state.tb.health().await {
        match state.tb.create_pending_transfer(
            pending_id.as_u128(), debit_account, credit_account,
            amount_minor, ledger, code, state.pending_timeout_secs,
        ).await {
            Ok(_) => {
                state.save_record(&TransferRecord {
                    id: pending_id,
                    debit_account_id: debit_account,
                    credit_account_id: credit_account,
                    amount_minor,
                    ledger,
                    code,
                    status: TransferStatus::Pending,
                    idempotency_key: idempotency_key.clone(),
                    reversal_of: None,
                    created_at: Utc::now().to_rfc3339(),
                    settled_at: None,
                }).await;
                info!(pending_id = %pending_id, amount_minor = amount_minor, "funds reserved (tigerbeetle)");
                return (StatusCode::CREATED, Json(serde_json::json!({
                    "pending_id": pending_id,
                    "status": "reserved",
                    "reserved_amount_minor": amount_minor,
                    "currency": currency,
                    "timeout_secs": state.pending_timeout_secs,
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
    match state.reserve_local(local_account_key, amount_minor, currency, reference, pending_id) {
        Ok(r) => {
            if let Some(key) = idempotency_key {
                state.idem_index.insert(key, pending_id);
            }
            match serde_json::to_value(r) {
                Ok(mut v) => {
                    v["source"] = serde_json::Value::String("in_memory_dev".into());
                    (StatusCode::CREATED, Json(v))
                }
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                    "error": "serialization_failed", "detail": e.to_string(),
                }))),
            }
        }
        Err(e) => bad_request("reserve_failed", e),
    }
}

/// POST /transfer — canonical 2-phase pending transfer (reserve semantics).
/// Amount is in INTEGER MINOR UNITS. Idempotent on idempotency_key.
async fn transfer_handler(
    State(state): State<AppState>,
    Json(req): Json<TransferRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let amount_minor = match minor_units(req.amount) {
        Ok(v) => v,
        Err(e) => return bad_request("invalid_amount", e),
    };
    let debit = match parse_account_id(&req.debit_account_id) {
        Ok(v) => v,
        Err(e) => return bad_request("invalid_debit_account", e),
    };
    let credit = match parse_account_id(&req.credit_account_id) {
        Ok(v) => v,
        Err(e) => return bad_request("invalid_credit_account", e),
    };
    if debit == credit {
        return bad_request("invalid_accounts", "debit and credit accounts must differ".into());
    }
    let idempotency_key = req.idempotency_key.filter(|k| !k.trim().is_empty());
    let reference = idempotency_key.clone().unwrap_or_default();
    do_reserve(
        &state, debit, credit, amount_minor, req.ledger, req.code,
        "NGN", &reference, idempotency_key, &req.debit_account_id,
    ).await
}

async fn reserve_handler(
    State(state): State<AppState>,
    Json(req): Json<ReserveRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let amount_minor = match major_to_minor(req.amount) {
        Ok(v) => v,
        Err(e) => return bad_request("invalid_amount", e),
    };
    let debit = match parse_account_id(&req.account_id) {
        Ok(v) => v,
        Err(e) => return bad_request("invalid_account", e),
    };
    // Credit side: explicit per-request account, else the configured platform
    // escrow account. No hardcoded fallback account.
    let credit = match req.credit_account_id.as_deref() {
        Some(raw) => match parse_account_id(raw) {
            Ok(v) => v,
            Err(e) => return bad_request("invalid_credit_account", e),
        },
        None => match state.platform_escrow_account {
            Some(v) => v,
            None if state.allow_inmemory => 0, // dev in-memory ledger does not use credit side
            None => {
                error!("PLATFORM_ESCROW_ACCOUNT_ID is not configured");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                    "error": "ledger_misconfigured",
                    "message": "PLATFORM_ESCROW_ACCOUNT_ID is not configured; refusing to guess an escrow account",
                })));
            }
        },
    };
    let idempotency_key = req.idempotency_key.filter(|k| !k.trim().is_empty());
    do_reserve(
        &state, debit, credit, amount_minor, 700, 1,
        &req.currency, &req.reference, idempotency_key, &req.account_id,
    ).await
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
                state.mark_record_status(&pending_id, TransferStatus::Committed).await;
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
        Ok(_) => {
            state.mark_record_status(&pending_id, TransferStatus::Committed).await;
            (StatusCode::OK, Json(serde_json::json!({ "status": "committed", "pending_id": pending_id })))
        }
        Err(e) => bad_request("commit_failed", e),
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
                state.mark_record_status(&pending_id, TransferStatus::Voided).await;
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
        Ok(_) => {
            state.mark_record_status(&pending_id, TransferStatus::Voided).await;
            (StatusCode::OK, Json(serde_json::json!({ "status": "voided", "pending_id": pending_id })))
        }
        Err(e) => bad_request("void_failed", e),
    }
}

/// POST /ledger/reverse — compensating transfer that reverses a COMMITTED
/// transfer (used by refunds). Idempotent: reversing the same pending_id twice
/// returns the original reversal.
async fn reverse_handler(
    State(state): State<AppState>,
    Json(req): Json<ReverseRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let pending_id = req.pending_id;
    let reason = req.reason.unwrap_or_else(|| "refund".into());
    info!(pending_id = %pending_id, reason = %reason, "reversal requested");
    let reverse_key = format!("reverse:{}", pending_id);

    // Idempotent replay of a previous reversal.
    if let Some(existing) = state.find_by_idempotency_key(&reverse_key).await {
        return (StatusCode::OK, Json(serde_json::json!({
            "status": "reversed",
            "pending_id": pending_id,
            "reversal_id": existing.id,
            "replayed": true,
        })));
    }

    // Dev-only in-memory path: refund the reserved funds to the local account.
    if !state.tb.health().await {
        if !state.allow_inmemory {
            return ledger_unavailable("tigerbeetle health check failed");
        }
        let t = match state.pending.get(&pending_id) {
            Some(t) => t.clone(),
            None => return (StatusCode::NOT_FOUND, Json(serde_json::json!({
                "error": "not_found", "pending_id": pending_id,
            }))),
        };
        if t.status != TransferStatus::Committed {
            return (StatusCode::CONFLICT, Json(serde_json::json!({
                "error": "not_committed",
                "message": "only committed transfers can be reversed; void pending transfers instead",
                "status": t.status.as_str(),
            })));
        }
        if let Some(mut bal) = state.balances.get_mut(&t.account_id) {
            bal.1 += t.amount_minor;
        }
        if let Some(mut t) = state.pending.get_mut(&pending_id) {
            t.status = TransferStatus::Reversed;
            t.settled_at = Some(Utc::now().to_rfc3339());
        }
        let reversal_id = deterministic_id(&reverse_key);
        state.idem_index.insert(reverse_key, reversal_id);
        warn!(pending_id = %pending_id, "transfer reversed (local)");
        return (StatusCode::OK, Json(serde_json::json!({
            "status": "reversed",
            "pending_id": pending_id,
            "reversal_id": reversal_id,
            "source": "in_memory_dev",
        })));
    }

    // TigerBeetle path: need the original transfer's accounts.
    let original = match state.find_record(&pending_id).await {
        Some(rec) => rec,
        None => return (StatusCode::NOT_FOUND, Json(serde_json::json!({
            "error": "not_found",
            "message": "no transfer record for pending_id; cannot reverse without the original accounts",
            "pending_id": pending_id,
        }))),
    };
    match original.status {
        TransferStatus::Committed => {}
        TransferStatus::Reversed => {
            // Already reversed but index was lost (e.g. restart) — report success.
            return (StatusCode::OK, Json(serde_json::json!({
                "status": "reversed",
                "pending_id": pending_id,
                "replayed": true,
            })));
        }
        other => {
            return (StatusCode::CONFLICT, Json(serde_json::json!({
                "error": "not_committed",
                "message": "only committed transfers can be reversed; void pending transfers instead",
                "status": other.as_str(),
            })));
        }
    }

    let reversal_id = deterministic_id(&reverse_key);
    match state.tb.create_posted_transfer(
        reversal_id.as_u128(),
        original.credit_account_id, // reversed direction
        original.debit_account_id,
        original.amount_minor,
        original.ledger,
        original.code,
    ).await {
        Ok(_) => {
            state.mark_record_status(&pending_id, TransferStatus::Reversed).await;
            state.save_record(&TransferRecord {
                id: reversal_id,
                debit_account_id: original.credit_account_id,
                credit_account_id: original.debit_account_id,
                amount_minor: original.amount_minor,
                ledger: original.ledger,
                code: original.code,
                status: TransferStatus::Committed,
                idempotency_key: Some(reverse_key),
                reversal_of: Some(pending_id),
                created_at: Utc::now().to_rfc3339(),
                settled_at: Some(Utc::now().to_rfc3339()),
            }).await;
            warn!(pending_id = %pending_id, reversal_id = %reversal_id, "transfer reversed (tigerbeetle)");
            (StatusCode::OK, Json(serde_json::json!({
                "status": "reversed",
                "pending_id": pending_id,
                "reversal_id": reversal_id,
                "amount_minor": original.amount_minor,
                "source": "tigerbeetle",
            })))
        }
        Err(e) => {
            error!("TB reversal failed: {}", e);
            ledger_unavailable(&e)
        }
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
            "reserved_minor": e.0,
            "available_minor": e.1,
        })))
        .collect();
    (StatusCode::OK, Json(serde_json::json!({
        "balances": b,
        "unit": "minor",
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
    if cfg.platform_escrow_account.is_none() && !cfg.allow_inmemory {
        warn!("PLATFORM_ESCROW_ACCOUNT_ID is not set — /ledger/reserve without an explicit credit_account_id will fail");
    }

    let state = AppState::new(&cfg).await;

    info!(
        port = cfg.port,
        tigerbeetle = %cfg.tigerbeetle_address,
        allow_inmemory = cfg.allow_inmemory,
        pending_timeout_secs = cfg.pending_timeout_secs,
        "Ledger Bridge starting"
    );

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/balance/:account_id", get(get_balance_handler))
        .route("/transfer", post(transfer_handler))
        .route("/ledger/reserve", post(reserve_handler))
        .route("/ledger/commit", post(commit_handler))
        .route("/ledger/void", post(void_handler))
        .route("/ledger/reverse", post(reverse_handler))
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
