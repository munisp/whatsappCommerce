//! fluvio-consumer — Fluvio stream consumer for WhatsApp Commerce
//!
//! Consumes events from Fluvio topics and forwards them to the Node.js
//! platform API for processing. Falls back to a no-op mode when
//! FLUVIO_ENDPOINT is not configured.
//!
//! Topics consumed:
//!   wacommerce.orders        — triggers order status updates
//!   wacommerce.payments      — triggers payment reconciliation
//!   wacommerce.conversations — triggers conversation analytics
//!   wacommerce.inventory     — triggers stock level sync
//!   wacommerce.hermes.po     — triggers PO workflow steps
//!
//! Architecture:
//!   Fluvio → [fluvio-consumer] → POST /api/internal/events → Node.js platform

use anyhow::Result;
use axum::{routing::get, Router};
use serde::{Deserialize, Serialize};
use std::{env, sync::Arc, time::Duration};
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
    batch_size: usize,
    poll_interval_ms: u64,
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
                "wacommerce.orders".to_string(),
                "wacommerce.payments".to_string(),
                "wacommerce.conversations".to_string(),
                "wacommerce.inventory".to_string(),
                "wacommerce.hermes.po".to_string(),
            ],
            batch_size: 100,
            poll_interval_ms: 500,
        }
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

// ─── HTTP Client ──────────────────────────────────────────────────────────────

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

// ─── Fluvio Consumer Loop ─────────────────────────────────────────────────────

/// Simulated consumer loop — replace with real Fluvio SDK calls when
/// the `fluvio-enabled` feature is active.
async fn run_consumer_loop(config: Arc<Config>, client: Arc<reqwest::Client>) {
    info!(
        "fluvio-consumer starting endpoint={} topics={:?}",
        config.fluvio_endpoint, config.topics
    );

    if env::var("FLUVIO_ENDPOINT").is_err() {
        info!("FLUVIO_ENDPOINT not set — consumer running in no-op mode");
        loop {
            sleep(Duration::from_secs(60)).await;
        }
    }

    // Real consumer loop using Fluvio HTTP API (SmartConnector / REST proxy)
    // When the Fluvio SDK is available, replace this with native consumer.
    let mut offsets: std::collections::HashMap<String, i64> = config
        .topics
        .iter()
        .map(|t| (t.clone(), 0i64))
        .collect();

    loop {
        for topic in &config.topics {
            let offset = offsets.get(topic).copied().unwrap_or(0);
            let url = format!(
                "{}/topics/{}/records?offset={}&limit={}",
                config.fluvio_endpoint, topic, offset, config.batch_size
            );

            match client.get(&url).timeout(Duration::from_secs(5)).send().await {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<serde_json::Value>().await {
                        Ok(data) => {
                            let records = data["records"]
                                .as_array()
                                .cloned()
                                .unwrap_or_default();

                            if records.is_empty() {
                                continue;
                            }

                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64;

                            let events: Vec<PlatformEvent> = records
                                .iter()
                                .enumerate()
                                .map(|(i, r)| {
                                    // === W35 otel ===
                                    let _span_guard = consume_span(topic, offset + i as i64, r);
                                    // === END W35 otel ===
                                    PlatformEvent {
                                        topic: topic.clone(),
                                        offset: offset + i as i64,
                                        payload: r.clone(),
                                        received_at: now,
                                    }
                                })
                                .collect();

                            let new_offset = offset + events.len() as i64;
                            if let Err(e) =
                                forward_events(&client, &config, events).await
                            {
                                error!("forward_events failed topic={}: {}", topic, e);
                            } else {
                                offsets.insert(topic.clone(), new_offset);
                                info!(
                                    "consumer.batch topic={} count={} offset={}",
                                    topic,
                                    new_offset - offset,
                                    new_offset
                                );
                            }
                        }
                        Err(e) => warn!("consumer.parse topic={}: {}", topic, e),
                    }
                }
                Ok(resp) => {
                    warn!("consumer.poll topic={} status={}", topic, resp.status());
                }
                Err(e) => {
                    warn!("consumer.poll topic={} error={}", topic, e);
                }
            }
        }
        sleep(Duration::from_millis(config.poll_interval_ms)).await;
    }
}


// === W35 otel ===
/// Extract the W3C `traceparent` (lowercase string header — binding W35
/// contract with the Kafka/Node producers) from a record's metadata/headers.
fn extract_traceparent(record: &serde_json::Value) -> Option<String> {
    record
        .pointer("/headers/traceparent")
        .or_else(|| record.pointer("/metadata/traceparent"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Start a `fluvio.consume` span for one record, continuing the producer
/// trace when a traceparent header is present. Returns the span guard.
fn consume_span(topic: &str, offset: i64, record: &serde_json::Value) -> tracing::span::EnteredSpan {
    let span = tracing::info_span!(
        "fluvio.consume",
        messaging.system = "fluvio",
        messaging.destination = %topic,
        messaging.offset = offset,
    );
    if let Some(tp) = extract_traceparent(record) {
        use tracing_opentelemetry::OpenTelemetrySpanExt;
        let mut carrier = std::collections::HashMap::new();
        carrier.insert("traceparent".to_string(), tp);
        let parent_cx =
            opentelemetry::global::get_text_map_propagator(|p| p.extract(&carrier));
        span.set_parent(parent_cx);
    }
    span.entered()
}
// === END W35 otel ===

// ─── Health Endpoint ──────────────────────────────────────────────────────────

async fn health() -> axum::response::Json<serde_json::Value> {
    axum::response::Json(serde_json::json!({
        "status": "ok",
        "service": "fluvio-consumer",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

// ─── Main ─────────────────────────────────────────────────────────────────────


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
    dotenvy::dotenv().ok();
    // === W35 otel ===
    let otel_enabled = init_telemetry("fluvio-consumer", Some("fluvio_consumer=info"));
    info!(otel_enabled, "telemetry initialized");
    // === END W35 otel ===

    let config = Arc::new(Config::from_env());
    let client = Arc::new(
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()?,
    );

    let port = config.port;

    // Spawn consumer loop
    let consumer_config = config.clone();
    let consumer_client = client.clone();
    tokio::spawn(async move {
        run_consumer_loop(consumer_config, consumer_client).await;
    });

    // Health server
    let app = Router::new().route("/health", get(health));
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    info!("fluvio-consumer health server on :{}", port);
    axum::serve(listener, app).await?;
    Ok(())
}
