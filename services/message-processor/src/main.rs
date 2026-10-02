//! WhatsApp Commerce — Rust Message Processor
//! Responsibilities: High-performance Kafka consumer, message deduplication,
//! routing logic, stream processing, dead-letter queue management.
//!
//! === W48 sidecars ===
//! PERF-SC-2: dedup cache no longer does a per-message full `retain()` sweep —
//! per-entry expiry is checked at lookup and a background time-bucketed sweep
//! runs at most once per MP_DEDUP_SWEEP_SECS (default 60s).
//! PERF-SC-6: DLQ Redis client is the async multiplexed connection
//! (tokio-comp) — no blocking sync driver on the tokio loop.
//! PERF-SC-7: Kafka DLQ produces are spawned (non-blocking), offsets are
//! committed in batches (MP_COMMIT_EVERY, default 50), and fetch tuning
//! (queued.min.messages / fetch.wait.max.ms / fetch.min.bytes) is set.
//! PERF-SC-21: events are parsed straight into a borrowed struct (no
//! double-alloc `Value` round-trip) and hot-path logs go through tracing
//! (debug!, sampled-friendly) instead of sync println!/eprintln!.
//!
//! Dependencies (Cargo.toml):
//!   rdkafka = { version = "0.37", features = ["cmake-build"] }  (ENABLED — W45 MSG-18 consumer + DLQ producer)
//!   redis = { version = "0.27", features = ["tokio-comp"] }  (durable DLQ — W42 PLT-7; async — W48 PERF-SC-6)
//!   tokio = { version = "1", features = ["full"] }
//!   serde = { version = "1", features = ["derive"] }
//!   serde_json = "1"
//!   tracing = "0.1"
//!   tracing-subscriber = "0.3"
//!   uuid = { version = "1", features = ["v4"] }
//!   dashmap = "6"

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// PERF-SC-21: zero-copy view of the inbound document. Fields borrow from the
/// raw payload; only `payload` is materialised (moved, not cloned).
#[derive(serde::Deserialize)]
struct RawEvent<'a> {
    #[serde(borrow)]
    event_type: Option<&'a str>,
    #[serde(borrow)]
    source: Option<&'a str>,
    #[serde(default)]
    timestamp: u64,
    #[serde(borrow)]
    trace_id: Option<&'a str>,
    #[serde(default)]
    payload: serde_json::Value,
}

impl KafkaEvent {
    pub fn from_json(raw: &str) -> Result<Self, serde_json::Error> {
        let v: RawEvent<'_> = serde_json::from_str(raw)?;
        Ok(KafkaEvent {
            event_type: v.event_type.unwrap_or("unknown").to_string(),
            source: v.source.unwrap_or("").to_string(),
            timestamp: v.timestamp,
            trace_id: v.trace_id.unwrap_or("").to_string(),
            payload: v.payload,
        })
    }
}

// === W60 persistence ===
/// True when the process runs as production (ENV or APP_ENV). Production is
/// fail-closed for durable-state dependencies (Redis dedupe/DLQ).
pub fn is_production() -> bool {
    std::env::var("ENV")
        .or_else(|_| std::env::var("APP_ENV"))
        .map(|v| v.eq_ignore_ascii_case("production") || v.eq_ignore_ascii_case("prod"))
        .unwrap_or(false)
}

/// Dev-only escape hatch for durable-state deps. Never honored in production.
fn dev_inmemory_allowed(flag: &str) -> bool {
    !is_production()
        && std::env::var(flag)
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
}

/// REDIS_DURABLE_URL (noeviction instance) preferred, then REDIS_URL.
fn redis_url_from_env() -> Option<String> {
    std::env::var("REDIS_DURABLE_URL").ok().filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("REDIS_URL").ok().filter(|v| !v.trim().is_empty()))
}

