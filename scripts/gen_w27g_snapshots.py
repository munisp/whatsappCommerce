#!/usr/bin/env python3
"""Derive 0082/0083 snapshots from 0069 + Coder G tables only (merger unions)."""
import json, uuid, copy, os

BASE = os.path.join(os.path.dirname(__file__), "..", "drizzle", "meta")
snap = json.load(open(os.path.join(BASE, "0069_snapshot.json")))

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

def fk(name, tableFrom, tableTo, colFrom, colTo="id"):
    return {"name": name, "tableFrom": tableFrom, "tableTo": tableTo,
            "columnsFrom": [colFrom], "columnsTo": [colTo],
            "onDelete": "no action", "onUpdate": "no action"}

def uniq(name, cols):
    return {"name": name, "nullsNotDistinct": False, "columns": cols}

def table(name, columns, indexes=None, fks=None, uniques=None):
    return {"name": name, "schema": "", "columns": columns,
            "indexes": {i["name"]: i for i in (indexes or [])},
            "foreignKeys": {f["name"]: f for f in (fks or [])},
            "compositePrimaryKeys": {},
            "uniqueConstraints": {u["name"]: u for u in (uniques or [])},
            "policies": {}, "checkConstraints": {}, "isRLSEnabled": False}

t82 = {}
t82["public.stokvel_circles"] = table("stokvel_circles", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "name": V("name", 160),
    "contribution_amount_cents": I("contribution_amount_cents"),
    "currency": V("currency", 3, default="'NGN'::character varying"),
    "frequency": V("frequency", 16, default="'monthly'::character varying"),
    "status": V("status", 16, default="'active'::character varying"),
    "rotation_index": I("rotation_index", default=0),
    "current_cycle": I("current_cycle", default=1),
    "created_by_phone": V("created_by_phone", 32, notNull=False),
    "created_at": TS("created_at", default=NOW),
    "updated_at": TS("updated_at", default=NOW),
}, indexes=[idx("stokvel_circles_tenant_idx", ["tenant_id"]),
            idx("stokvel_circles_status_idx", ["status"])])
t82["public.stokvel_members"] = table("stokvel_members", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "circle_id": UUID("circle_id"),
    "phone": V("phone", 32),
    "name": V("name", 160, notNull=False),
    "rotation_position": I("rotation_position"),
    "status": V("status", 16, default="'active'::character varying"),
    "joined_at": TS("joined_at", default=NOW),
}, indexes=[idx("stokvel_members_circle_idx", ["circle_id"]),
            idx("stokvel_members_phone_idx", ["tenant_id", "phone"])],
   fks=[fk("stokvel_members_circle_id_stokvel_circles_id_fk", "stokvel_members", "stokvel_circles", "circle_id")],
   uniques=[uniq("stokvel_members_circle_phone_uniq", ["circle_id", "phone"])])
t82["public.stokvel_contributions"] = table("stokvel_contributions", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "circle_id": UUID("circle_id"),
    "cycle": I("cycle"),
    "member_id": UUID("member_id"),
    "phone": V("phone", 32),
    "amount_cents": I("amount_cents"),
    "status": V("status", 16, default="'pending'::character varying"),
    "payment_ref": V("payment_ref", 128, notNull=False),
    "paid_at": TS("paid_at", notNull=False),
    "reminder_count": I("reminder_count", default=0),
    "last_reminder_at": TS("last_reminder_at", notNull=False),
    "created_at": TS("created_at", default=NOW),
}, indexes=[idx("stokvel_contrib_circle_cycle_idx", ["circle_id", "cycle"]),
            idx("stokvel_contrib_status_idx", ["status"])],
   fks=[fk("stokvel_contributions_circle_id_stokvel_circles_id_fk", "stokvel_contributions", "stokvel_circles", "circle_id"),
        fk("stokvel_contributions_member_id_stokvel_members_id_fk", "stokvel_contributions", "stokvel_members", "member_id")],
   uniques=[uniq("stokvel_contrib_circle_cycle_member_uniq", ["circle_id", "cycle", "member_id"])])
