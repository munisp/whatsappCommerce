//! One-off, read-only tool: dump the last N records of a Fluvio topic to
//! stdout so its contents can actually be inspected. Mirrors provision_topics.rs's
//! connection pattern. Not part of the deployed service.
//!
//! Run with: FLUVIO_ENDPOINT=<sc addr> cargo run --release --bin dump_records -- <topic> [count]
use anyhow::Result;
use fluvio::{consumer::ConsumerConfigExtBuilder, Fluvio, FluvioClusterConfig, Offset};
use futures_util::StreamExt;
use std::env;
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    let topic = args.get(1).cloned().unwrap_or_else(|| "wacommerce-orders".to_string());
    let count: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(10);

    let endpoint = env::var("FLUVIO_ENDPOINT").unwrap_or_else(|_| "fluvio-sc:9003".to_string());
    let addr = endpoint
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    eprintln!("connecting to {addr}, topic={topic}, count={count}");

    let mut cfg = FluvioClusterConfig::new(addr);
    cfg.use_spu_local_address = true;
    let fluvio = Fluvio::connect_with_config(&cfg).await?;

    let consumer_config = ConsumerConfigExtBuilder::default()
        .topic(topic.clone())
        .offset_start(Offset::from_beginning(0))
        .build()?;

    let mut stream = tokio::time::timeout(Duration::from_secs(15), fluvio.consumer_with_config(consumer_config))
        .await
        .map_err(|_| anyhow::anyhow!("open consumer stream: timed out after 15s (no SPU routing this topic)"))??;

    eprintln!("connected, reading up to {count} records (5s idle timeout)...");
    let mut n = 0;
    loop {
        if n >= count {
            break;
        }
        match tokio::time::timeout(Duration::from_secs(5), stream.next()).await {
            Ok(Some(Ok(record))) => {
                n += 1;
                let key = record.get_key().map(|k| String::from_utf8_lossy(k.as_ref()).to_string());
                let value = String::from_utf8_lossy(record.get_value().as_ref()).to_string();
                println!(
                    "--- record {n} (offset {}) key={:?} ---\n{value}\n",
                    record.offset(),
                    key
                );
            }
            Ok(Some(Err(e))) => {
                eprintln!("stream error: {e:?}");
                break;
            }
            Ok(None) => {
                eprintln!("stream ended");
                break;
            }
            Err(_) => {
                eprintln!("no more records within 5s — stopping (read {n})");
                break;
            }
        }
    }
    if n == 0 {
        eprintln!("(topic '{topic}' has no records, or none reachable from offset 0)");
    }
    Ok(())
}
