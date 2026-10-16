//! fluvio-consumer — Fluvio stream consumer (and producer) for WhatsApp Commerce
//!
//! Consumes events from Fluvio topics and forwards them to the Node.js
//! platform API for processing. Also exposes `/produce` so the platform can
//! publish events through the same real connection. Falls back to a no-op
//! mode when FLUVIO_ENDPOINT is not configured.
//!
//! QA-045/046: before this fix, BOTH directions were placeholders that never worked against the real
//! Fluvio cluster: the consume loop polled a REST API (`GET {sc}/topics/:name/records`) that
//! fluvio-sc has never implemented (it speaks its own native `FluvioApiServer` protocol on that same
//! port), failing every ~5s continuously since the day this service was deployed; the platform's
//! `publishPaymentEvent` posted to a `/produce` route that didn't exist on this service at all (every
//! call 404'd, silently swallowed). Both now use the real `fluvio` SDK crate (already a declared
//! dependency, previously `optional = true` behind a feature the Dockerfile never enabled — so it was
//! never actually compiled in). The topic names were ALSO wrong (dotted, Kafka-style — Fluvio accepts
//! only lowercase letters, numbers and hyphens) and the topics themselves had never been created in
//! this cluster at all; both fixed (see `bin/provision_topics.rs`).
//!
//! Topics consumed:
//!   wacommerce-orders        — triggers order status updates
//!   wacommerce-payments      — triggers payment reconciliation
//!   wacommerce-conversations — triggers conversation analytics
//!   wacommerce-inventory     — triggers stock level sync
//!   wacommerce-hermes-po     — triggers PO workflow steps
//!
//! Architecture:
//!   Fluvio → [fluvio-consumer] → POST /api/internal/events → Node.js platform
//!   Node.js platform → POST /produce → [fluvio-consumer] → Fluvio

use anyhow::{Context, Result};
use axum::{extract::State, response::IntoResponse, routing::get, routing::post, Json, Router};
use fluvio::{
    consumer::ConsumerConfigExtBuilder,
    Fluvio, FluvioClusterConfig, Offset, RecordKey, TopicProducerPool,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    sync::Arc,
    time::Duration,
};
use tokio::sync::RwLock;
use tokio::time::sleep;
use tracing::{error, info, warn};

// ─── Config ───────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Config {
    fluvio_endpoint: String,
    platform_url: String,
    platform_api_key: String,
    port: u16,
    topics: Vec<String>,
}

impl Config {
    fn from_env() -> Self {
        Self {
            fluvio_endpoint: env::var("FLUVIO_ENDPOINT")
                .unwrap_or_else(|_| "http://fluvio-sc:9003".to_string()),
            platform_url: env::var("PLATFORM_API_URL")
                .unwrap_or_else(|_| "http://localhost:3000".to_string()),
            platform_api_key: env::var("PLATFORM_API_KEY").unwrap_or_default(),
            port: env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(8098),
            topics: vec![
                // QA-045/046: Fluvio topic names may only contain lowercase letters, numbers and
                // hyphens — the dotted Kafka-style names these were copied from are rejected outright
                // ("Invalid topic name", confirmed live against the real cluster).
                "wacommerce-orders".to_string(),
                "wacommerce-payments".to_string(),
                "wacommerce-conversations".to_string(),
                "wacommerce-inventory".to_string(),
                "wacommerce-hermes-po".to_string(),
            ],
        }
    }

    /// The fluvio crate's `FluvioClusterConfig` wants a plain `host:port` — its own binary protocol,
    /// not HTTP — but FLUVIO_ENDPOINT is set cluster-wide as an `http://` URL (it also has to serve as
    /// a base for the old REST placeholder's URLs, now gone). Strip the scheme rather than ask every
    /// deployment to carry two envs for one endpoint.
    fn fluvio_addr(&self) -> String {
        self.fluvio_endpoint
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_string()
    }

