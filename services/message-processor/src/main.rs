//! WhatsApp Commerce — Rust Message Processor
//! Responsibilities: High-performance Kafka consumer, message deduplication,
//! routing logic, stream processing, dead-letter queue management.
//!
//! Dependencies (Cargo.toml):
//!   rdkafka = { version = "0.37", features = ["cmake-build"] }
//!   redis = { version = "0.27", features = ["tokio-comp"] }
//!   tokio = { version = "1", features = ["full"] }
//!   serde = { version = "1", features = ["derive"] }
//!   serde_json = "1"
//!   tracing = "0.1"
//!   tracing-subscriber = "0.3"
//!   uuid = { version = "1", features = ["v4"] }
//!   dashmap = "6"

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ─── Message Types ────────────────────────────────────────────────────────────
#[derive(Debug, Clone)]
pub struct KafkaEvent {
    pub event_type: String,
    pub source: String,
    pub timestamp: u64,
    pub trace_id: String,
    pub payload: serde_json::Value,
}

impl KafkaEvent {
    pub fn from_json(raw: &str) -> Result<Self, serde_json::Error> {
        let v: serde_json::Value = serde_json::from_str(raw)?;
        Ok(KafkaEvent {
            event_type: v["event_type"].as_str().unwrap_or("unknown").to_string(),
            source: v["source"].as_str().unwrap_or("").to_string(),
            timestamp: v["timestamp"].as_u64().unwrap_or(0),
            trace_id: v["trace_id"].as_str().unwrap_or("").to_string(),
            payload: v["payload"].clone(),
        })
    }
}

// ─── Deduplication Cache ──────────────────────────────────────────────────────
/// In-memory dedup cache with TTL. In production, back with Redis SETNX.
pub struct DeduplicationCache {
    seen: Arc<dashmap::DashMap<String, u64>>,
    ttl_secs: u64,
}

impl DeduplicationCache {
    pub fn new(ttl_secs: u64) -> Self {
        Self {
            seen: Arc::new(dashmap::DashMap::new()),
            ttl_secs,
        }
    }

    pub fn is_duplicate(&self, key: &str) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Evict expired entries
        self.seen.retain(|_, ts| now - *ts < self.ttl_secs);

        if self.seen.contains_key(key) {
            return true;
        }
        self.seen.insert(key.to_string(), now);
        false
    }
}

// ─── Message Router ───────────────────────────────────────────────────────────
/// Routes events to appropriate downstream handlers based on event_type.
pub struct MessageRouter {
    routes: HashMap<String, Box<dyn Fn(&KafkaEvent) + Send + Sync>>,
}

impl MessageRouter {
    pub fn new() -> Self {
        Self {
            routes: HashMap::new(),
        }
    }

    pub fn register<F>(&mut self, event_type: &str, handler: F)
    where
        F: Fn(&KafkaEvent) + Send + Sync + 'static,
    {
        self.routes.insert(event_type.to_string(), Box::new(handler));
    }

    pub fn route(&self, event: &KafkaEvent) {
        if let Some(handler) = self.routes.get(&event.event_type) {
            handler(event);
        } else if let Some(handler) = self.routes.get("*") {
            handler(event);
        } else {
            eprintln!("[router] No handler for event_type: {}", event.event_type);
        }
    }
}

// ─── Processor ────────────────────────────────────────────────────────────────
pub struct MessageProcessor {
    dedup: DeduplicationCache,
    router: MessageRouter,
    dlq: Vec<String>,  // Dead-letter queue (in production: Kafka DLQ topic)
}

impl MessageProcessor {
    pub fn new() -> Self {
        let mut router = MessageRouter::new();

        // Register handlers
        router.register("wa.message.received", |event| {
            println!("[processor] Inbound WA message: trace_id={}", event.trace_id);
            // In production: write to DB, trigger AI agent, update conversation state
        });

        router.register("wa.message.status", |event| {
            println!("[processor] Message status update: trace_id={}", event.trace_id);
            // In production: update message delivery status in DB
        });

        router.register("kyc.events", |event| {
            println!("[processor] KYC event: type={} trace={}", event.event_type, event.trace_id);
            // In production: update KYC application status, trigger Temporal workflow
        });

        router.register("orders.created", |event| {
            println!("[processor] Order created: trace_id={}", event.trace_id);
            // In production: trigger inventory reservation, payment processing
        });

        router.register("inventory.sync", |event| {
            println!("[processor] Inventory sync: trace_id={}", event.trace_id);
            // In production: update stock levels, check low-stock thresholds
        });

        router.register("*", |event| {
            println!("[processor] Unrouted event: type={}", event.event_type);
        });

        Self {
            dedup: DeduplicationCache::new(300), // 5-minute dedup window
            router,
            dlq: Vec::new(),
        }
    }

    pub fn process(&mut self, raw_message: &str) {
        match KafkaEvent::from_json(raw_message) {
            Ok(event) => {
                // Deduplicate by trace_id
                if self.dedup.is_duplicate(&event.trace_id) {
                    println!("[processor] Duplicate event skipped: {}", event.trace_id);
                    return;
                }
                self.router.route(&event);
            }
            Err(e) => {
                eprintln!("[processor] Parse error: {} — sending to DLQ", e);
                self.dlq.push(raw_message.to_string());
            }
        }
    }

    pub fn dlq_size(&self) -> usize {
        self.dlq.len()
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
fn main() {
    println!("WhatsApp Commerce — Rust Message Processor v1.0.0");
    println!("Kafka brokers: {}", std::env::var("KAFKA_BROKERS").unwrap_or("localhost:9092".to_string()));

    let mut processor = MessageProcessor::new();

    // Simulate processing (in production: rdkafka consumer loop)
    let test_events = vec![
        r#"{"event_type":"wa.message.received","source":"gateway","timestamp":1720000000,"trace_id":"test-001","payload":{"from":"2348001234567","text":{"body":"Hello"}}}"#,
        r#"{"event_type":"wa.message.received","source":"gateway","timestamp":1720000001,"trace_id":"test-001","payload":{}}"#, // duplicate
        r#"{"event_type":"orders.created","source":"node-app","timestamp":1720000002,"trace_id":"order-001","payload":{"orderId":"ord-123"}}"#,
        r#"{"event_type":"kyc.events","source":"kyc-verifier","timestamp":1720000003,"trace_id":"kyc-001","payload":{"applicationId":"app-001","isAuthentic":true}}"#,
    ];

    for msg in test_events {
        processor.process(msg);
    }

    println!("DLQ size: {}", processor.dlq_size());
    println!("Processor ready. In production, start rdkafka consumer loop here.");
}

// ─── Tests ────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deduplication() {
        let cache = DeduplicationCache::new(300);
        assert!(!cache.is_duplicate("event-001"));
        assert!(cache.is_duplicate("event-001"));
        assert!(!cache.is_duplicate("event-002"));
    }

    #[test]
    fn test_event_parsing() {
        let raw = r#"{"event_type":"wa.message.received","source":"gateway","timestamp":1720000000,"trace_id":"test","payload":{}}"#;
        let event = KafkaEvent::from_json(raw).unwrap();
        assert_eq!(event.event_type, "wa.message.received");
        assert_eq!(event.trace_id, "test");
    }

    #[test]
    fn test_processor_dlq() {
        let mut processor = MessageProcessor::new();
        processor.process("invalid json {{{");
        assert_eq!(processor.dlq_size(), 1);
    }
}