t82["public.stokvel_payouts"] = table("stokvel_payouts", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "circle_id": UUID("circle_id"),
    "cycle": I("cycle"),
    "member_id": UUID("member_id"),
    "phone": V("phone", 32),
    "amount_cents": I("amount_cents"),
    "status": V("status", 16, default="'pending'::character varying"),
    "paid_at": TS("paid_at", notNull=False),
    "created_at": TS("created_at", default=NOW),
}, indexes=[idx("stokvel_payout_circle_idx", ["circle_id"])],
   fks=[fk("stokvel_payouts_circle_id_stokvel_circles_id_fk", "stokvel_payouts", "stokvel_circles", "circle_id"),
        fk("stokvel_payouts_member_id_stokvel_members_id_fk", "stokvel_payouts", "stokvel_members", "member_id")],
   uniques=[uniq("stokvel_payout_circle_cycle_uniq", ["circle_id", "cycle"])])
t82["public.stokvel_events"] = table("stokvel_events", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "circle_id": UUID("circle_id"),
    "actor_phone": V("actor_phone", 32, notNull=False),
    "kind": V("kind", 40),
    "detail": J("detail", notNull=False),
    "created_at": TS("created_at", default=NOW),
}, indexes=[idx("stokvel_events_circle_idx", ["circle_id", "created_at"])],
   fks=[fk("stokvel_events_circle_id_stokvel_circles_id_fk", "stokvel_events", "stokvel_circles", "circle_id")])
t82["public.insurance_products"] = table("insurance_products", {
    "id": V("id", 64, pk=True),
    "tenant_id": V("tenant_id", 36),
    "name": V("name", 160),
    "description": TXT("description", notNull=False),
    "premium_bps": I("premium_bps", default=0),
    "flat_premium_cents": I("flat_premium_cents", default=0),
    "coverage_cents": I("coverage_cents"),
    "active": B("active", default="true"),
    "created_at": TS("created_at", default=NOW),
}, indexes=[idx("insurance_products_tenant_idx", ["tenant_id"])])
t82["public.insurance_quotes"] = table("insurance_quotes", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "product_id": V("product_id", 64),
    "order_id": V("order_id", 36, notNull=False),
    "holder_phone": V("holder_phone", 32, notNull=False),
    "context_json": J("context_json", notNull=False),
    "premium_cents": I("premium_cents"),
    "coverage_cents": I("coverage_cents"),
    "currency": V("currency", 3, default="'NGN'::character varying"),
    "status": V("status", 16, default="'quoted'::character varying"),
    "expires_at": TS("expires_at", notNull=False),
    "created_at": TS("created_at", default=NOW),
}, indexes=[idx("insurance_quotes_tenant_idx", ["tenant_id"]),
            idx("insurance_quotes_order_idx", ["order_id"])],
   fks=[fk("insurance_quotes_product_id_insurance_products_id_fk", "insurance_quotes", "insurance_products", "product_id")])
t82["public.insurance_policies"] = table("insurance_policies", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "policy_number": V("policy_number", 32),
    "quote_id": UUID("quote_id"),
    "product_id": V("product_id", 64),
    "order_id": V("order_id", 36, notNull=False),
    "holder_phone": V("holder_phone", 32, notNull=False),
    "premium_cents": I("premium_cents"),
    "coverage_cents": I("coverage_cents"),
    "currency": V("currency", 3, default="'NGN'::character varying"),
    "status": V("status", 16, default="'active'::character varying"),
    "bound_at": TS("bound_at", default=NOW),
    "created_at": TS("created_at", default=NOW),
}, indexes=[idx("insurance_policies_tenant_idx", ["tenant_id"]),
            idx("insurance_policies_holder_idx", ["tenant_id", "holder_phone"])],
   fks=[fk("insurance_policies_quote_id_insurance_quotes_id_fk", "insurance_policies", "insurance_quotes", "quote_id"),
        fk("insurance_policies_product_id_insurance_products_id_fk", "insurance_policies", "insurance_products", "product_id")],
   uniques=[uniq("insurance_policies_number_uniq", ["policy_number"])])