    /// QA-046 (SPU discovery): this cluster's SPUs have no external ingress configured
    /// (`publicEndpoint.ingress: []`, confirmed live via `kubectl get spus.fluvio.infinyon.com`) — only
    /// `publicEndpointLocal`, the in-cluster DNS address (`fluvio-spu-main-0.fluvio.svc.cluster.local`).
    /// `use_spu_local_address` is exactly the SDK's switch for this case. Every real caller of this
    /// service is itself in-cluster (a different namespace, but still in-cluster), so this is the
    /// correct default here, not a workaround — the moment (if ever) this cluster gets a real external
    /// ingress for Fluvio, this would need to become configurable, but nothing in this deployment needs
    /// that today.
    fn cluster_config(&self) -> FluvioClusterConfig {
        let mut cfg = FluvioClusterConfig::new(self.fluvio_addr());
        cfg.use_spu_local_address = true;
        cfg
    }
}

// ─── Event Types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct PlatformEvent {
    topic: String,
    offset: i64,
    payload: serde_json::Value,
    received_at: u64,
}

#[derive(Debug, Serialize)]
struct ForwardBatch {
    events: Vec<PlatformEvent>,
    source: String,
}

#[derive(Debug, Deserialize)]
struct ProduceRequest {
    topic: String,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct ProduceResponse {
    ok: bool,
    error: Option<String>,
}

// ─── App state ────────────────────────────────────────────────────────────────

struct AppState {
    /// Set once Fluvio connects; producing before that (or when FLUVIO_ENDPOINT is unset) fails
    /// closed with a clear error rather than a silent no-op — a caller that thinks an event was
    /// published when it wasn't is worse than one that gets a definite failure to handle.
    fluvio: RwLock<Option<Fluvio>>,
    /// One producer per topic, created on first use and reused (matches the SDK's own guidance:
    /// producers batch internally, so a fresh one per call would defeat that and reconnect every time).
    producers: RwLock<HashMap<String, Arc<TopicProducerPool>>>,
}

// ─── HTTP Client (consumer → platform) ───────────────────────────────────────

async fn forward_events(
    client: &reqwest::Client,
    config: &Config,
    events: Vec<PlatformEvent>,
) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let batch = ForwardBatch {
        events,
        source: "fluvio-consumer".to_string(),
    };
    let resp = client
        .post(format!("{}/api/internal/events", config.platform_url))
        .header("X-API-Key", &config.platform_api_key)
        .json(&batch)
        .timeout(Duration::from_secs(10))
        .send()
        .await?;

    if !resp.status().is_success() {
        warn!("forward_events: platform returned {}", resp.status());
    }
    Ok(())
}

// ─── Fluvio consumer loop (one task per topic; Fluvio's own client is not topic-scoped) ─────────

/// Consume one topic from `Offset::end()` (new records only — replaying the handful of pre-existing
/// test messages on every restart would be surprising for a live service) and forward each record to
/// the platform. Retries the whole connect+stream cycle with backoff on any error — including at
/// startup, so this never blocks the other topics' consumers or the health endpoint on one bad topic.
async fn consume_topic(config: Arc<Config>, client: reqwest::Client, topic: String) {
    let mut backoff = Duration::from_secs(2);
    const MAX_BACKOFF: Duration = Duration::from_secs(30);
    loop {
        match run_one_topic(&config, &client, &topic).await {
            Ok(()) => {
                // The stream ended cleanly (should not normally happen) — reconnect from the top.
                warn!(topic = %topic, "consumer stream ended; reconnecting");
                backoff = Duration::from_secs(2);
            }
            Err(e) => {
                warn!(topic = %topic, error = ?e, backoff_secs = backoff.as_secs(), "consumer error; retrying with backoff");
            }
        }
        sleep(backoff).await;
        backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
    }
}