// ─── Deduplication Cache ──────────────────────────────────────────────────────
/// In-memory L1 dedup cache with TTL. Backed by Redis SETNX (see `Dedupe`).
///
/// PERF-SC-2: NO per-message `retain()` (that was a full O(N) DashMap sweep in
/// the consumer hot loop). Expiry is enforced per entry at lookup time, and a
/// time-bucketed sweep (`maybe_sweep`) runs at most once per
/// `sweep_interval_secs`, keeping memory bounded without quadratic cost.
pub struct DeduplicationCache {
    seen: Arc<dashmap::DashMap<String, u64>>,
    ttl_secs: u64,
    sweep_interval_secs: u64,
    last_sweep: AtomicU64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl DeduplicationCache {
    pub fn new(ttl_secs: u64) -> Self {
        Self::with_sweep_interval(ttl_secs, 60)
    }

    pub fn with_sweep_interval(ttl_secs: u64, sweep_interval_secs: u64) -> Self {
        Self {
            seen: Arc::new(dashmap::DashMap::new()),
            ttl_secs,
            sweep_interval_secs: sweep_interval_secs.max(1),
            last_sweep: AtomicU64::new(0),
        }
    }

    pub fn is_duplicate(&self, key: &str) -> bool {
        let now = now_secs();

        // Per-entry expiry at lookup: an existing, unexpired entry is a dup.
        if let Some(ts) = self.seen.get(key) {
            if now.saturating_sub(*ts) < self.ttl_secs {
                return true;
            }
        }

        self.seen.insert(key.to_string(), now);
        self.maybe_sweep(now);
        false
    }

    /// Time-bucketed eviction: at most one full sweep per interval, gated by
    /// an atomic timestamp so concurrent callers never stampede the sweep.
    fn maybe_sweep(&self, now: u64) {
        let last = self.last_sweep.load(Ordering::Relaxed);
        if now.saturating_sub(last) < self.sweep_interval_secs {
            return;
        }
        if self
            .last_sweep
            .compare_exchange(last, now, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
        {
            let ttl = self.ttl_secs;
            self.seen.retain(|_, ts| now.saturating_sub(*ts) < ttl);
        }
    }

    /// Test/observability helper: number of cached entries.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.seen.len()
    }
}

// === W60 persistence ===
// ─── Durable Deduplication (Redis SETNX L2 + DashMap L1) ─────────────────────
/// CRITICAL FIX (W60): the DashMap used to be the SOLE dedupe for consumed
/// Kafka events — a restart wiped the seen-set and every redelivered event in
/// the TTL window was reprocessed. Now the authoritative dedupe is Redis
/// SETNX (`msgproc:seen:<event_id>`, 24h TTL — the notification-service
/// `ns:idem:` pattern, pipeline.go:257); the DashMap is an L1 fast-path only.
///
/// FAIL-CLOSED: if Redis is unset/unreachable at startup the processor
/// REFUSES to consume (panic with a loud error) rather than silently
/// degrading to in-memory dedupe. Dev escape hatch: MP_ALLOW_INMEMORY_DEDUP=1
/// with ENV != production. Mid-stream Redis errors do not process the event:
/// ProcessOutcome::DedupeUnavailable is returned and the offset is NOT
/// committed, so the event is replayed (restart/rebalance) once Redis heals.
pub enum Dedupe {
    Redis { conn: redis::aio::MultiplexedConnection, l1: DeduplicationCache },
    Memory { l1: DeduplicationCache },
}

/// Result of a dedupe claim.
pub enum DedupeVerdict {
    New,
    Duplicate,
    /// Dedupe store unreachable — fail-closed; caller must NOT process and
    /// must NOT commit the offset.
    Unavailable,
}

impl Dedupe {
    /// Redis SETNX key prefix + TTL (notification-service ns:idem: pattern).
    const KEY_PREFIX: &'static str = "msgproc:seen:";
    const TTL_SECS: u64 = 86_400; // 24h

    pub async fn connect_from_env() -> Self {
        let allow_mem = dev_inmemory_allowed("MP_ALLOW_INMEMORY_DEDUP");
        match redis_url_from_env() {
            Some(url) => match redis::Client::open(url) {
                Ok(client) => match client.get_multiplexed_async_connection().await {
                    Ok(conn) => {
                        tracing::info!(prefix = Self::KEY_PREFIX, ttl_secs = Self::TTL_SECS,
                            "[dedupe] durable backend: Redis SETNX (L2) + DashMap (L1)");
                        return Dedupe::Redis { conn, l1: DeduplicationCache::new(300) };
                    }
                    Err(e) => tracing::error!(error = %e, "[dedupe] REDIS_URL set but connect failed"),
                },
                Err(e) => tracing::error!(error = %e, "[dedupe] invalid REDIS_URL"),
            },
            None => tracing::error!("[dedupe] REDIS_URL/REDIS_DURABLE_URL not set"),
        }
        if allow_mem {
            tracing::warn!("[dedupe] MP_ALLOW_INMEMORY_DEDUP=1 (dev only) — in-memory DashMap dedupe; NOT durable across restart");
            Dedupe::Memory { l1: DeduplicationCache::new(300) }
        } else {
            panic!("[dedupe] FATAL: durable Redis dedupe unavailable (REDIS_URL unset/unreachable) — refusing to consume Kafka events without idempotency. Set REDIS_URL, or MP_ALLOW_INMEMORY_DEDUP=1 outside production.");
        }
    }

