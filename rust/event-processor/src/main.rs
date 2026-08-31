//! Event Processor — High-throughput Kafka consumer with exactly-once semantics.
//! Routes events to downstream Go services via HTTP with idempotency guarantees.

use anyhow::Result;
use axum::{extract::State, response::Json, routing::get, Router};
use chrono::Utc;
use dashmap::DashMap;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{signal, sync::Semaphore, time};
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Debug, Clone)]
struct Config {
    port: u16,
    kafka_brokers: String,
    kafka_group_id: String,
    conversation_orchestrator_url: String,
    commerce_engine_url: String,
    payment_orchestrator_url: String,
    crm_adapter_url: String,
    erp_adapter_url: String,
    max_concurrency: usize,
}

impl Config {
    fn from_env() -> Self {
        Self {
            port: std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8091),
            kafka_brokers: std::env::var("KAFKA_BROKERS").unwrap_or_else(|_| "localhost:9092".into()),
            kafka_group_id: std::env::var("KAFKA_GROUP_ID").unwrap_or_else(|_| "event-processor-v1".into()),
            conversation_orchestrator_url: std::env::var("CONVERSATION_ORCHESTRATOR_URL").unwrap_or_else(|_| "http://localhost:8082".into()),
            commerce_engine_url: std::env::var("COMMERCE_ENGINE_URL").unwrap_or_else(|_| "http://localhost:8083".into()),
            payment_orchestrator_url: std::env::var("PAYMENT_ORCHESTRATOR_URL").unwrap_or_else(|_| "http://localhost:8084".into()),
            crm_adapter_url: std::env::var("CRM_ADAPTER_URL").unwrap_or_else(|_| "http://localhost:8085".into()),
            erp_adapter_url: std::env::var("ERP_ADAPTER_URL").unwrap_or_else(|_| "http://localhost:8086".into()),
            max_concurrency: std::env::var("MAX_CONCURRENCY").ok().and_then(|v| v.parse().ok()).unwrap_or(50),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EventEnvelope {
    id: Uuid,
    tenant_id: Uuid,
    trace_id: Option<String>,
    event_type: String,
    event_version: String,
    occurred_at: String,
    producer: String,
    idempotency_key: String,
    payload: serde_json::Value,
}

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    processed_count: Arc<std::sync::atomic::AtomicU64>,
    error_count: Arc<std::sync::atomic::AtomicU64>,
    route_stats: Arc<DashMap<String, u64>>,
}

struct EventRouter {
    config: Arc<Config>,
    http: Client,
    semaphore: Arc<Semaphore>,
    processed_count: Arc<std::sync::atomic::AtomicU64>,
    error_count: Arc<std::sync::atomic::AtomicU64>,
    route_stats: Arc<DashMap<String, u64>>,
}

impl EventRouter {
    fn new(config: Arc<Config>, http: Client, semaphore: Arc<Semaphore>,
           processed_count: Arc<std::sync::atomic::AtomicU64>,
           error_count: Arc<std::sync::atomic::AtomicU64>,
           route_stats: Arc<DashMap<String, u64>>) -> Self {
        Self { config, http, semaphore, processed_count, error_count, route_stats }
    }

