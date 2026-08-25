#!/usr/bin/env python3
"""Derive 0111/0112 snapshots from the 0110 chain tip + W33 Coder A changes
(supplier_tax_profiles, annual_statements tables). Append-only; mirrors
gen_w32b_snapshots.py. Journal entries idx 111/112 appended to _journal.json."""
import json, uuid, os

BASE = os.path.join(os.path.dirname(__file__), "..", "drizzle", "meta")
snap110 = json.load(open(os.path.join(BASE, "0110_fx_quotes_snapshot.json")))

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

def expr_idx(name, cols, unique=False):
    return {"name": name,
            "columns": [{"expression": c, "isExpression": is_expr, "asc": True, "nulls": "last"}
                        for c, is_expr in cols],
            "isUnique": unique, "concurrently": False, "method": "btree", "with": {}}

def table(name, columns, indexes=None):
    return {"name": name, "schema": "", "columns": columns,
            "indexes": {i["name"]: i for i in (indexes or [])},
            "foreignKeys": {},
            "compositePrimaryKeys": {},
            "uniqueConstraints": {},
            "policies": {}, "checkConstraints": {}, "isRLSEnabled": False}

supplier_tax_profiles = table("supplier_tax_profiles", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "supplier_tenant_id": V("supplier_tenant_id", 36, notNull=False),
    "vendor_name": V("vendor_name", 160),
    "vendor_ref": V("vendor_ref", 128, notNull=False),
    "tax_id": V("tax_id", 64, notNull=False),
    "tax_id_type": V("tax_id_type", 16, notNull=False),
    "country_code": col("country_code", "char(2)", notNull=False),
    "withholding_bps": I("withholding_bps", default=0),
    "verified_at": TSZ("verified_at", notNull=False),
    "metadata": J("metadata", notNull=False),
    "created_at": TS("created_at", default=NOW),
    "updated_at": TS("updated_at", default=NOW),
}, indexes=[
    expr_idx("supplier_tax_profiles_tenant_supplier_uniq",
             [("tenant_id", False), ("coalesce(supplier_tenant_id, vendor_ref)", True)], unique=True),
    idx("supplier_tax_profiles_tenant_idx", ["tenant_id", "vendor_name"]),
])

annual_statements = table("annual_statements", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "supplier_tenant_id": V("supplier_tenant_id", 36, notNull=False),
    "vendor_ref": V("vendor_ref", 128, notNull=False),
    "vendor_name": V("vendor_name", 160),
    "year": I("year"),
    "total_paid_cents": BI("total_paid_cents", default=0),
    "payment_count": I("payment_count", default=0),
    "currency": V("currency", 3),
    "withholding_cents": BI("withholding_cents", default=0),
    "status": V("status", 16, default="'generated'::character varying"),
    "pdf_path": V("pdf_path", 256, notNull=False),
    "wa_message_id": V("wa_message_id", 128, notNull=False),
    "generated_at": TS("generated_at", default=NOW),
    "sent_at": TS("sent_at", notNull=False),
    "created_at": TS("created_at", default=NOW),
    "updated_at": TS("updated_at", default=NOW),
}, indexes=[
    expr_idx("annual_statements_tenant_supplier_year_uniq",
             [("tenant_id", False), ("coalesce(supplier_tenant_id, vendor_ref)", True),
              ("year", False), ("currency", False)], unique=True),
    idx("annual_statements_tenant_year_idx", ["tenant_id", "year"]),
])

def write(prev_snap, tag, prev_id, mutate):
    s = json.loads(json.dumps(prev_snap))
    s["prevId"] = prev_id
    s["id"] = str(uuid.uuid4())
    mutate(s)
    out = os.path.join(BASE, f"{tag}_snapshot.json")
    json.dump(s, open(out, "w"), indent=2)
    return s["id"]

id111 = write(snap110, "0111_supplier_tax_profiles", snap110["id"],
              lambda s: s["tables"].update({"public.supplier_tax_profiles": supplier_tax_profiles}))

snap111 = json.load(open(os.path.join(BASE, "0111_supplier_tax_profiles_snapshot.json")))
id112 = write(snap111, "0112_annual_statements", snap111["id"],
              lambda s: s["tables"].update({"public.annual_statements": annual_statements}))

journal = json.load(open(os.path.join(BASE, "_journal.json")))
assert journal["entries"][-1]["idx"] == 110, f"journal tip is {journal['entries'][-1]['idx']}, expected 110"
journal["entries"].append({"idx": 111, "version": "7", "when": 1787600111000,
                           "tag": "0111_supplier_tax_profiles", "breakpoints": True})
journal["entries"].append({"idx": 112, "version": "7", "when": 1787600112000,
                           "tag": "0112_annual_statements", "breakpoints": True})
json.dump(journal, open(os.path.join(BASE, "_journal.json"), "w"), indent=2)
print("0111 id", id111)
print("0112 id", id112)
print("journal entries", len(journal["entries"]))