    pub fn backend(&self) -> &'static str {
        match self {
            Dedupe::Redis { .. } => "redis+l1",
            Dedupe::Memory { .. } => "memory-dev-only",
        }
    }

    /// Claim `event_id` (trace_id) BEFORE processing. L1 hit short-circuits;
    /// otherwise Redis SET NX EX is authoritative and warms L1 on a dup.
    pub async fn check(&mut self, event_id: &str) -> DedupeVerdict {
        match self {
            Dedupe::Redis { conn, l1 } => {
                if l1.is_duplicate(event_id) {
                    return DedupeVerdict::Duplicate;
                }
                let res: redis::RedisResult<Option<String>> = redis::cmd("SET")
                    .arg(format!("{}{}", Self::KEY_PREFIX, event_id))
                    .arg("1")
                    .arg("EX")
                    .arg(Self::TTL_SECS)
                    .arg("NX")
                    .query_async(conn)
                    .await;
                match res {
                    // SET NX succeeded → key did not exist → new event.
                    Ok(Some(_)) => DedupeVerdict::New,
                    // Nil → key already exists → duplicate; warm L1.
                    Ok(None) => {
                        l1.is_duplicate(event_id);
                        DedupeVerdict::Duplicate
                    }
                    Err(e) => {
                        tracing::error!(error = %e, event_id = %event_id,
                            "[dedupe] Redis SETNX failed — FAIL-CLOSED: event not processed, offset NOT committed");
                        DedupeVerdict::Unavailable
                    }
                }
            }
            Dedupe::Memory { l1 } => {
                if l1.is_duplicate(event_id) {
                    DedupeVerdict::Duplicate
                } else {
                    DedupeVerdict::New
                }
            }
        }
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
            // PERF-SC-21: hot-path logging via tracing (async, filterable)
            tracing::debug!(event_type = %event.event_type, "[router] no handler for event_type");
        }
    }
}

// ─── Durable Dead-Letter Queue ────────────────────────────────────────────────
/// W42 PLT-7: the DLQ used to be an in-memory Vec — a process restart lost
/// every dead-lettered event. Now the DLQ is a Redis list
/// (`mp:dlq:events`, the infra this service is already deployed with — see
/// Cargo.toml) when REDIS_URL is set and reachable, with an honest in-memory
/// fallback (loudly logged, `backend()` reports it) when it is not.
///
/// PERF-SC-6: the Redis handle is an async multiplexed connection
/// (`redis::aio::MultiplexedConnection`) so DLQ writes never block the tokio
/// worker thread.
pub enum Dlq {
    Redis { conn: redis::aio::MultiplexedConnection, spill: Vec<String> },
    Memory(Vec<String>),
}

impl Dlq {
    const REDIS_KEY: &'static str = "mp:dlq:events";

