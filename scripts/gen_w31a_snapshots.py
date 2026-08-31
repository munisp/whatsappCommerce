#!/usr/bin/env python3
"""Derive 0100/0101 snapshots from the 0099 chain tip + W31 Coder A tables
(vendor_bills, vendor_bill_events). Append-only; mirrors gen_w28a_snapshots.py."""
import json, uuid, os

BASE = os.path.join(os.path.dirname(__file__), "..", "drizzle", "meta")
snap99 = json.load(open(os.path.join(BASE, "0099_loan_open_uniq_include_defaulted_snapshot.json")))

def col(name, type_, pk=False, notNull=True, default=None):
    c = {"name": name, "type": type_, "primaryKey": pk, "notNull": notNull}
    if default is not None:
        c["default"] = default
    return c

UUID = lambda n="id", **kw: col(n, "uuid", **kw)
V = lambda n, l, **kw: col(n, f"varchar({l})", **kw)
I = lambda n, **kw: col(n, "integer", **kw)
BI = lambda n, **kw: col(n, "bigint", **kw)
NUM = lambda n, **kw: col(n, "numeric", **kw)
TS = lambda n, **kw: col(n, "timestamp", **kw)
TXT = lambda n, **kw: col(n, "text", **kw)
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

vendor_bills = table("vendor_bills", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "vendor_name": V("vendor_name", 160),
    "vendor_contact": J("vendor_contact", notNull=False),
    "bill_number": V("bill_number", 64, notNull=False),
    "description": TXT("description", notNull=False),
    "amount_cents": BI("amount_cents"),
    "currency": V("currency", 3, default="'NGN'::character varying"),
    "issue_date": TS("issue_date", notNull=False),
    "due_date": TS("due_date", notNull=False),
    "status": V("status", 16, default="'pending'::character varying"),
    "paid_cents": BI("paid_cents", default=0),
    "capture_source": V("capture_source", 16, default="'manual'::character varying"),
    "capture_media_key": V("capture_media_key", 160, notNull=False),
    "ocr_confidence": NUM("ocr_confidence", notNull=False),
    "ocr_raw": J("ocr_raw", notNull=False),
    "payment_ref": V("payment_ref", 128, notNull=False),
    "approval_id": V("approval_id", 64, notNull=False),
    "odoo_sync_state": V("odoo_sync_state", 16, notNull=False),
    "created_by": V("created_by", 64, notNull=False),
    "created_at": TS("created_at", default=NOW),
    "updated_at": TS("updated_at", default=NOW),
}, indexes=[idx("vendor_bills_tenant_status_idx", ["tenant_id", "status"]),
            idx("vendor_bills_tenant_due_idx", ["tenant_id", "due_date"]),
            idx("vendor_bills_payment_ref_uniq", ["payment_ref"], unique=True)])

vendor_bill_events = table("vendor_bill_events", {
    "id": UUID(pk=True, default=GENUUID),
    "bill_id": UUID("bill_id"),
    "event": V("event", 32),
    "actor": V("actor", 64, notNull=False),
    "metadata": J("metadata", notNull=False),
    "created_at": TS("created_at", default=NOW),
}, indexes=[idx("vendor_bill_events_bill_idx", ["bill_id", "created_at"])])

def write(prev_snap, tag, new_tables, prev_id):
    s = json.loads(json.dumps(prev_snap))
    s["prevId"] = prev_id
    s["id"] = str(uuid.uuid4())
    s["tables"].update(new_tables)
    out = os.path.join(BASE, f"{tag}_snapshot.json")
    json.dump(s, open(out, "w"), indent=2)
    return s["id"]

id100 = write(snap99, "0100_vendor_bills", {"public.vendor_bills": vendor_bills}, snap99["id"])
snap100 = json.load(open(os.path.join(BASE, "0100_vendor_bills_snapshot.json")))
id101 = write(snap100, "0101_vendor_bill_events", {"public.vendor_bill_events": vendor_bill_events}, snap100["id"])
print("0100 id", id100)
print("0101 id", id101)
