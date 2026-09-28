//! Fluvio SmartModule: WhatsApp message deduplication filter
//!
//! Filters out duplicate WhatsApp message IDs to prevent double-processing.
//! Deploy with: fluvio smart-module create wa-dedup --wasm target/wasm32-wasip1/release/wa_dedup.wasm
//!
//! === W48 sidecars (PERF-SC-26) ===
//! - The message id is extracted with a cheap prefix scan — the old code ran a
//!   FULL serde_json parse of every record inside the WASM filter.
//! - Dedup window eviction is now ring-buffered (oldest 10% evicted when the
//!   window fills) — the old `seen.clear()` at 10k wiped the ENTIRE window,
//!   causing a duplicate burst right after each clear.

use fluvio_smartmodule::{smartmodule, SmartModuleRecord, Result};
use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;

const WINDOW: usize = 10_000;
const EVICT_BATCH: usize = 1_000; // evict oldest 10% when full

// In-memory dedup window (ring: set for membership, deque for FIFO order)
struct DedupWindow {
    set: HashSet<String>,
    order: VecDeque<String>,
}

impl DedupWindow {
    fn new() -> Self {
        Self { set: HashSet::new(), order: VecDeque::new() }
    }

    /// Returns true if the id was already seen (duplicate).
    fn check_and_insert(&mut self, id: &str) -> bool {
        if self.set.contains(id) {
            return true;
        }
        if self.set.len() >= WINDOW {
            // Ring-buffer eviction: drop only the oldest EVICT_BATCH entries.
            for _ in 0..EVICT_BATCH {
                match self.order.pop_front() {
                    Some(old) => { self.set.remove(&old); }
                    None => break,
                }
            }
        }
        let owned = id.to_string();
        self.set.insert(owned.clone());
        self.order.push_back(owned);
        false
    }
}

static SEEN: Mutex<Option<DedupWindow>> = Mutex::new(None);

/// Extract the top-level "id" string field without a full JSON parse.
fn extract_id(payload: &str) -> Option<&str> {
    let idx = payload.find("\"id\"")?;
    let rest = &payload[idx + 4..];
    let colon = rest.find(':')?;
    let after = rest[colon + 1..].trim_start();
    let after = after.strip_prefix('"')?;
    let end = after.find('"')?;
    Some(&after[..end])
}

#[smartmodule(filter)]
pub fn filter(record: &SmartModuleRecord) -> Result<bool> {
    let payload = std::str::from_utf8(record.value.as_ref())?;

    let msg_id = match extract_id(payload) {
        Some(id) if !id.is_empty() => id,
        // Missing/unparseable id — let it through (fail open).
        _ => return Ok(true),
    };

    let mut guard = SEEN.lock().unwrap();
    let seen = guard.get_or_insert_with(DedupWindow::new);

    // Duplicate → filter out; new id → pass.
    Ok(!seen.check_and_insert(msg_id))
}