async fn run_one_topic(config: &Config, client: &reqwest::Client, topic: &str) -> Result<()> {
    let fluvio = Fluvio::connect_with_config(&config.cluster_config())
        .await
        .with_context(|| format!("connect to Fluvio SC at {}", config.fluvio_addr()))?;

    let consumer_config = ConsumerConfigExtBuilder::default()
        .topic(topic.to_string())
        .offset_start(Offset::end())
        .build()
        .with_context(|| format!("build consumer config for {topic}"))?;

    // QA-046: this hangs FOREVER (no internal timeout) when the cluster has no SPU registered to
    // route the topic-partition to — confirmed live against this cluster: `connect_with_config`
    // returns in ~3ms (SC-only), but opening an actual consumer/producer stream needs a real SPU and
    // never resolves without one. Wrapped so that gap fails loudly and retries with backoff (via the
    // caller's loop) instead of silently freezing the topic's task forever.
    let mut stream = tokio::time::timeout(Duration::from_secs(15), fluvio.consumer_with_config(consumer_config))
        .await
        .map_err(|_| anyhow::anyhow!("open consumer stream for {topic}: timed out after 15s (no SPU available to route this topic — a cluster-level gap, not this service)"))?
        .with_context(|| format!("open consumer stream for {topic}"))?;

    info!(topic = %topic, "consumer connected, waiting for records");

    while let Some(record) = stream.next().await {
        let record = match record {
            Ok(r) => r,
            Err(e) => {
                warn!(topic = %topic, error = ?e, "record error from Fluvio; skipping");
                continue;
            }
        };
        let offset = record.offset;
        let payload: serde_json::Value = match serde_json::from_slice(record.value()) {
            Ok(v) => v,
            Err(e) => {
                warn!(topic = %topic, offset, error = %e, "record value is not JSON; forwarding as string");
                serde_json::Value::String(String::from_utf8_lossy(record.value()).to_string())
            }
        };

        // === W35 otel ===
        // `.instrument()` (not an entered guard) — a guard held across the `.await` below would make
        // this task's future hold a non-Send type, which tokio::spawn refuses to compile.
        use tracing::Instrument;
        let span = consume_span(topic, offset, &payload);
        // === END W35 otel ===

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let event = PlatformEvent {
            topic: topic.to_string(),
            offset,
            payload,
            received_at: now,
        };
        let send_result = forward_events(client, config, vec![event]).instrument(span).await;
        if let Err(e) = send_result {
            error!(topic = %topic, offset, error = %e, "forward_events failed");
        } else {
            info!(topic = %topic, offset, "consumer.record forwarded");
        }
    }
    Ok(())
}

// === W35 otel ===
/// Extract a `traceparent` field from a record's JSON payload, when the producer set one, to
/// continue that trace. Absent on almost everything today (the Node producers don't set it) —
/// that's fine, this degrades to a fresh span, same as before.
fn extract_traceparent(payload: &serde_json::Value) -> Option<String> {
    payload
        .pointer("/traceparent")
        .or_else(|| payload.pointer("/headers/traceparent"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Start a `fluvio.consume` span for one record, continuing the producer trace when a traceparent
/// field is present. Returns the span guard.
fn consume_span(topic: &str, offset: i64, payload: &serde_json::Value) -> tracing::Span {
    let span = tracing::info_span!(
        "fluvio.consume",
        messaging.system = "fluvio",
        messaging.destination = %topic,
        messaging.offset = offset,
    );
    if let Some(tp) = extract_traceparent(payload) {
        use tracing_opentelemetry::OpenTelemetrySpanExt;
        let mut carrier = std::collections::HashMap::new();
        carrier.insert("traceparent".to_string(), tp);
        let parent_cx =
            opentelemetry::global::get_text_map_propagator(|p| p.extract(&carrier));
        span.set_parent(parent_cx);
    }
    span
}
// === END W35 otel ===

// ─── Produce endpoint (platform → this service → Fluvio) ────────────────────

async fn produce(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ProduceRequest>,
) -> impl IntoResponse {
    let fluvio_guard = state.fluvio.read().await;
    let Some(fluvio) = fluvio_guard.as_ref() else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(ProduceResponse { ok: false, error: Some("fluvio_not_connected".to_string()) }),
        );
    };

    // Reuse an existing producer for this topic, or create (and cache) one.
    let producer = {
        let producers = state.producers.read().await;
        producers.get(&req.topic).cloned()
    };
    // QA-046: both awaits below hang forever with no internal timeout when the cluster has no SPU to
    // route this topic's partition to (confirmed live: creating a producer never resolves without
    // one, even though the connect above succeeds in ~3ms). 15s each, so a caller gets a real HTTP
    // error instead of the request hanging until ITS OWN client-side timeout, and so this handler
    // can't tie up a task indefinitely on a cluster-level gap outside this service's control.
    const FLUVIO_OP_TIMEOUT: Duration = Duration::from_secs(15);
    let producer = match producer {
        Some(p) => p,
        None => {
            match tokio::time::timeout(FLUVIO_OP_TIMEOUT, fluvio.topic_producer(req.topic.clone())).await {
                Ok(Ok(p)) => {
                    let p = Arc::new(p);
                    state.producers.write().await.insert(req.topic.clone(), p.clone());
                    p
                }
                Ok(Err(e)) => {
                    warn!(topic = %req.topic, error = %e, "produce: failed to create producer");
                    return (
                        axum::http::StatusCode::BAD_GATEWAY,
                        Json(ProduceResponse { ok: false, error: Some(e.to_string()) }),
                    );
                }
                Err(_) => {
                    warn!(topic = %req.topic, "produce: creating producer timed out after 15s (no SPU available to route this topic)");
                    return (
                        axum::http::StatusCode::GATEWAY_TIMEOUT,
                        Json(ProduceResponse { ok: false, error: Some("timed out creating producer (no SPU available)".to_string()) }),
                    );
                }
            }
        }
    };

    let value = match serde_json::to_vec(&req.payload) {
        Ok(v) => v,
        Err(e) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(ProduceResponse { ok: false, error: Some(e.to_string()) }),
            );
        }
    };

    match tokio::time::timeout(FLUVIO_OP_TIMEOUT, producer.send(RecordKey::NULL, value)).await {
        Ok(Ok(_)) => {
            info!(topic = %req.topic, "produce.ok");
            (axum::http::StatusCode::OK, Json(ProduceResponse { ok: true, error: None }))
        }
        Ok(Err(e)) => {
            warn!(topic = %req.topic, error = %e, "produce: send failed");
            (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(ProduceResponse { ok: false, error: Some(e.to_string()) }),
            )
        }
        Err(_) => {
            warn!(topic = %req.topic, "produce: send timed out after 15s");
            (
                axum::http::StatusCode::GATEWAY_TIMEOUT,
                Json(ProduceResponse { ok: false, error: Some("send timed out".to_string()) }),
            )
        }
    }
}

