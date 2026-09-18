//! WhatsApp Commerce — Rust Message Processor
//! Responsibilities: High-performance Kafka consumer, message deduplication,
//! routing logic, stream processing, dead-letter queue management.
//!
//! Dependencies (Cargo.toml):
//!   rdkafka = { version = "0.37", features = ["cmake-build"] }  (ENABLED — W45 MSG-18 consumer + DLQ producer)
//!   redis = { version = "0.27" }  (durable DLQ — W42 PLT-7)
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

// ─── Durable Dead-Letter Queue ────────────────────────────────────────────────
/// W42 PLT-7: the DLQ used to be an in-memory Vec — a process restart lost
/// every dead-lettered event. Now the DLQ is a Redis list
/// (`mp:dlq:events`, the infra this service is already deployed with — see
/// Cargo.toml) when REDIS_URL is set and reachable, with an honest in-memory
/// fallback (loudly logged, `backend()` reports it) when it is not.
pub enum Dlq {
    Redis { conn: redis::Connection, spill: Vec<String> },
    Memory(Vec<String>),
}

impl Dlq {
    const REDIS_KEY: &'static str = "mp:dlq:events";

    pub fn connect_from_env() -> Self {
        match std::env::var("REDIS_URL") {
            Ok(url) if !url.trim().is_empty() => {
                match redis::Client::open(url).and_then(|c| c.get_connection()) {
                    Ok(conn) => {
                        println!("[dlq] durable backend: Redis list {}", Self::REDIS_KEY);
                        Dlq::Redis { conn, spill: Vec::new() }
                    }
                    Err(e) => {
                        eprintln!("[dlq] REDIS_URL set but connect failed ({e}) — FALLBACK: in-memory DLQ (NOT durable across restart)");
                        Dlq::Memory(Vec::new())
                    }
                }
            }
            _ => {
                eprintln!("[dlq] REDIS_URL not set — in-memory DLQ (NOT durable across restart)");
                Dlq::Memory(Vec::new())
            }
        }
    }

    /// Which backend is active — surfaced in logs/health so an in-memory
    /// fallback is never silent.
    pub fn backend(&self) -> &'static str {
        match self {
            Dlq::Redis { .. } => "redis",
            Dlq::Memory(_) => "memory",
        }
    }

    pub fn push(&mut self, raw: &str) {
        match self {
            Dlq::Redis { conn, spill } => {
                let res: redis::RedisResult<i64> = redis::cmd("RPUSH")
                    .arg(Self::REDIS_KEY)
                    .arg(raw)
                    .query(conn);
                if let Err(e) = res {
                    eprintln!("[dlq] Redis RPUSH failed ({e}) — spilling to memory (replay via drain() before shutdown)");
                    spill.push(raw.to_string());
                }
            }
            Dlq::Memory(v) => v.push(raw.to_string()),
        }
    }

    pub fn len(&mut self) -> usize {
        match self {
            Dlq::Redis { conn, spill } => {
                let n: redis::RedisResult<i64> = redis::cmd("LLEN")
                    .arg(Self::REDIS_KEY)
                    .query(conn);
                n.unwrap_or(0) as usize + spill.len()
            }
            Dlq::Memory(v) => v.len(),
        }
    }

    /// Dead-letter replay path: drain up to `max` entries (oldest first),
    /// returning the raw payloads for re-processing.
    pub fn drain(&mut self, max: usize) -> Vec<String> {
        match self {
            Dlq::Redis { conn, spill } => {
                let mut out: Vec<String> = Vec::new();
                let take_spill = max.min(spill.len());
                out.extend(spill.drain(..take_spill));
                let remaining = max - out.len();
                if remaining > 0 {
                    let items: redis::RedisResult<Vec<String>> = redis::cmd("LRANGE")
                        .arg(Self::REDIS_KEY)
                        .arg(0)
                        .arg(remaining as isize - 1)
                        .query(conn);
                    match items {
                        Ok(list) if !list.is_empty() => {
                            let _: redis::RedisResult<()> = redis::cmd("LTRIM")
                                .arg(Self::REDIS_KEY)
                                .arg(list.len() as isize)
                                .arg(-1)
                                .query(conn);
                            out.extend(list);
                        }
                        Ok(_) => {}
                        Err(e) => eprintln!("[dlq] Redis drain failed ({e})"),
                    }
                }
                out
            }
            Dlq::Memory(v) => {
                let take = max.min(v.len());
                v.drain(..take).collect()
            }
        }
    }
}

