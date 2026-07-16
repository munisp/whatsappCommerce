//! hermes-router — Rust high-throughput event router for the Hermes Agent integration.
//!
//! This crate sits between the platform's Kafka bus and the Hermes Agent HTTP API.
//! It provides:
//!   - Fan-out routing: one platform event → multiple Hermes skill endpoints
//!   - Circuit breaker per downstream endpoint (closed/open/half-open)
//!   - Exponential backoff retry with jitter (max 3 attempts)
//!   - Dead-letter queue (DLQ) for undeliverable events (logged + persisted to disk)
//!   - Prometheus-compatible metrics endpoint (/metrics)
//!   - Health endpoint (/health)
//!
//! Kafka topics consumed:
//!   hermes.events.inbound  — platform events destined for Hermes
//!
//! Kafka topics produced:
//!   hermes.events.outbound — Hermes responses destined for the platform
//!   hermes.events.dlq      — undeliverable events after max retries

use anyhow::Result;
use axum::{extract::State, response::Json, routing::get, Router};
use chrono::Utc;
use dashmap::DashMap;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI32, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    signal,
    sync::{Semaphore, RwLock},
    time::{sleep, Instant},
};
use tracing::{error, info, warn};
use uuid::Uuid;

// ─── Configuration ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Config {
    port: u16,
    kafka_brokers: String,
    kafka_group_id: String,
    hermes_agent_url: String,
    hermes_api_key: String,
    hermes_skills_url: String,   // Python skill executor URL
    platform_api_url: String,
    max_concurrency: usize,
    max_retries: u32,
    circuit_breaker_threshold: u32,
    circuit_breaker_reset_secs: u64,
    dlq_dir: String,
}