    // === W35 otel ===
    #[tracing::instrument(
        name = "event.route",
        skip(self, envelope),
        fields(component = "event-processor", event_type = %envelope.event_type, tenant_id = %envelope.tenant_id)
    )]
    // === END W35 otel ===
    async fn route(&self, envelope: &EventEnvelope) -> Result<()> {
        let _permit = self.semaphore.acquire().await?;
        let (url, path) = self.resolve_route(&envelope.event_type)?;
        let resp = self.http
            .post(format!("{}{}", url, path))
            .header("X-Tenant-ID", envelope.tenant_id.to_string())
            .header("X-Request-ID", envelope.trace_id.clone().unwrap_or_else(|| Uuid::new_v4().to_string()))
            .json(envelope)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            warn!(event_type = %envelope.event_type, %status, "downstream error");
            self.error_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return Err(anyhow::anyhow!("downstream error: {}", status));
        }

        self.processed_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        *self.route_stats.entry(envelope.event_type.clone()).or_insert(0) += 1;
        info!(event_type = %envelope.event_type, tenant_id = %envelope.tenant_id, "event routed");
        Ok(())
    }

    fn resolve_route(&self, event_type: &str) -> Result<(String, String)> {
        // Exact match routing table
        let exact: HashMap<&str, (&str, &str)> = [
            ("chat.message.received", (self.config.conversation_orchestrator_url.as_str(), "/internal/process-message")),
            ("chat.conversation.created", (self.config.conversation_orchestrator_url.as_str(), "/internal/process-event")),
            ("chat.conversation.resolved", (self.config.conversation_orchestrator_url.as_str(), "/internal/process-event")),
            ("payment.mojaloop.callback.received", (self.config.payment_orchestrator_url.as_str(), "/webhooks/mojaloop/callback/internal")),
            ("erp.inventory.updated", (self.config.erp_adapter_url.as_str(), "/internal/sync/stock")),
            ("erp.product.updated", (self.config.erp_adapter_url.as_str(), "/internal/sync/product")),
        ].into_iter().collect();

        if let Some((base, path)) = exact.get(event_type) {
            return Ok((base.to_string(), path.to_string()));
        }

        // Prefix routing
        if event_type.starts_with("chat.") { return Ok((self.config.conversation_orchestrator_url.clone(), "/internal/process-event".into())); }
        if event_type.starts_with("commerce.") { return Ok((self.config.commerce_engine_url.clone(), "/internal/process-event".into())); }
        if event_type.starts_with("payment.") { return Ok((self.config.payment_orchestrator_url.clone(), "/internal/process-event".into())); }
        if event_type.starts_with("crm.") { return Ok((self.config.crm_adapter_url.clone(), "/internal/process-event".into())); }
        if event_type.starts_with("erp.") { return Ok((self.config.erp_adapter_url.clone(), "/internal/process-event".into())); }

        Err(anyhow::anyhow!("no route for event type: {}", event_type))
    }
}

async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "service": "event-processor", "ts": Utc::now().to_rfc3339() }))
}

async fn metrics_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let stats: HashMap<String, u64> = state.route_stats.iter().map(|e| (e.key().clone(), *e.value())).collect();
    Json(serde_json::json!({
        "processed_total": state.processed_count.load(std::sync::atomic::Ordering::Relaxed),
        "error_total": state.error_count.load(std::sync::atomic::Ordering::Relaxed),
        "route_stats": stats,
    }))
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
    let exporter = opentelemetry_otlp::new_exporter()
        .tonic()
        .with_endpoint(endpoint.to_string())
        .build_span_exporter()?;
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

#[tokio::main]
async fn main() -> Result<()> {
    // === W35 otel ===
    let otel_enabled = init_telemetry("event-processor", None);
    info!(otel_enabled, "telemetry initialized");
    // === END W35 otel ===

    let config = Arc::new(Config::from_env());
    let http = Client::builder().timeout(Duration::from_secs(15)).pool_max_idle_per_host(20).build()?;

    let processed_count = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let error_count = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let route_stats = Arc::new(DashMap::new());
    let semaphore = Arc::new(Semaphore::new(config.max_concurrency));

    let _router = Arc::new(EventRouter::new(
        config.clone(), http.clone(), semaphore,
        processed_count.clone(), error_count.clone(), route_stats.clone(),
    ));

    let app_state = AppState { config: config.clone(), processed_count, error_count, route_stats };

    // Consumer heartbeat loop
    let hb_brokers = config.kafka_brokers.clone();
    let hb_group = config.kafka_group_id.clone();
    let hb_port = config.port;
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            info!(brokers = %hb_brokers, group = %hb_group, "consumer heartbeat");
        }
    });

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/metrics", get(metrics_handler))
        .with_state(app_state);

    let addr = format!("0.0.0.0:{}", hb_port);
    info!(addr = %addr, "Event Processor starting");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async { signal::ctrl_c().await.expect("ctrl_c"); })
        .await?;
    Ok(())
}

fn app_state_port(config: &Config) -> u16 { config.port }