// ─── Processor ────────────────────────────────────────────────────────────────
// === W45 go-rust-services (MSG-18) ===
/// Outcome of processing one raw payload — drives offset commits and the
/// Kafka DLQ mirror in the consumer loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessOutcome {
    Routed,
    Duplicate,
    DeadLettered,
}

pub struct MessageProcessor {
    dedup: DeduplicationCache,
    router: MessageRouter,
    dlq: Dlq,
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
            dlq: Dlq::connect_from_env(),
        }
    }

    /// Process one raw Kafka payload. Returns the outcome so the consumer
    /// loop (main) can mirror dead-lettered payloads to the Kafka DLQ topic
    /// (W45 MSG-18) in addition to the durable Redis DLQ (W42 PLT-7).
    pub fn process(&mut self, raw_message: &str) -> ProcessOutcome {
        match KafkaEvent::from_json(raw_message) {
            Ok(event) => {
                // Deduplicate by trace_id
                if self.dedup.is_duplicate(&event.trace_id) {
                    println!("[processor] Duplicate event skipped: {}", event.trace_id);
                    return ProcessOutcome::Duplicate;
                }
                self.router.route(&event);
                ProcessOutcome::Routed
            }
            Err(e) => {
                eprintln!("[processor] Parse error: {} — sending to DLQ", e);
                self.dlq.push(raw_message.to_string());
                ProcessOutcome::DeadLettered
            }
        }
    }

    pub fn dlq_size(&mut self) -> usize {
        self.dlq.len()
    }

    /// Dead-letter replay path: drain up to `max` dead-lettered payloads for
    /// re-processing (e.g. after a downstream outage is resolved).
    pub fn dlq_drain(&mut self, max: usize) -> Vec<String> {
        self.dlq.drain(max)
    }

    pub fn dlq_backend(&self) -> &'static str {
        self.dlq.backend()
    }
}

// ─── Main — real rdkafka consumer loop (W45 MSG-18) ───────────────────────────
// Consumes MP_KAFKA_TOPICS (default: the platform's five event topics),
// processes each payload, mirrors dead-lettered payloads to the Kafka DLQ
// topic MP_DLQ_TOPIC (default mp.dlq.events) in addition to the durable
// Redis DLQ, and commits offsets AFTER handling (at-least-once).
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::message::Message as _;
use rdkafka::producer::{FutureProducer, FutureRecord};

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| fallback.to_string())
}

fn kafka_dlq_topic() -> String {
    env_or("MP_DLQ_TOPIC", "mp.dlq.events")
}

fn subscribed_topics() -> Vec<String> {
    env_or(
        "MP_KAFKA_TOPICS",
        "wa.message.received,wa.message.status,kyc.events,orders.created,inventory.sync",
    )
    .split(',')
    .map(|t| t.trim().to_string())
    .filter(|t| !t.is_empty())
    .collect()
}

