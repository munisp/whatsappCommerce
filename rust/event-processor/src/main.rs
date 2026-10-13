//! Event Processor — Kafka consumer routing events to downstream Go services
//! via HTTP. At-least-once delivery: offsets commit after routing completes
//! (success or failure), so a crash between receive and commit re-delivers
//! the message. There is no DLQ/retry queue here (unlike
//! services/message-processor) -- a routing failure is logged and counted
//! (see /metrics) rather than retried, so one bad event can never wedge the
//! partition for every other tenant/event type behind it. Downstream
//! services are expected to be idempotent on `idempotency_key`.

use anyhow::Result;
use axum::{extract::State, response::Json, routing::get, Router};
use chrono::Utc;
use dashmap::DashMap;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{signal, sync::Semaphore};
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Debug, Clone)]
struct Config {
    port: u16,
    kafka_brokers: String,
    kafka_group_id: String,
    kafka_topics: Vec<String>,
    conversation_orchestrator_url: String,
    commerce_engine_url: String,
    payment_orchestrator_url: String,
    crm_adapter_url: String,
    erp_adapter_url: String,
    max_concurrency: usize,
    /// QA-038: shared service-to-service secret. Sent ONLY to commerce-engine (see EventRouter::internal_key_for)
    /// — route() fans out to five different services, and the others must not be handed this secret.
    internal_api_key: String,
}