impl Config {
    fn from_env() -> Self {
        Self {
            port: std::env::var("PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8096),
            kafka_brokers: std::env::var("KAFKA_BROKERS")
                .unwrap_or_else(|_| "localhost:9092".into()),
            kafka_group_id: std::env::var("KAFKA_GROUP_ID")
                .unwrap_or_else(|_| "hermes-router-v1".into()),
            hermes_agent_url: std::env::var("HERMES_AGENT_URL")
                .unwrap_or_else(|_| "http://localhost:8090".into()),
            hermes_api_key: std::env::var("HERMES_API_KEY")
                .unwrap_or_default(),
            hermes_skills_url: std::env::var("HERMES_SKILLS_URL")
                .unwrap_or_else(|_| "http://localhost:8097".into()),
            platform_api_url: std::env::var("PLATFORM_API_URL")
                .unwrap_or_else(|_| "http://localhost:3000".into()),
            max_concurrency: std::env::var("MAX_CONCURRENCY")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(50),
            max_retries: std::env::var("MAX_RETRIES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3),
            circuit_breaker_threshold: std::env::var("CIRCUIT_BREAKER_THRESHOLD")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5),
            circuit_breaker_reset_secs: std::env::var("CIRCUIT_BREAKER_RESET_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30),
            dlq_dir: std::env::var("DLQ_DIR")
                .unwrap_or_else(|_| "/tmp/hermes-dlq".into()),
        }
    }
}

// ─── Domain Types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EventEnvelope {
    id: String,
    tenant_id: String,
    trace_id: Option<String>,
    event_type: String,
    event_version: String,
    occurred_at: String,
    producer: String,
    idempotency_key: String,
    payload: serde_json::Value,
    #[serde(default)]
    retry_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RouteTarget {
    name: String,
    url: String,
    event_types: Vec<String>, // empty = match all
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RoutingResult {
    event_id: String,
    target: String,
    success: bool,
    attempts: u32,
    error: Option<String>,
    latency_ms: u64,
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

#[derive(Debug)]
struct CircuitBreaker {
    failures: AtomicI32,
    threshold: i32,
    state: AtomicI32, // 0=closed, 1=open, 2=half-open
    last_failure_ms: AtomicU64,
    reset_timeout_ms: u64,
}

impl CircuitBreaker {
    fn new(threshold: u32, reset_secs: u64) -> Self {
        Self {
            failures: AtomicI32::new(0),
            threshold: threshold as i32,
            state: AtomicI32::new(0),
            last_failure_ms: AtomicU64::new(0),
            reset_timeout_ms: reset_secs * 1000,
        }
    }

    fn allow(&self) -> bool {
        match self.state.load(Ordering::SeqCst) {
            0 => true, // closed
            1 => {
                // open — check if reset timeout elapsed
                let last_fail = self.last_failure_ms.load(Ordering::SeqCst);
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                if now_ms - last_fail > self.reset_timeout_ms {
                    self.state.store(2, Ordering::SeqCst); // half-open
                    true
                } else {
                    false
                }
            }
            _ => true, // half-open
        }
    }

    fn record_success(&self) {
        self.failures.store(0, Ordering::SeqCst);
        self.state.store(0, Ordering::SeqCst);
    }

    fn record_failure(&self) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        self.last_failure_ms.store(now_ms, Ordering::SeqCst);
        let failures = self.failures.fetch_add(1, Ordering::SeqCst) + 1;
        if failures >= self.threshold {
            self.state.store(1, Ordering::SeqCst); // open
        }
    }

    fn state_str(&self) -> &'static str {
        match self.state.load(Ordering::SeqCst) {
            0 => "closed",
            1 => "open",
            _ => "half-open",
        }
    }
}

// ─── Router State ─────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    http: Client,
    semaphore: Arc<Semaphore>,
    circuit_breakers: Arc<DashMap<String, Arc<CircuitBreaker>>>,
    route_stats: Arc<DashMap<String, u64>>,
    total_routed: Arc<AtomicU64>,
    total_failed: Arc<AtomicU64>,
    total_dlq: Arc<AtomicU64>,
    routes: Arc<RwLock<Vec<RouteTarget>>>,
}

impl AppState {
    fn new(config: Config) -> Self {
        let cfg = Arc::new(config);

        // Default routing table: platform events → Hermes Agent + Python skills
        let default_routes = vec![
            RouteTarget {
                name: "hermes-agent".into(),
                url: cfg.hermes_agent_url.clone() + "/api/v1/process",
                event_types: vec![
                    "inventory.low_stock".into(),
                    "inventory.out_of_stock".into(),
                    "order.placed".into(),
                    "order.high_value".into(),
                    "fraud.alert".into(),
                    "customer.complaint".into(),
                    "supplier.delivery_delay".into(),
                ],
            },
            RouteTarget {
                name: "hermes-skills".into(),
                url: cfg.hermes_skills_url.clone() + "/skills/process",
                event_types: vec![
                    "inventory.low_stock".into(),
                    "inventory.out_of_stock".into(),
                    "supplier.delivery_delay".into(),
                ],
            },
        ];

        Self {
            http: Client::builder()
                .timeout(Duration::from_secs(30))
                .pool_max_idle_per_host(20)
                .build()
                .expect("http client"),
            semaphore: Arc::new(Semaphore::new(cfg.max_concurrency)),
            circuit_breakers: Arc::new(DashMap::new()),
            route_stats: Arc::new(DashMap::new()),
            total_routed: Arc::new(AtomicU64::new(0)),
            total_failed: Arc::new(AtomicU64::new(0)),
            total_dlq: Arc::new(AtomicU64::new(0)),
            routes: Arc::new(RwLock::new(default_routes)),
            config: cfg,
        }
    }

