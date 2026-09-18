#!/usr/bin/env python3
"""W44 merge: re-chain journal 0136..0142 and rebuild CUMULATIVE snapshots
with full column-level union across branches A (0136-0137), B (0138-0139),
C (0140-0142). Each branch chained from the 0135 tip independently, so each
step's snapshot = merged previous snapshot + (branch snapshot − branch prev
snapshot) tables/columns. Verifies the union programmatically at the end.
"""
import json, uuid, subprocess, copy, sys

META = "drizzle/meta"
JOURNAL = f"{META}/_journal.json"
BASE = f"{META}/0135_address_change_requests_snapshot.json"

BRANCH_REFS = {
    "0136_gift_cards": "fb1d017",
    "0137_referrals": "fb1d017",
    "0138_w44_preorders": "0494820f9057fc2268a4678dc0a209635847c4ab",
    "0139_w44_custom_offers": "0494820f9057fc2268a4678dc0a209635847c4ab",
    "0140_service_appointments": "e60e20d922e9f9dd410e3f95b54132d98e58b670",
    "0141_subscriptions": "e60e20d922e9f9dd410e3f95b54132d98e58b670",
    "0142_digital_pins": "e60e20d922e9f9dd410e3f95b54132d98e58b670",
}
BRANCH_PREV = {  # branch-internal previous snapshot tag (branch's own chain)
    "0136_gift_cards": "0135_address_change_requests",
    "0137_referrals": "0136_gift_cards",
    "0138_w44_preorders": "0135_address_change_requests",
    "0139_w44_custom_offers": "0138_w44_preorders",
    "0140_service_appointments": "0135_address_change_requests",
    "0141_subscriptions": "0140_service_appointments",
    "0142_digital_pins": "0141_subscriptions",
}
ORDER = list(BRANCH_REFS.keys())

def git_show(ref, path):
    return subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True).stdout

def load_branch_snap(ref, tag):
    return json.loads(git_show(ref, f"{META}/{tag}_snapshot.json"))

def diff_snap(new, old):
    """Return (added_tables, added_columns) of new vs old."""
    tables = {k: v for k, v in new["tables"].items() if k not in old["tables"]}
    cols = {}
    for tname, t in new["tables"].items():
        if tname in old["tables"]:
            added = {k: v for k, v in t["columns"].items() if k not in old["tables"][tname]["columns"]}
            if added:
                cols[tname] = added
    return tables, cols

def apply(base, tables, cols):
    s = copy.deepcopy(base)
    for k, v in tables.items():
        assert k not in s["tables"], f"table {k} already present"
        s["tables"][k] = copy.deepcopy(v)
    for tname, added in cols.items():
        for k, v in added.items():
            assert k not in s["tables"][tname]["columns"], f"column {tname}.{k} already present"
            s["tables"][tname]["columns"][k] = copy.deepcopy(v)
    return s

snap = json.load(open(BASE))
prev_id = snap["id"]
chain = []  # (tag, id, prevId)
for tag in ORDER:
    ref = BRANCH_REFS[tag]
    branch_new = load_branch_snap(ref, tag)
    branch_old = load_branch_snap(ref, BRANCH_PREV[tag])
    tables, cols = diff_snap(branch_new, branch_old)
    snap = apply(snap, tables, cols)
    new_id = str(uuid.uuid4())
    snap["id"] = new_id
    snap["prevId"] = prev_id
    with open(f"{META}/{tag}_snapshot.json", "w") as f:
        json.dump(snap, f, indent=2)
    chain.append((tag, new_id, prev_id))
    prev_id = new_id
    print(f"{tag}: +{len(tables)} tables, +{sum(len(v) for v in cols.values())} cols -> {new_id[:8]} (prev {chain[-1][2][:8]})")

# Re-chain journal entries 136..142 in ORDER.
j = json.load(open(JOURNAL))
entries = [e for e in j["entries"] if e["idx"] <= 135]
base_when = entries[-1]["when"]
for i, tag in enumerate(ORDER):
    entries.append({"idx": 136 + i, "version": "7", "when": base_when + (i + 1) * 100000, "tag": tag, "breakpoints": True})
with open(JOURNAL, "w") as f:
    json.dump(j, f, indent=2)

# ── Programmatic verification ──
final = json.load(open(f"{META}/0142_digital_pins_snapshot.json"))
expected_tables = [
    "public.gift_cards", "public.gift_card_transactions",  # A 0136
    "public.referral_codes", "public.referral_redemptions",  # A 0137 (verify names below)
    "public.custom_offers",  # B 0139
    "public.service_appointments",  # C 0140
    "public.subscription_plans", "public.customer_subscriptions",  # C 0141
    "public.digital_pin_batches", "public.digital_pins",  # C 0142
]
# Discover actual table names from branch snapshots instead of hard-coding:
all_added = {}
for tag in ORDER:
    ref = BRANCH_REFS[tag]
    bn = load_branch_snap(ref, tag); bo = load_branch_snap(ref, BRANCH_PREV[tag])
    t, c = diff_snap(bn, bo)
    all_added.update(t)
    for tn, cc in c.items():
        all_added.setdefault(tn, {"columns": {}})
        all_added[tn]["columns"].update(cc)
missing = []
for tn, t in all_added.items():
    if tn not in final["tables"] and "columns" not in t:
        missing.append(f"table {tn}")
    if tn in final["tables"]:
        for col in (t.get("columns") or {}):
            if col not in final["tables"][tn]["columns"]:
                missing.append(f"col {tn}.{col}")
    elif "columns" in t:
        missing.append(f"table {tn} (for cols)")
print("union check:", "OK" if not missing else f"MISSING: {missing}")
# Journal chain check
j = json.load(open(JOURNAL))
tags = [e["tag"] for e in j["entries"] if e["idx"] >= 136]
assert tags == ORDER, tags
ids = {t: i for t, i, p in chain}
prevs = {t: p for t, i, p in chain}
ok = True
for k in range(1, len(ORDER)):
    cur = json.load(open(f"{META}/{ORDER[k]}_snapshot.json"))
    prv = json.load(open(f"{META}/{ORDER[k-1]}_snapshot.json"))
    if cur["prevId"] != prv["id"]:
        ok = False; print(f"prevId mismatch at {ORDER[k]}")
first = json.load(open(f"{META}/{ORDER[0]}_snapshot.json"))
print("0136 prevId == 0135 id:", first["prevId"] == json.load(open(BASE))["id"])
print("chain check:", "OK" if ok else "BROKEN")
sys.exit(0 if (not missing and ok) else 1)
