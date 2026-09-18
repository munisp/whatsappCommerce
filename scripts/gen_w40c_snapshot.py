#!/usr/bin/env python3
"""Derive the 0126_messaging_resilience snapshot from the 0122 chain tip
(cumulative: everything through 0122 plus the W40 Coder C additive changes)
and append journal idx 126. Journal idx 123-125 are reserved for Coders
A/B (tenancy/privacy); per SPEC_W40 the merger re-chains A->B->C, so this
snapshot's prevId chains to the 0122 tip on this standalone branch (prevId
is metadata only; the snapshot itself is cumulative). Mirrors
scripts/gen_w33b_snapshot.py. Append-only, idempotent."""
import json, os, uuid

BASE = os.path.join(os.path.dirname(__file__), "..", "drizzle", "meta")
TAG = "0126_messaging_resilience"
snap = json.load(open(os.path.join(BASE, "0122_payment_disputes_snapshot.json")))

# 1. Enum additions (additive).
snap["enums"]["public.template_approval_status"]["values"].append("disabled")
snap["enums"]["public.broadcast_status"]["values"].append("paused")

# 2. broadcast_campaigns additive columns.
cols = snap["tables"]["public.broadcast_campaigns"]["columns"]
cols["pausedReason"] = {
    "name": "pausedReason",
    "type": "varchar(500)",
    "primaryKey": False,
    "notNull": False,
}
cols["pausedAt"] = {
    "name": "pausedAt",
    "type": "timestamp",
    "primaryKey": False,
    "notNull": False,
}

# 3. New snapshot id chained on the 0122 tip.
snap["prevId"] = snap["id"]
snap["id"] = str(uuid.uuid4())

out = os.path.join(BASE, f"{TAG}_snapshot.json")
with open(out, "w") as f:
    json.dump(snap, f, indent=2)

journal_path = os.path.join(BASE, "_journal.json")
journal = json.load(open(journal_path))
if not any(e["tag"] == TAG for e in journal["entries"]):
    journal["entries"].append({
        "idx": 126,
        "version": "7",
        "when": 1787901400000,
        "tag": TAG,
        "breakpoints": True,
    })
    with open(journal_path, "w") as f:
        json.dump(journal, f, indent=2)
print("wrote", out)