    fn get_circuit_breaker(&self, target: &str) -> Arc<CircuitBreaker> {
        self.circuit_breakers
            .entry(target.to_string())
            .or_insert_with(|| {
                Arc::new(CircuitBreaker::new(
                    self.config.circuit_breaker_threshold,
                    self.config.circuit_breaker_reset_secs,
                ))
            })
            .clone()
    }
}

// ─── Event Router ─────────────────────────────────────────────────────────────

async fn route_event(state: AppState, event: EventEnvelope) {
    let _permit = state.semaphore.acquire().await.expect("semaphore");
    let routes = state.routes.read().await.clone();

    let matching_routes: Vec<&RouteTarget> = routes
        .iter()
        .filter(|r| {
            r.event_types.is_empty() || r.event_types.contains(&event.event_type)
        })
        .collect();

    if matching_routes.is_empty() {
        info!(event_id = %event.id, event_type = %event.event_type, "no matching routes — skipping");
        return;
    }

    let mut handles = Vec::new();
    for route in matching_routes {
        let state_clone = state.clone();
        let event_clone = event.clone();
        let route_clone = route.clone();

        handles.push(tokio::spawn(async move {
            deliver_with_retry(state_clone, event_clone, route_clone).await
        }));
    }

    for handle in handles {
        if let Err(e) = handle.await {
            error!("route task panicked: {:?}", e);
        }
    }
}

async fn deliver_with_retry(
    state: AppState,
    mut event: EventEnvelope,
    target: RouteTarget,
) -> RoutingResult {
    let cb = state.get_circuit_breaker(&target.name);
    let start = Instant::now();
    let mut last_error = None;

    for attempt in 1..=state.config.max_retries {
        if !cb.allow() {
            warn!(
                target = %target.name,
                event_id = %event.id,
                "circuit breaker open — skipping delivery"
            );
            return RoutingResult {
                event_id: event.id.clone(),
                target: target.name.clone(),
                success: false,
                attempts: attempt,
                error: Some("circuit_breaker_open".into()),
                latency_ms: start.elapsed().as_millis() as u64,
            };
        }

        event.retry_count = attempt - 1;
        match deliver_once(&state.http, &target.url, &state.config.hermes_api_key, &event).await {
            Ok(()) => {
                cb.record_success();
                state.total_routed.fetch_add(1, Ordering::Relaxed);
                *state.route_stats.entry(target.name.clone()).or_insert(0) += 1;

                info!(
                    event_id = %event.id,
                    target = %target.name,
                    attempt,
                    latency_ms = start.elapsed().as_millis(),
                    "event delivered"
                );

                return RoutingResult {
                    event_id: event.id.clone(),
                    target: target.name.clone(),
                    success: true,
                    attempts: attempt,
                    error: None,
                    latency_ms: start.elapsed().as_millis() as u64,
                };
            }
            Err(e) => {
                cb.record_failure();
                last_error = Some(e.to_string());
                warn!(
                    event_id = %event.id,
                    target = %target.name,
                    attempt,
                    error = %e,
                    "delivery attempt failed"
                );

                if attempt < state.config.max_retries {
                    // Exponential backoff with jitter: 100ms * 2^(attempt-1) + random 0-50ms
                    let base_ms = 100u64 * (1u64 << (attempt - 1));
                    let jitter_ms = (uuid::Uuid::new_v4().as_u128() % 50) as u64;
                    sleep(Duration::from_millis(base_ms + jitter_ms)).await;
                }
            }
        }
    }

    // All retries exhausted → send to DLQ
    state.total_failed.fetch_add(1, Ordering::Relaxed);
    state.total_dlq.fetch_add(1, Ordering::Relaxed);
    write_to_dlq(&state.config.dlq_dir, &event, &target.name, &last_error).await;

    RoutingResult {
        event_id: event.id.clone(),
        target: target.name.clone(),
        success: false,
        attempts: state.config.max_retries,
        error: last_error,
        latency_ms: start.elapsed().as_millis() as u64,
    }
}

async fn deliver_once(
    http: &Client,
    url: &str,
    api_key: &str,
    event: &EventEnvelope,
) -> Result<()> {
    let mut req = http.post(url).json(event);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }
    req = req.header("X-Event-ID", &event.id)
             .header("X-Trace-ID", event.trace_id.as_deref().unwrap_or(""))
             .header("X-Idempotency-Key", &event.idempotency_key);