// ─── Health Endpoint ──────────────────────────────────────────────────────────

async fn health(State(state): State<Arc<AppState>>) -> axum::response::Json<serde_json::Value> {
    let connected = state.fluvio.read().await.is_some();
    axum::response::Json(serde_json::json!({
        "status": "ok",
        "service": "fluvio-consumer",
        "version": env!("CARGO_PKG_VERSION"),
        "fluvio_connected": connected,
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

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    // === W35 otel ===
    let otel_enabled = init_telemetry("fluvio-consumer", Some("fluvio_consumer=info"));
    info!(otel_enabled, "telemetry initialized");
    // === END W35 otel ===

    let config = Arc::new(Config::from_env());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;

    let state = Arc::new(AppState {
        fluvio: RwLock::new(None),
        producers: RwLock::new(HashMap::new()),
    });

    let port = config.port;

    if env::var("FLUVIO_ENDPOINT").is_err() {
        info!("FLUVIO_ENDPOINT not set — running in no-op mode (no consume, /produce refuses)");
    } else {
        // Connect once for the producer side (health + /produce); each consumer task connects
        // separately since fluvio::Fluvio is not Sync-shareable across the long-lived stream borrows.
        match Fluvio::connect_with_config(&config.cluster_config()).await {
            Ok(fluvio) => {
                info!(endpoint = %config.fluvio_addr(), "connected to Fluvio (producer side)");
                *state.fluvio.write().await = Some(fluvio);
            }
            Err(e) => {
                warn!(error = %e, "initial Fluvio connect failed (producer side) — /produce will refuse until it recovers");
            }
        }

        for topic in &config.topics {
            let topic = topic.clone();
            let consumer_config = config.clone();
            let consumer_client = client.clone();
            tokio::spawn(async move {
                consume_topic(consumer_config, consumer_client, topic).await;
            });
        }
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/produce", post(produce))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    info!("fluvio-consumer HTTP server on :{}", port);
    axum::serve(listener, app).await?;
    Ok(())
}