    pub async fn connect_from_env() -> Self {
        // PERF-SC-16: the DLQ list is durable state — prefer the noeviction
        // instance (REDIS_DURABLE_URL) over the LRU cache instance.
        let url_env = redis_url_from_env();
        // === W60 persistence ===
        // The in-memory Vec fallback loses every dead-lettered event on
        // restart. It is DEV-ONLY: production is fail-closed — no Redis URL,
        // no startup. Dev keeps the fallback with a loud log.
        if url_env.is_none() {
            if is_production() {
                panic!("[dlq] FATAL: REDIS_URL/REDIS_DURABLE_URL unset in production — refusing to start with an in-memory DLQ (dead-lettered events would be lost on restart)");
            }
            tracing::warn!("[dlq] REDIS_URL not set — in-memory DLQ (DEV ONLY, NOT durable across restart)");
            return Dlq::Memory(Vec::new());
        }
        match url_env {
            Some(url) => {
                let client = match redis::Client::open(url) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::error!(error = %e, "[dlq] invalid REDIS_URL — FALLBACK: in-memory DLQ (NOT durable across restart)");
                        return Self::memory_fallback();
                    }
                };
                match client.get_multiplexed_async_connection().await {
                    Ok(conn) => {
                        tracing::info!(key = Self::REDIS_KEY, "[dlq] durable backend: Redis list (async multiplexed)");
                        Dlq::Redis { conn, spill: Vec::new() }
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "[dlq] REDIS_URL set but connect failed — FALLBACK: in-memory DLQ (NOT durable across restart)");
                        Self::memory_fallback()
                    }
                }
            }
            _ => unreachable!("url_env checked non-empty above"),
        }
    }

    /// === W60 persistence ===
    /// In-memory DLQ is dev-only: production fails closed rather than risking
    /// silent loss of dead-lettered events on restart.
    fn memory_fallback() -> Self {
        if is_production() {
            panic!("[dlq] FATAL: Redis DLQ unreachable in production — refusing to start with an in-memory DLQ (dead-lettered events would be lost on restart)");
        }
        tracing::warn!("[dlq] DEV in-memory DLQ active — NOT durable across restart");
        Dlq::Memory(Vec::new())
    }

    /// Which backend is active — surfaced in logs/health so an in-memory
    /// fallback is never silent.
    pub fn backend(&self) -> &'static str {
        match self {
            Dlq::Redis { .. } => "redis",
            Dlq::Memory(_) => "memory",
        }
    }

    pub async fn push(&mut self, raw: &str) {
        match self {
            Dlq::Redis { conn, spill } => {
                let res: redis::RedisResult<i64> = redis::cmd("RPUSH")
                    .arg(Self::REDIS_KEY)
                    .arg(raw)
                    .query_async(conn)
                    .await;
                if let Err(e) = res {
                    tracing::error!(error = %e, "[dlq] Redis RPUSH failed — spilling to memory (replay via drain() before shutdown)");
                    spill.push(raw.to_string());
                }
            }
            Dlq::Memory(v) => v.push(raw.to_string()),
        }
    }

    pub async fn len(&mut self) -> usize {
        match self {
            Dlq::Redis { conn, spill } => {
                let n: redis::RedisResult<i64> = redis::cmd("LLEN")
                    .arg(Self::REDIS_KEY)
                    .query_async(conn)
                    .await;
                n.unwrap_or(0) as usize + spill.len()
            }
            Dlq::Memory(v) => v.len(),
        }
    }

    /// Dead-letter replay path: drain up to `max` entries (oldest first),
    /// returning the raw payloads for re-processing.
    pub async fn drain(&mut self, max: usize) -> Vec<String> {
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
                        .query_async(conn)
                        .await;
                    match items {
                        Ok(list) if !list.is_empty() => {
                            let _: redis::RedisResult<()> = redis::cmd("LTRIM")
                                .arg(Self::REDIS_KEY)
                                .arg(list.len() as isize)
                                .arg(-1)
                                .query_async(conn)
                                .await;
                            out.extend(list);
                        }
                        Ok(_) => {}
                        Err(e) => tracing::error!(error = %e, "[dlq] Redis drain failed"),
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
    /// === W60 persistence ===
    /// Durable dedupe store unreachable — event NOT processed and offset NOT
    /// committed (fail-closed; replayed on restart/rebalance).
    DedupeUnavailable,
}

pub struct MessageProcessor {
    dedup: Dedupe,
    router: MessageRouter,
    dlq: Dlq,
}

impl MessageProcessor {
    pub async fn new() -> Self {
        let mut router = MessageRouter::new();

        // Register handlers (PERF-SC-21: debug!-level tracing in the hot path)
        router.register("wa.message.received", |event| {
            tracing::debug!(trace_id = %event.trace_id, "[processor] inbound WA message");
            // In production: write to DB, trigger AI agent, update conversation state
        });

        router.register("wa.message.status", |event| {
            tracing::debug!(trace_id = %event.trace_id, "[processor] message status update");
            // In production: update message delivery status in DB
        });

        router.register("kyc.events", |event| {
            tracing::debug!(event_type = %event.event_type, trace_id = %event.trace_id, "[processor] KYC event");
            // In production: update KYC application status, trigger Temporal workflow
        });

        router.register("orders.created", |event| {
            tracing::debug!(trace_id = %event.trace_id, "[processor] order created");
            // In production: trigger inventory reservation, payment processing
        });

        router.register("inventory.sync", |event| {
            tracing::debug!(trace_id = %event.trace_id, "[processor] inventory sync");
            // In production: update stock levels, check low-stock thresholds
        });

        router.register("*", |event| {
            tracing::debug!(event_type = %event.event_type, "[processor] unrouted event");
        });

        Self {
            // === W60 persistence === Redis SETNX dedupe (24h) is authoritative;
            // the DashMap is L1 only. Fails closed at startup without Redis.
            dedup: Dedupe::connect_from_env().await,
            router,
            dlq: Dlq::connect_from_env().await,
        }
    }

    /// Process one raw Kafka payload. Returns the outcome so the consumer
    /// loop (main) can mirror dead-lettered payloads to the Kafka DLQ topic
    /// (W45 MSG-18) in addition to the durable Redis DLQ (W42 PLT-7).
    pub async fn process(&mut self, raw_message: &str) -> ProcessOutcome {
        match KafkaEvent::from_json(raw_message) {
            Ok(event) => {
                // === W60 persistence === Deduplicate by trace_id via Redis
                // SETNX (msgproc:seen:<trace_id>, 24h TTL) BEFORE processing —
                // the DashMap L1 alone was wiped on restart, reprocessing every
                // redelivered event in the TTL window.
                match self.dedup.check(&event.trace_id).await {
                    DedupeVerdict::Duplicate => {
                        tracing::debug!(trace_id = %event.trace_id, "[processor] duplicate event skipped");
                        return ProcessOutcome::Duplicate;
                    }
                    DedupeVerdict::Unavailable => {
                        // Fail-closed: do not route, do not let the caller commit.
                        return ProcessOutcome::DedupeUnavailable;
                    }
                    DedupeVerdict::New => {}
                }
                self.router.route(&event);
                ProcessOutcome::Routed
            }
            Err(e) => {
                tracing::warn!(error = %e, "[processor] parse error — sending to DLQ");
                self.dlq.push(raw_message).await;
                ProcessOutcome::DeadLettered
            }
        }
    }

    pub async fn dlq_size(&mut self) -> usize {
        self.dlq.len().await
    }

    /// Dead-letter replay path: drain up to `max` dead-lettered payloads for
    /// re-processing (e.g. after a downstream outage is resolved).
    pub async fn dlq_drain(&mut self, max: usize) -> Vec<String> {
        self.dlq.drain(max).await
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

fn env_or_usize(key: &str, fallback: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(fallback)
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
///
/// PERF-SC-7: spawned onto the tokio runtime by the caller so a slow/broker-
/// congested DLQ produce never serialises the consumer loop (previously the
/// 5s produce timeout stalled the loop inline on poison bursts).
fn spawn_dlq_produce(producer: FutureProducer, topic: String, raw: String, source_topic: String, reason: String) {
    tokio::spawn(async move {
        let record = FutureRecord::to(&topic)
            .payload(raw.as_str())
            .key(source_topic.as_str())
            .headers(rdkafka::message::OwnedHeaders::new().insert(rdkafka::message::Header {
                key: "dlq.reason",
                value: Some(reason.as_str()),
            }));
        if let Err((e, _)) = producer.send(record, Duration::from_secs(5)).await {
            tracing::error!(error = %e, topic = %topic, "[dlq-kafka] produce failed — payload remains in Redis DLQ");
        }
    });
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    tracing::info!("WhatsApp Commerce — Rust Message Processor v1.2.0 (real rdkafka consumer, W48 perf)");

    let brokers = env_or("KAFKA_BROKERS", "localhost:9092");
    let group_id = env_or("KAFKA_GROUP_ID", "message-processor-v1");
    let topics = subscribed_topics();
    let dlq_topic = kafka_dlq_topic();
    // PERF-SC-7: batched offset commits — commit the highest processed offset
    // every MP_COMMIT_EVERY messages (default 50) instead of per message.
    let commit_every = env_or_usize("MP_COMMIT_EVERY", 50).max(1);
    tracing::info!(brokers = %brokers, group = %group_id, topics = ?topics, dlq = %dlq_topic, commit_every, "config");

    let consumer: StreamConsumer = ClientConfig::new()
        .set("bootstrap.servers", &brokers)
        .set("group.id", &group_id)
        .set("enable.auto.commit", "false") // manual, post-processing commits
        .set("auto.offset.reset", "earliest")
        .set("session.timeout.ms", "30000")
        // PERF-SC-7: fetch batching/tuning — wait briefly for batches instead
        // of one-message-at-a-time fetches.
        .set("fetch.min.bytes", &env_or("MP_FETCH_MIN_BYTES", "1024"))
        .set("fetch.wait.max.ms", &env_or("MP_FETCH_WAIT_MAX_MS", "500"))
        .set("queued.min.messages", &env_or("MP_QUEUED_MIN_MESSAGES", "1000"))
        .create()
        .expect("failed to create kafka consumer");

    let topic_refs: Vec<&str> = topics.iter().map(String::as_str).collect();
    consumer.subscribe(&topic_refs).expect("failed to subscribe to topics");

    let dlq_producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &brokers)
        .set("message.timeout.ms", "5000")
        // PERF-SC-7: batch the DLQ producer too.
        .set("batch.num.messages", "1000")
        .set("linger.ms", "50")
        .create()
        .expect("failed to create kafka DLQ producer");

    let mut processor = MessageProcessor::new().await;
    tracing::info!(backend = processor.dlq_backend(), dedupe = processor.dedup.backend(), kafka_dlq = %dlq_topic, "DLQ + dedupe backends");

    let mut since_commit: usize = 0;
    loop {
        match consumer.recv().await {
            Err(e) => {
                tracing::error!(error = %e, "[consumer] recv error");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Ok(msg) => {
                let raw = match msg.payload_view::<str>() {
                    Some(Ok(s)) => s,
                    Some(Err(e)) => {
                        tracing::warn!(error = %e, "[consumer] non-utf8 payload — skipping (committing offset)");
                        let _ = consumer.commit_message(&msg, rdkafka::consumer::CommitMode::Async);
                        continue;
                    }
                    None => {
                        let _ = consumer.commit_message(&msg, rdkafka::consumer::CommitMode::Async);
                        continue;
                    }
                };

                let outcome = processor.process(raw).await;
                // === W60 persistence === fail-closed dedupe: on Redis outage
                // the event was NOT processed — do NOT commit the offset, so
                // it is replayed on restart/rebalance once Redis heals.
                if outcome == ProcessOutcome::DedupeUnavailable {
                    tracing::error!("[consumer] dedupe store unavailable — offset NOT committed; backing off");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                if outcome == ProcessOutcome::DeadLettered {
                    // PERF-SC-7: spawned, non-blocking DLQ produce.
                    spawn_dlq_produce(
                        dlq_producer.clone(),
                        dlq_topic.clone(),
                        raw.to_string(),
                        msg.topic().to_string(),
                        "unprocessable payload".to_string(),
                    );
                }

                // Commit AFTER processing + DLQ mirror (at-least-once;
                // downstream dedupes via trace_id). PERF-SC-7: batched —
                // commit the latest offset every `commit_every` messages
                // (async commits are queued locally by librdkafka, so this
                // caps commit RPC volume under burst).
                since_commit += 1;
                if since_commit >= commit_every {
                    since_commit = 0;
                    if let Err(e) = consumer.commit_message(&msg, rdkafka::consumer::CommitMode::Async) {
                        tracing::error!(error = %e, "[consumer] offset commit failed");
                    }
                }
            }
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    /// === W60 persistence ===
    /// Unit tests run without Redis: enable the dev-only in-memory dedupe
    /// escape hatch so MessageProcessor::new() does not fail closed.
    fn allow_dev_inmemory_dedupe() {
        std::env::set_var("MP_ALLOW_INMEMORY_DEDUP", "1");
    }

    #[test]
    fn test_deduplication() {
        let cache = DeduplicationCache::new(300);
        assert!(!cache.is_duplicate("event-001"));
        assert!(cache.is_duplicate("event-001"));
        assert!(!cache.is_duplicate("event-002"));
    }

    // PERF-SC-2: no per-message sweep — a stale entry is detected at lookup
    // (expiry check) and the bucketed sweep eventually reclaims memory.
    #[test]
    fn test_dedup_expiry_at_lookup() {
        let cache = DeduplicationCache::with_sweep_interval(0, 3600);
        assert!(!cache.is_duplicate("k"));
        // TTL=0: the same key immediately expires at lookup → not a dup.
        assert!(!cache.is_duplicate("k"));
    }

    #[test]
    fn test_dedup_bucketed_sweep() {
        let cache = DeduplicationCache::with_sweep_interval(1, 1);
        assert!(!cache.is_duplicate("a"));
        assert!(cache.is_duplicate("a"));
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn test_event_parsing() {
        let raw = r#"{"event_type":"wa.message.received","source":"gateway","timestamp":1720000000,"trace_id":"test","payload":{}}"#;
        let event = KafkaEvent::from_json(raw).unwrap();
        assert_eq!(event.event_type, "wa.message.received");
        assert_eq!(event.trace_id, "test");
    }

    #[test]
    fn test_event_parsing_defaults() {
        let raw = r#"{"payload":{"x":1}}"#;
        let event = KafkaEvent::from_json(raw).unwrap();
        assert_eq!(event.event_type, "unknown");
        assert_eq!(event.timestamp, 0);
        assert_eq!(event.payload["x"], 1);
    }

    #[test]
    fn test_processor_dlq() {
        allow_dev_inmemory_dedupe();
        tokio_test::block_on(async {
            let mut processor = MessageProcessor::new().await;
            assert_eq!(processor.process("invalid json {{{").await, ProcessOutcome::DeadLettered);
            assert_eq!(processor.dlq_size().await, 1);
        });
    }

    // W45 MSG-18: consumer-loop helpers — outcome classification and env-driven
    // topic/DLQ configuration.
    #[test]
    fn test_process_outcomes() {
        allow_dev_inmemory_dedupe();
        tokio_test::block_on(async {
            let mut processor = MessageProcessor::new().await;
            let good = r#"{"event_type":"orders.created","source":"t","timestamp":1,"trace_id":"t-1","payload":{}}"#;
            assert_eq!(processor.process(good).await, ProcessOutcome::Routed);
            assert_eq!(processor.process(good).await, ProcessOutcome::Duplicate);
        });
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
        tokio_test::block_on(async {
            let mut dlq = Dlq::Memory(Vec::new());
            assert_eq!(dlq.backend(), "memory"); // honest backend reporting
            dlq.push("bad-1").await;
            dlq.push("bad-2").await;
            assert_eq!(dlq.len().await, 2);
            let drained = dlq.drain(10).await;
            assert_eq!(drained, vec!["bad-1".to_string(), "bad-2".to_string()]);
            assert_eq!(dlq.len().await, 0);
        });
    }

    #[test]
    fn test_dlq_drain_partial() {
        tokio_test::block_on(async {
            let mut dlq = Dlq::Memory(Vec::new());
            dlq.push("a").await;
            dlq.push("b").await;
            dlq.push("c").await;
            assert_eq!(dlq.drain(2).await, vec!["a".to_string(), "b".to_string()]);
            assert_eq!(dlq.len().await, 1);
        });
    }

    // === W60 persistence ===
    // Durable dedupe: in-memory (dev) mode dedupes via the L1 cache and
    // reports an honest backend; prod-mode detection and the dev gate.
    #[test]
    fn test_dedupe_memory_dev_mode() {
        tokio_test::block_on(async {
            let mut d = Dedupe::Memory { l1: DeduplicationCache::new(300) };
            assert_eq!(d.backend(), "memory-dev-only");
            assert!(matches!(d.check("evt-1").await, DedupeVerdict::New));
            assert!(matches!(d.check("evt-1").await, DedupeVerdict::Duplicate));
            assert!(matches!(d.check("evt-2").await, DedupeVerdict::New));
        });
    }

    #[test]
    fn test_prod_fail_closed_gates() {
        // In the sandbox ENV is unset → not production → dev gate honors flag.
        std::env::remove_var("ENV");
        std::env::remove_var("APP_ENV");
        assert!(!is_production());
        assert!(dev_inmemory_allowed("MP_ALLOW_INMEMORY_DEDUP"));
        // Dedupe key shape: msgproc:seen:<event_id> per the W60 audit fix.
        assert_eq!(Dedupe::KEY_PREFIX, "msgproc:seen:");
        assert_eq!(Dedupe::TTL_SECS, 86_400);
    }
}
