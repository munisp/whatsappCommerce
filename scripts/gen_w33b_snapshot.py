#!/usr/bin/env python3
"""Derive the 0113_cashflow_forecasts snapshot from the 0110 chain tip
(cumulative: every table through 0110 plus cashflow_forecasts) and append
journal idx 113. Journal idx 111-112 are reserved for Coder A (tax-statements,
merger re-chains A->B->C); per SPEC_W33 merger note "Journal idx 111-114
cumulative from 0110 tip", B's 0113 snapshot prevId chains directly to the
0110 tip on this standalone branch — the merger re-chains onto A's 0112 if
needed (prevId is metadata only; the snapshot itself is cumulative).
Mirrors scripts/gen_w32b_snapshots.py. Append-only, idempotent."""
import json, os, uuid

BASE = os.path.join(os.path.dirname(__file__), "..", "drizzle", "meta")
TAG = "0113_cashflow_forecasts"
snap110 = json.load(open(os.path.join(BASE, "0110_fx_quotes_snapshot.json")))

def col(name, type_, pk=False, notNull=True, default=None):
    c = {"name": name, "type": type_, "primaryKey": pk, "notNull": notNull}
    if default is not None:
        c["default"] = default
    return c

cashflow_forecasts = {
    "name": "cashflow_forecasts",
    "schema": "public",
    "columns": {
        "id": col("id", "uuid", pk=True, default="gen_random_uuid()"),
        "tenant_id": col("tenant_id", "varchar(36)"),
        "horizon_days": col("horizon_days", "integer"),
        "generated_at": col("generated_at", "timestamp with time zone", default="now()"),
        "inflow_cents": col("inflow_cents", "bigint"),
        "outflow_cents": col("outflow_cents", "bigint"),
        "net_cents": col("net_cents", "bigint"),
        "currency": col("currency", "varchar(3)", default="'NGN'::character varying"),
        "shortfall_at": col("shortfall_at", "date", notNull=False),
        "detail": col("detail", "jsonb", notNull=False),
    },
    "indexes": {
        "cashflow_forecasts_tenant_idx": {
            "name": "cashflow_forecasts_tenant_idx",
            "columns": [
                {"expression": "tenant_id", "isExpression": False, "asc": True, "nulls": "last"},
                {"expression": "generated_at", "isExpression": False, "asc": True, "nulls": "last"},
            ],
            "isUnique": False, "concurrently": False, "method": "btree", "with": {},
        },
        "cashflow_forecasts_tenant_horizon_day_uniq": {
            "name": "cashflow_forecasts_tenant_horizon_day_uniq",
            "columns": [
                {"expression": "tenant_id", "isExpression": False, "asc": True, "nulls": "last"},
                {"expression": "horizon_days", "isExpression": False, "asc": True, "nulls": "last"},
                {"expression": "((generated_at AT TIME ZONE 'UTC')::date)", "isExpression": True, "asc": True, "nulls": "last"},
            ],
            "isUnique": True, "concurrently": False, "method": "btree", "with": {},
        },
    },
    "foreignKeys": {},
    "compositePrimaryKeys": {},
    "uniqueConstraints": {},
    "policies": {}, "checkConstraints": {}, "isRLSEnabled": False,
}

snap = json.loads(json.dumps(snap110))  # cumulative: full 0110 state
snap["prevId"] = snap110["id"]
snap["id"] = str(uuid.uuid4())
snap["tables"]["public.cashflow_forecasts"] = cashflow_forecasts
out = os.path.join(BASE, f"{TAG}_snapshot.json")
json.dump(snap, open(out, "w"), indent=2)
print("0113 snapshot id", snap["id"], "prevId", snap["prevId"], "tables", len(snap["tables"]))

# Journal idx 113 (append-only; 111/112 reserved for Coder A on this branch).
jpath = os.path.join(BASE, "_journal.json")
j = json.load(open(jpath))
if not any(e["tag"] == TAG for e in j["entries"]):
    j["entries"].append({
        "idx": 113, "version": "7", "when": 1787500600000,
        "tag": TAG, "breakpoints": True,
    })
    json.dump(j, open(jpath, "w"), indent=2)
    print("journal appended idx 113")
else:
    print("journal already has", TAG)
