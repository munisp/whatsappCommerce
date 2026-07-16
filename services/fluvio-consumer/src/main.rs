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
                                .map(|(i, r)| PlatformEvent {
                                    topic: topic.clone(),
                                    offset: offset + i as i64,
                                    payload: r.clone(),
                                    received_at: now,
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

// ─── Health Endpoint ──────────────────────────────────────────────────────────

async fn health() -> axum::response::Json<serde_json::Value> {
    axum::response::Json(serde_json::json!({
        "status": "ok",
        "service": "fluvio-consumer",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

// ─── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("fluvio_consumer=info".parse()?),
        )
        .json()
        .init();

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