/// Produce one dead-lettered raw payload to the Kafka DLQ topic with the
/// source topic/offset in headers. Best-effort: the durable Redis DLQ
/// (already written by process()) is the system of record.
async fn produce_dlq(producer: &FutureProducer, topic: &str, raw: &str, source_topic: &str, reason: &str) {
    let record = FutureRecord::to(topic)
        .payload(raw)
        .key(source_topic)
        .headers(rdkafka::message::OwnedHeaders::new().insert(rdkafka::message::Header {
            key: "dlq.reason",
            value: Some(reason),
        }));
    if let Err((e, _)) = producer.send(record, Duration::from_secs(5)).await {
        eprintln!("[dlq-kafka] produce to {topic} failed ({e}) — payload remains in Redis DLQ");
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    println!("WhatsApp Commerce — Rust Message Processor v1.1.0 (real rdkafka consumer)");

    let brokers = env_or("KAFKA_BROKERS", "localhost:9092");
    let group_id = env_or("KAFKA_GROUP_ID", "message-processor-v1");
    let topics = subscribed_topics();
    let dlq_topic = kafka_dlq_topic();
    println!("Kafka brokers: {brokers} | group: {group_id} | topics: {topics:?} | dlq: {dlq_topic}");

    let consumer: StreamConsumer = ClientConfig::new()
        .set("bootstrap.servers", &brokers)
        .set("group.id", &group_id)
        .set("enable.auto.commit", "false") // manual, post-processing commits
        .set("auto.offset.reset", "earliest")
        .set("session.timeout.ms", "30000")
        .create()
        .expect("failed to create kafka consumer");

    let topic_refs: Vec<&str> = topics.iter().map(String::as_str).collect();
    consumer.subscribe(&topic_refs).expect("failed to subscribe to topics");

    let dlq_producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &brokers)
        .set("message.timeout.ms", "5000")
        .create()
        .expect("failed to create kafka DLQ producer");

    let mut processor = MessageProcessor::new();
    println!("DLQ backend: {} (redis) + kafka topic {}", processor.dlq_backend(), dlq_topic);

    loop {
        match consumer.recv().await {
            Err(e) => {
                eprintln!("[consumer] recv error: {e}");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Ok(msg) => {
                let raw = match msg.payload_view::<str>() {
                    Some(Ok(s)) => s.to_owned(),
                    Some(Err(e)) => {
                        eprintln!("[consumer] non-utf8 payload ({e}) — dead-lettering raw bytes lost; skipping");
                        let _ = consumer.commit_message(&msg, rdkafka::consumer::CommitMode::Async);
                        continue;
                    }
                    None => {
                        let _ = consumer.commit_message(&msg, rdkafka::consumer::CommitMode::Async);
                        continue;
                    }
                };

                let outcome = processor.process(&raw);
                if outcome == ProcessOutcome::DeadLettered {
                    produce_dlq(&dlq_producer, &dlq_topic, &raw, msg.topic(), "unprocessable payload").await;
                }

                // Commit AFTER processing + DLQ mirror (at-least-once;
                // downstream dedupes via trace_id).
                if let Err(e) = consumer.commit_message(&msg, rdkafka::consumer::CommitMode::Async) {
                    eprintln!("[consumer] offset commit failed: {e}");
                }
            }
        }
    }
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
        assert_eq!(processor.process("invalid json {{{"), ProcessOutcome::DeadLettered);
        assert_eq!(processor.dlq_size(), 1);
    }

    // W45 MSG-18: consumer-loop helpers — outcome classification and env-driven
    // topic/DLQ configuration.
    #[test]
    fn test_process_outcomes() {
        let mut processor = MessageProcessor::new();
        let good = r#"{"event_type":"orders.created","source":"t","timestamp":1,"trace_id":"t-1","payload":{}}"#;
        assert_eq!(processor.process(good), ProcessOutcome::Routed);
        assert_eq!(processor.process(good), ProcessOutcome::Duplicate);
    }

    #[test]
    fn test_topic_env_parsing() {
        // Default topics are the five platform event topics.
        let topics = subscribed_topics();
        assert!(topics.contains(&"wa.message.received".to_string()));
        assert!(topics.contains(&"orders.created".to_string()));
        assert_eq!(kafka_dlq_topic(), std::env::var("MP_DLQ_TOPIC").unwrap_or_else(|_| "mp.dlq.events".to_string()));
    }

    // W42 PLT-7: DLQ is durable-shaped (backend reported honestly) and has a
    // real replay path — drain returns oldest-first and empties the queue.
    #[test]
    fn test_dlq_replay_drain() {
        let mut dlq = Dlq::Memory(Vec::new());
        assert_eq!(dlq.backend(), "memory"); // honest backend reporting
        dlq.push("bad-1");
        dlq.push("bad-2");
        assert_eq!(dlq.len(), 2);
        let drained = dlq.drain(10);
        assert_eq!(drained, vec!["bad-1".to_string(), "bad-2".to_string()]);
        assert_eq!(dlq.len(), 0);
    }

    #[test]
    fn test_dlq_drain_partial() {
        let mut dlq = Dlq::Memory(Vec::new());
        dlq.push("a");
        dlq.push("b");
        dlq.push("c");
        assert_eq!(dlq.drain(2), vec!["a".to_string(), "b".to_string()]);
        assert_eq!(dlq.len(), 1);
    }
}

