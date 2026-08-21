#!/usr/bin/env python3
"""Derive 0084/0085 snapshots from the 0083 chain tip + Coder A tables only
(merger unions with Coder B and re-chains)."""
import json, uuid, os

BASE = os.path.join(os.path.dirname(__file__), "..", "drizzle", "meta")
snap83 = json.load(open(os.path.join(BASE, "0083_snapshot.json")))

def col(name, type_, pk=False, notNull=True, default=None):
    c = {"name": name, "type": type_, "primaryKey": pk, "notNull": notNull}
    if default is not None:
        c["default"] = default
    return c

UUID = lambda n="id", **kw: col(n, "uuid", **kw)
V = lambda n, l, **kw: col(n, f"varchar({l})", **kw)
I = lambda n, **kw: col(n, "integer", **kw)
TS = lambda n, **kw: col(n, "timestamp", **kw)
TXT = lambda n, **kw: col(n, "text", **kw)
B = lambda n, **kw: col(n, "boolean", **kw)
J = lambda n, **kw: col(n, "jsonb", **kw)
NOW = "now()"
GENUUID = "gen_random_uuid()"

def idx(name, cols, unique=False):
    return {"name": name,
            "columns": [{"expression": c, "isExpression": False, "asc": True, "nulls": "last"} for c in cols],
            "isUnique": unique, "concurrently": False, "method": "btree", "with": {}}

def uniq(name, cols):
    return {"name": name, "nullsNotDistinct": False, "columns": cols}

def table(name, columns, indexes=None, uniques=None):
    return {"name": name, "schema": "", "columns": columns,
            "indexes": {i["name"]: i for i in (indexes or [])},
            "foreignKeys": {},
            "compositePrimaryKeys": {},
            "uniqueConstraints": {u["name"]: u for u in (uniques or [])},
            "policies": {}, "checkConstraints": {}, "isRLSEnabled": False}

odoo_configs = table("odoo_configs", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "url": V("url", 255),
    "db": V("db", 128),
    "username": V("username", 128, notNull=False),
    "api_key": TXT("api_key", notNull=False),
    "sync_mode": V("sync_mode", 16, default="'ondemand'::character varying"),
    "account_mapping": J("account_mapping", notNull=False),
    "enabled": B("enabled", default=False),
    "last_tested_at": TS("last_tested_at", notNull=False),
    "last_test_ok": B("last_test_ok", notNull=False),
    "last_test_error": TXT("last_test_error", notNull=False),
    "created_at": TS("created_at", default=NOW),
    "updated_at": TS("updated_at", default=NOW),
}, uniques=[uniq("odoo_configs_tenant_uniq", ["tenant_id"])])

odoo_sync_outbox = table("odoo_sync_outbox", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "entity_type": V("entity_type", 24),
    "entity_id": V("entity_id", 64),
    "payload": J("payload"),
    "status": V("status", 16, default="'pending'::character varying"),
    "attempts": I("attempts", default=0),
    "max_attempts": I("max_attempts", default=5),
    "last_error": TXT("last_error", notNull=False),
    "odoo_ref": V("odoo_ref", 64, notNull=False),
    "sent_at": TS("sent_at", notNull=False),
    "created_at": TS("created_at", default=NOW),
    "updated_at": TS("updated_at", default=NOW),
}, indexes=[idx("odoo_sync_outbox_status_idx", ["status"]),
            idx("odoo_sync_outbox_tenant_idx", ["tenant_id"])],
   uniques=[uniq("odoo_sync_outbox_entity_uniq", ["tenant_id", "entity_type", "entity_id"])])

def write(prev_snap, tag, new_tables, prev_id):
    s = json.loads(json.dumps(prev_snap))
    s["prevId"] = prev_id
    s["id"] = str(uuid.uuid4())
    s["tables"].update(new_tables)
    out = os.path.join(BASE, f"{tag}_snapshot.json")
    json.dump(s, open(out, "w"), indent=2)
    return s["id"]

id84 = write(snap83, "0084_odoo_configs", {"public.odoo_configs": odoo_configs}, snap83["id"])
snap84 = json.load(open(os.path.join(BASE, "0084_odoo_configs_snapshot.json")))
id85 = write(snap84, "0085_odoo_sync_outbox", {"public.odoo_sync_outbox": odoo_sync_outbox}, snap84["id"])
print("0084 id", id84)
print("0085 id", id85)