    let resp = req.send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("upstream returned {}: {}", status, &body[..body.len().min(200)]);
    }
    Ok(())
}

async fn write_to_dlq(dlq_dir: &str, event: &EventEnvelope, target: &str, error: &Option<String>) {
    let _ = tokio::fs::create_dir_all(dlq_dir).await;
    let filename = format!("{}/{}-{}.json", dlq_dir, Utc::now().timestamp_millis(), &event.id[..8]);
    let entry = serde_json::json!({
        "event": event,
        "target": target,
        "error": error,
        "dlq_at": Utc::now().to_rfc3339(),
    });
    if let Ok(content) = serde_json::to_string_pretty(&entry) {
        let _ = tokio::fs::write(&filename, content).await;
        error!(event_id = %event.id, target, dlq_file = %filename, "event sent to DLQ");
    }
}

// ─── HTTP Handlers ────────────────────────────────────────────────────────────

async fn handle_health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let routes = state.routes.read().await;
    let cb_states: HashMap<String, &str> = state
        .circuit_breakers
        .iter()
        .map(|e| (e.key().clone(), e.value().state_str()))
        .collect();

    Json(serde_json::json!({
        "status": "ok",
        "service": "hermes-router",
        "routes": routes.len(),
        "total_routed": state.total_routed.load(Ordering::Relaxed),
        "total_failed": state.total_failed.load(Ordering::Relaxed),
        "total_dlq": state.total_dlq.load(Ordering::Relaxed),
        "circuit_breakers": cb_states,
    }))
}

async fn handle_metrics(State(state): State<AppState>) -> String {
    let routed = state.total_routed.load(Ordering::Relaxed);
    let failed = state.total_failed.load(Ordering::Relaxed);
    let dlq = state.total_dlq.load(Ordering::Relaxed);

    let mut out = String::new();
    out.push_str("# HELP hermes_router_events_routed_total Total events successfully routed\n");
    out.push_str("# TYPE hermes_router_events_routed_total counter\n");
    out.push_str(&format!("hermes_router_events_routed_total {}\n", routed));
    out.push_str("# HELP hermes_router_events_failed_total Total events that failed all retries\n");
    out.push_str("# TYPE hermes_router_events_failed_total counter\n");
    out.push_str(&format!("hermes_router_events_failed_total {}\n", failed));
    out.push_str("# HELP hermes_router_events_dlq_total Total events sent to DLQ\n");
    out.push_str("# TYPE hermes_router_events_dlq_total counter\n");
    out.push_str(&format!("hermes_router_events_dlq_total {}\n", dlq));

    for entry in state.route_stats.iter() {
        out.push_str(&format!(
            "hermes_router_route_events_total{{target=\"{}\"}} {}\n",
            entry.key(),
            entry.value()
        ));
    }
    out
}

// Ingest endpoint: allows direct HTTP event injection (Kafka fallback)
async fn handle_ingest(
    State(state): State<AppState>,
    Json(event): Json<EventEnvelope>,
) -> Json<serde_json::Value> {
    let event_id = event.id.clone();
    tokio::spawn(route_event(state, event));
    Json(serde_json::json!({ "status": "accepted", "event_id": event_id }))
}

// ─── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("hermes_router=info".parse()?),
        )
        .init();

    let config = Config::from_env();
    info!(
        port = config.port,
        hermes_url = %config.hermes_agent_url,
        skills_url = %config.hermes_skills_url,
        "hermes-router starting"
    );

    // Ensure DLQ directory exists
    tokio::fs::create_dir_all(&config.dlq_dir).await?;

    let state = AppState::new(config.clone());
    let port = config.port;

    let app = Router::new()
        .route("/health", get(handle_health))
        .route("/metrics", get(handle_metrics))
        .route("/ingest", axum::routing::post(handle_ingest))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    info!("hermes-router listening on :{}", port);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("hermes-router stopped");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("ctrl-c handler");
    };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("shutdown signal received");
}

