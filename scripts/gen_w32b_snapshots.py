#!/usr/bin/env python3
"""Derive 0107/0108 snapshots from the 0105 chain tip + W32 Coder B changes
(recurring_rules table; scheduled_payments.speed; escrow_config.instant_payout_fee_bps).
Append-only; mirrors gen_w31a_snapshots.py. NOTE: journal idx 106 is Coder A's
0106 (absent on this standalone branch); 0107's snapshot prevId chains to the
0105 tip per SPEC_W32 — the merger re-chains onto A's snapshot if needed."""
import json, uuid, os

BASE = os.path.join(os.path.dirname(__file__), "..", "drizzle", "meta")
snap105 = json.load(open(os.path.join(BASE, "0105_ar_invoice_payments_snapshot.json")))

def col(name, type_, pk=False, notNull=True, default=None):
    c = {"name": name, "type": type_, "primaryKey": pk, "notNull": notNull}
    if default is not None:
        c["default"] = default
    return c

UUID = lambda n="id", **kw: col(n, "uuid", **kw)
V = lambda n, l, **kw: col(n, f"varchar({l})", **kw)
I = lambda n, **kw: col(n, "integer", **kw)
BI = lambda n, **kw: col(n, "bigint", **kw)
TS = lambda n, **kw: col(n, "timestamp", **kw)
TSZ = lambda n, **kw: col(n, "timestamp with time zone", **kw)
J = lambda n, **kw: col(n, "jsonb", **kw)
NOW = "now()"
GENUUID = "gen_random_uuid()"

def idx(name, cols, unique=False):
    return {"name": name,
            "columns": [{"expression": c, "isExpression": False, "asc": True, "nulls": "last"} for c in cols],
            "isUnique": unique, "concurrently": False, "method": "btree", "with": {}}

def table(name, columns, indexes=None):
    return {"name": name, "schema": "", "columns": columns,
            "indexes": {i["name"]: i for i in (indexes or [])},
            "foreignKeys": {},
            "compositePrimaryKeys": {},
            "uniqueConstraints": {},
            "policies": {}, "checkConstraints": {}, "isRLSEnabled": False}

recurring_rules = table("recurring_rules", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "kind": V("kind", 16),
    "recipient": J("recipient", notNull=False),
    "amount_cents": BI("amount_cents"),
    "currency": V("currency", 3, default="'NGN'::character varying"),
    "cadence": V("cadence", 16),
    "day_of_month": I("day_of_month", notNull=False),
    "auto_pay_under_cents": BI("auto_pay_under_cents", default=0),
    "next_run_at": TSZ("next_run_at"),
    "status": V("status", 16, default="'active'::character varying"),
    "last_run_at": TSZ("last_run_at", notNull=False),
    "created_by": V("created_by", 36, notNull=False),
    "created_at": TS("created_at", default=NOW),
    "updated_at": TS("updated_at", default=NOW),
}, indexes=[idx("recurring_rules_status_next_idx", ["status", "next_run_at"]),
            idx("recurring_rules_tenant_idx", ["tenant_id", "status"])])

def write(prev_snap, tag, prev_id, mutate):
    s = json.loads(json.dumps(prev_snap))
    s["prevId"] = prev_id
    s["id"] = str(uuid.uuid4())
    mutate(s)
    out = os.path.join(BASE, f"{tag}_snapshot.json")
    json.dump(s, open(out, "w"), indent=2)
    return s["id"]

id107 = write(snap105, "0107_recurring_rules", snap105["id"],
              lambda s: s["tables"].update({"public.recurring_rules": recurring_rules}))

snap107 = json.load(open(os.path.join(BASE, "0107_recurring_rules_snapshot.json")))

def mutate108(s):
    s["tables"]["public.scheduled_payments"]["columns"]["speed"] = V(
        "speed", 16, default="'standard'::character varying")
    s["tables"]["public.escrow_config"]["columns"]["instant_payout_fee_bps"] = I(
        "instant_payout_fee_bps", default=50)

id108 = write(snap107, "0108_payout_speed_tiers", snap107["id"], mutate108)
print("0107 id", id107)
print("0108 id", id108)