impl Config {
    fn from_env() -> Self {
        Self {
            port: std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8091),
            kafka_brokers: std::env::var("KAFKA_BROKERS").unwrap_or_else(|_| "localhost:9092".into()),
            kafka_group_id: std::env::var("KAFKA_GROUP_ID").unwrap_or_else(|_| "event-processor-v1".into()),
            // The 4 real topics webhook-ingestor publishes to today (see
            // services/webhook-ingestor/internal/handler/chatwoot.go) --
            // "commerce.*" has no producer yet, so it is not subscribed by
            // default (EventRouter still routes it correctly if a future
            // producer starts emitting it on a topic added here).
            kafka_topics: std::env::var("EVENT_PROCESSOR_KAFKA_TOPICS")
                .unwrap_or_else(|_| {
                    "chat.message.received.v1,payment.mojaloop.callback.received.v1,crm.twenty.event.received.v1,erp.odoo.event.received.v1".into()
                })
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            conversation_orchestrator_url: std::env::var("CONVERSATION_ORCHESTRATOR_URL").unwrap_or_else(|_| "http://localhost:8082".into()),
            commerce_engine_url: std::env::var("COMMERCE_ENGINE_URL").unwrap_or_else(|_| "http://localhost:8083".into()),
            payment_orchestrator_url: std::env::var("PAYMENT_ORCHESTRATOR_URL").unwrap_or_else(|_| "http://localhost:8084".into()),
            crm_adapter_url: std::env::var("CRM_ADAPTER_URL").unwrap_or_else(|_| "http://localhost:8085".into()),
            erp_adapter_url: std::env::var("ERP_ADAPTER_URL").unwrap_or_else(|_| "http://localhost:8086".into()),
            max_concurrency: std::env::var("MAX_CONCURRENCY").ok().and_then(|v| v.parse().ok()).unwrap_or(50),
            internal_api_key: std::env::var("INTERNAL_API_KEY").unwrap_or_default(),
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
    // webhook-ingestor's crm.twenty.event.received and erp.odoo.event.received
    // envelopes never set this field at all (only chat.* and payment.mojaloop.*
    // do) -- Option, not String, or every real crm./erp. message would fail to
    // deserialize.
    #[serde(default)]
    idempotency_key: Option<String>,
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
        let resp = self.build_request(&url, &path, envelope).send().await?;

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

    /// QA-038: which destinations get the shared internal secret. ONLY commerce-engine — route() fans out to five
    /// different services (conversation-orchestrator, payment-orchestrator, crm-adapter, erp-adapter and
    /// commerce-engine), and attaching the secret unconditionally would hand it to every one of them. None when
    /// no key is configured (the rollout stage before commerce-engine enforces), so nothing extra is sent.
    fn internal_key_for(&self, url: &str) -> Option<&str> {
        if !self.config.internal_api_key.is_empty() && url == self.config.commerce_engine_url {
            Some(self.config.internal_api_key.as_str())
        } else {
            None
        }
    }

    /// Builds (does not send) the downstream request, so the headers it carries can be tested without a network.
    fn build_request(&self, url: &str, path: &str, envelope: &EventEnvelope) -> reqwest::RequestBuilder {
        let mut req = self.http
            .post(format!("{}{}", url, path))
            .header("X-Tenant-ID", envelope.tenant_id.to_string())
            .header("X-Request-ID", envelope.trace_id.clone().unwrap_or_else(|| Uuid::new_v4().to_string()))
            .json(envelope);
        if let Some(key) = self.internal_key_for(url) {
            req = req.header("X-Internal-Api-Key", key);
        }
        req
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

use rdkafka::config::ClientConfig;
use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
use rdkafka::message::Message as _;

/// Subscribes to `config.kafka_topics` and calls `router.route()` for every
/// message. At-least-once: the offset commits only AFTER routing completes
/// (success or failure) -- never before. A message that fails to parse as
/// JSON, or whose event_type has no route, is logged and its offset is still
/// committed: there is no DLQ here, so refusing to commit would wedge the
/// whole partition (every tenant, every other event type behind it) on one
/// bad message forever.
async fn run_consumer(config: Arc<Config>, router: Arc<EventRouter>) {
    let consumer: StreamConsumer = match ClientConfig::new()
        .set("bootstrap.servers", &config.kafka_brokers)
        .set("group.id", &config.kafka_group_id)
        .set("enable.auto.commit", "false")
        .set("auto.offset.reset", "earliest")
        .set("session.timeout.ms", "30000")
        .create()
    {
        Ok(c) => c,
        Err(e) => {
            error!(error = %e, "failed to create kafka consumer -- event processing is DOWN");
            return;
        }
    };

    let topic_refs: Vec<&str> = config.kafka_topics.iter().map(String::as_str).collect();
    if let Err(e) = consumer.subscribe(&topic_refs) {
        error!(error = %e, topics = ?config.kafka_topics, "failed to subscribe to kafka topics -- event processing is DOWN");
        return;
    }
    info!(brokers = %config.kafka_brokers, group = %config.kafka_group_id, topics = ?config.kafka_topics, "event-processor kafka consumer subscribed");

    loop {
        match consumer.recv().await {
            Err(e) => {
                error!(error = %e, "kafka consumer recv error");
            }
            Ok(msg) => {
                let raw = match msg.payload_view::<str>() {
                    Some(Ok(s)) => s,
                    Some(Err(e)) => {
                        warn!(error = %e, "kafka message payload is not valid UTF-8 -- skipping");
                        let _ = consumer.commit_message(&msg, CommitMode::Async);
                        continue;
                    }
                    None => {
                        warn!("kafka message had no payload -- skipping");
                        let _ = consumer.commit_message(&msg, CommitMode::Async);
                        continue;
                    }
                };

                match serde_json::from_str::<EventEnvelope>(raw) {
                    Ok(envelope) => {
                        if let Err(e) = router.route(&envelope).await {
                            error!(error = %e, event_type = %envelope.event_type, tenant_id = %envelope.tenant_id, "event routing failed");
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, topic = %msg.topic(), "failed to parse kafka message as EventEnvelope -- skipping");
                    }
                }

                if let Err(e) = consumer.commit_message(&msg, CommitMode::Async) {
                    error!(error = %e, "kafka offset commit failed");
                }
            }
        }
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
    let otel_enabled = init_telemetry("event-processor", None);
    info!(otel_enabled, "telemetry initialized");
    // === END W35 otel ===

    let config = Arc::new(Config::from_env());
    let http = Client::builder().timeout(Duration::from_secs(15)).pool_max_idle_per_host(20).build()?;

    let processed_count = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let error_count = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let route_stats = Arc::new(DashMap::new());
    let semaphore = Arc::new(Semaphore::new(config.max_concurrency));

    let router = Arc::new(EventRouter::new(
        config.clone(), http.clone(), semaphore,
        processed_count.clone(), error_count.clone(), route_stats.clone(),
    ));

    let app_state = AppState { config: config.clone(), processed_count, error_count, route_stats };

    // Real Kafka consumer (QA-038: this used to be a heartbeat-only log loop
    // that never touched Kafka -- EventRouter::route() was built, tested,
    // and never called in production).
    let consumer_config = config.clone();
    let consumer_router = router.clone();
    tokio::spawn(async move {
        run_consumer(consumer_config, consumer_router).await;
    });

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/metrics", get(metrics_handler))
        .with_state(app_state);

    let addr = format!("0.0.0.0:{}", config.port);
    info!(addr = %addr, "Event Processor starting");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn app_state_port(config: &Config) -> u16 { config.port }

// ─── Tests ────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    // QA-038 — these pin the secret-scoping behaviour of route()/build_request(), which run_consumer() now
    // actually calls for real Kafka traffic (the fake heartbeat-only loop this comment used to describe is gone).

    fn router(key: &str) -> EventRouter {
        let config = Arc::new(Config {
            port: 8091,
            kafka_brokers: "kafka:9092".into(),
            kafka_group_id: "g".into(),
            kafka_topics: vec!["chat.message.received.v1".into()],
            conversation_orchestrator_url: "http://conversation-orchestrator:8082".into(),
            commerce_engine_url: "http://commerce-engine:8083".into(),
            payment_orchestrator_url: "http://payment-orchestrator:8084".into(),
            crm_adapter_url: "http://crm-adapter:8085".into(),
            erp_adapter_url: "http://erp-adapter:8086".into(),
            max_concurrency: 4,
            internal_api_key: key.into(),
        });
        EventRouter::new(
            config, Client::new(), Arc::new(Semaphore::new(4)),
            Arc::default(), Arc::default(), Arc::new(DashMap::new()),
        )
    }

    fn envelope(event_type: &str) -> EventEnvelope {
        EventEnvelope {
            id: Uuid::new_v4(), tenant_id: Uuid::new_v4(), trace_id: Some("trace-1".into()),
            event_type: event_type.into(), event_version: "1".into(), occurred_at: "2026-01-01T00:00:00Z".into(),
            producer: "test".into(), idempotency_key: Some("k".into()), payload: serde_json::json!({}),
        }
    }

    /// The X-Internal-Api-Key the request for this event type would carry (None = header absent).
    fn key_sent_for(r: &EventRouter, event_type: &str) -> Option<String> {
        let (url, path) = r.resolve_route(event_type).unwrap();
        let req = r.build_request(&url, &path, &envelope(event_type)).build().unwrap();
        req.headers().get("x-internal-api-key").map(|v| v.to_str().unwrap().to_string())
    }

    #[test]
    fn commerce_events_carry_the_key_when_one_is_configured() {
        let r = router("s3cret");
        assert_eq!(key_sent_for(&r, "commerce.order.created").as_deref(), Some("s3cret"));
    }

    #[test]
    fn the_secret_is_never_sent_to_any_other_downstream_service() {
        // route() fans out to five services; only commerce-engine may be handed the shared secret.
        let r = router("s3cret");
        for event_type in [
            "chat.message.received",                // conversation-orchestrator (exact route)
            "chat.conversation.created",            // conversation-orchestrator
            "payment.mojaloop.callback.received",   // payment-orchestrator (exact route)
            "payment.intent.completed",             // payment-orchestrator (prefix route)
            "crm.contact.updated",                  // crm-adapter
            "erp.inventory.updated",                // erp-adapter (exact route)
            "erp.order.synced",                     // erp-adapter (prefix route)
        ] {
            assert_eq!(key_sent_for(&r, event_type), None, "{event_type} must not receive the internal secret");
        }
    }

    #[test]
    fn with_no_key_configured_nothing_extra_is_sent_even_to_commerce_engine() {
        let r = router("");
        assert_eq!(key_sent_for(&r, "commerce.order.created"), None);
    }

    #[test]
    fn the_original_headers_are_still_there() {
        let r = router("s3cret");
        let (url, path) = r.resolve_route("commerce.order.created").unwrap();
        let req = r.build_request(&url, &path, &envelope("commerce.order.created")).build().unwrap();
        assert!(req.headers().get("x-tenant-id").is_some());
        assert_eq!(req.headers().get("x-request-id").unwrap(), "trace-1");
        assert_eq!(req.url().as_str(), "http://commerce-engine:8083/internal/process-event");
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

    // ── real envelope shapes from webhook-ingestor (see internal/handler/chatwoot.go) ──

    #[test]
    fn crm_and_erp_envelopes_parse_without_an_idempotency_key() {
        // HandleTwentyWebhook / HandleOdooWebhook never set idempotency_key at
        // all (only chat.message.received and payment.mojaloop.callback.received
        // do) — this must deserialize, not fail with "missing field".
        let raw = serde_json::json!({
            "id": Uuid::new_v4(),
            "tenant_id": Uuid::new_v4(),
            "event_type": "crm.twenty.event.received",
            "event_version": "v1",
            "occurred_at": "2026-01-01T00:00:00Z",
            "producer": "webhook-ingestor",
            "payload": {},
        })
        .to_string();
        let envelope: EventEnvelope = serde_json::from_str(&raw).expect("must parse without idempotency_key");
        assert_eq!(envelope.idempotency_key, None);
        assert_eq!(envelope.trace_id, None);
    }

    #[test]
    fn chat_and_payment_envelopes_parse_with_an_idempotency_key() {
        let raw = serde_json::json!({
            "id": Uuid::new_v4(),
            "tenant_id": Uuid::new_v4(),
            "trace_id": "req-1",
            "event_type": "payment.mojaloop.callback.received",
            "event_version": "v1",
            "occurred_at": "2026-01-01T00:00:00Z",
            "producer": "webhook-ingestor",
            "subject": "transfer:abc", // extra field real envelopes send; must be ignored, not rejected
            "idempotency_key": "mojaloop:tenant:abc",
            "payload": {},
        })
        .to_string();
        let envelope: EventEnvelope = serde_json::from_str(&raw).expect("must parse");
        assert_eq!(envelope.idempotency_key.as_deref(), Some("mojaloop:tenant:abc"));
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
