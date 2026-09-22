//! One-off provisioning: create the 5 wacommerce.* topics this service consumes, if they don't
//! already exist. QA-045/046: the real bug fixed here wasn't just the consumer's broken protocol —
//! the topics themselves had never been created in this Fluvio cluster at all (`Topic not found`,
//! confirmed live). Idempotent (skips a topic that already exists); safe to re-run.
//!
//! Run with: FLUVIO_ENDPOINT=<sc addr> cargo run --release --bin provision_topics
use anyhow::Result;
use fluvio::{metadata::topic::TopicSpec, Fluvio, FluvioClusterConfig};
use std::env;

const TOPICS: &[&str] = &[
    "wacommerce-orders",
    "wacommerce-payments",
    "wacommerce-conversations",
    "wacommerce-inventory",
    "wacommerce-hermes-po",
];

#[tokio::main]
async fn main() -> Result<()> {
    let endpoint = env::var("FLUVIO_ENDPOINT").unwrap_or_else(|_| "http://fluvio-sc:9003".to_string());
    let addr = endpoint
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    println!("connecting to {addr}");
    let fluvio = Fluvio::connect_with_config(&FluvioClusterConfig::new(addr)).await?;
    let admin = fluvio.admin().await;

    let existing: Vec<String> = admin
        .list::<TopicSpec, String>(vec![])
        .await?
        .into_iter()
        .map(|m| m.name)
        .collect();
    println!("existing topics: {existing:?}");

    for topic in TOPICS {
        if existing.iter().any(|e| e == topic) {
            println!("{topic}: already exists, skipping");
            continue;
        }
        // 1 partition, 1 replica — single-node dev Fluvio cluster (matches what's actually deployed:
        // one fluvio-sc pod, no separate SPUs).
        let spec = TopicSpec::new_computed(1, 1, None);
        match admin.create(topic.to_string(), false, spec).await {
            Ok(()) => println!("{topic}: created"),
            Err(e) => println!("{topic}: FAILED: {e:?}"),
        }
    }
    Ok(())
}
