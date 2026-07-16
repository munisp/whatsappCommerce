//! Fluvio SmartModule: WhatsApp message deduplication filter
//!
//! Filters out duplicate WhatsApp message IDs to prevent double-processing.
//! Deploy with: fluvio smart-module create wa-dedup --wasm target/wasm32-wasip1/release/wa_dedup.wasm

use fluvio_smartmodule::{smartmodule, SmartModuleRecord, Result};
use std::collections::HashSet;
use std::sync::Mutex;

// In-memory dedup window (last 10k message IDs)
static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);

#[smartmodule(filter)]
pub fn filter(record: &SmartModuleRecord) -> Result<bool> {
    let payload = std::str::from_utf8(record.value.as_ref())?;

    // Parse the message ID from the JSON payload
    let msg_id: String = if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
        v["id"].as_str().unwrap_or("").to_string()
    } else {
        // If we can't parse, let it through
        return Ok(true);
    };

    if msg_id.is_empty() {
        return Ok(true);
    }

    let mut guard = SEEN.lock().unwrap();
    let seen = guard.get_or_insert_with(HashSet::new);

    // Evict oldest entries when window exceeds 10k
    if seen.len() >= 10_000 {
        seen.clear();
    }

    if seen.contains(&msg_id) {
        // Duplicate — filter out
        Ok(false)
    } else {
        seen.insert(msg_id);
        Ok(true)
    }
}