t82["public.insurance_claims"] = table("insurance_claims", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "policy_id": UUID("policy_id"),
    "reason": TXT("reason"),
    "trigger": V("trigger", 16, default="'manual'::character varying"),
    "status": V("status", 16, default="'filed'::character varying"),
    "payout_cents": I("payout_cents", notNull=False),
    "created_at": TS("created_at", default=NOW),
    "resolved_at": TS("resolved_at", notNull=False),
}, indexes=[idx("insurance_claims_policy_idx", ["policy_id"]),
            idx("insurance_claims_tenant_idx", ["tenant_id"])],
   fks=[fk("insurance_claims_policy_id_insurance_policies_id_fk", "insurance_claims", "insurance_policies", "policy_id")])

t83 = {}
t83["public.voucher_programs"] = table("voucher_programs", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "issuer": V("issuer", 160),
    "name": V("name", 160),
    "budget_cents": I("budget_cents"),
    "issued_cents": I("issued_cents", default=0),
    "redeemed_cents": I("redeemed_cents", default=0),
    "currency": V("currency", 3, default="'NGN'::character varying"),
    "eligible_phones": J("eligible_phones", notNull=False),
    "eligible_categories": J("eligible_categories", notNull=False),
    "expires_at": TS("expires_at", notNull=False),
    "status": V("status", 16, default="'active'::character varying"),
    "created_at": TS("created_at", default=NOW),
    "updated_at": TS("updated_at", default=NOW),
}, indexes=[idx("voucher_programs_tenant_idx", ["tenant_id"]),
            idx("voucher_programs_status_idx", ["status"])])
t83["public.vouchers"] = table("vouchers", {
    "id": UUID(pk=True, default=GENUUID),
    "tenant_id": V("tenant_id", 36),
    "program_id": UUID("program_id"),
    "code": V("code", 32),
    "recipient_phone": V("recipient_phone", 32),
    "amount_cents": I("amount_cents"),
    "currency": V("currency", 3, default="'NGN'::character varying"),
    "status": V("status", 16, default="'issued'::character varying"),
    "order_id": V("order_id", 36, notNull=False),
    "issued_at": TS("issued_at", default=NOW),
    "redeemed_at": TS("redeemed_at", notNull=False),
    "expires_at": TS("expires_at", notNull=False),
}, indexes=[idx("vouchers_program_idx", ["program_id"]),
            idx("vouchers_recipient_idx", ["tenant_id", "recipient_phone"]),
            idx("vouchers_status_idx", ["status"])],
   fks=[fk("vouchers_program_id_voucher_programs_id_fk", "vouchers", "voucher_programs", "program_id")],
   uniques=[uniq("vouchers_code_uniq", ["code"])])

def build(idx_no, tag, tables, prev_id, prev_file):
    s = copy.deepcopy(snap)
    s["tables"].update(tables)
    s["id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, f"w27g-{tag}"))
    s["prevId"] = prev_id
    out = os.path.join(BASE, f"{idx_no:04d}_snapshot.json")
    json.dump(s, open(out, "w"), indent=2, sort_keys=False)
    return s["id"]

id82 = build(82, "0082_stokvel_insurance", t82, snap["id"], None)
id83 = build(83, "0083_voucher_rails", t83, id82, None)

journal = json.load(open(os.path.join(BASE, "_journal.json")))
journal["entries"].append({"idx": 82, "version": "7", "when": 1786989400000,
                           "tag": "0082_stokvel_insurance", "breakpoints": True})
journal["entries"].append({"idx": 83, "version": "7", "when": 1786989500000,
                           "tag": "0083_voucher_rails", "breakpoints": True})
json.dump(journal, open(os.path.join(BASE, "_journal.json"), "w"), indent=2)
print("snapshots + journal written", id82, id83)
