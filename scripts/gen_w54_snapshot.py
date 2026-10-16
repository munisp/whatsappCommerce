#!/usr/bin/env python3
"""Generate the W54 (capabilities) cumulative snapshot 0175 + journal entry,
chained from the 0174 tip. Cumulative FULL union: previous snapshot plus the
two new membership tables (membership_plans, customer_memberships)."""
import json, uuid, time

BASE = "drizzle/meta/0174_w53_events_snapshot.json"
OUT = "drizzle/meta/0175_w54_membership_snapshot.json"
JOURNAL = "drizzle/meta/_journal.json"


def col(name, typ, notNull=True, pk=False, default=None):
    c = {"name": name, "type": typ, "primaryKey": pk, "notNull": notNull}
    if default is not None:
        c["default"] = default
    return c


def idx(name, cols, unique=False):
    return {
        "name": name,
        "columns": [
            {"expression": c, "isExpression": False, "asc": True, "nulls": "last"}
            for c in cols
        ],
        "isUnique": unique,
        "concurrently": False,
        "method": "btree",
        "with": {},
    }


def table(name, columns, indexes=None):
    return {
        "name": name,
        "schema": "",
        "columns": columns,
        "indexes": indexes or {},
        "foreignKeys": {},
        "compositePrimaryKeys": {},
        "uniqueConstraints": {},
        "policies": {},
        "checkConstraints": {},
        "isRLSEnabled": False,
    }


membership_plans = table("membership_plans", {
    "id": col("id", "uuid", pk=True, default="gen_random_uuid()"),
    "tenantId": col("tenantId", "varchar(36)"),
    "name": col("name", "varchar(120)"),
    "description": col("description", "text", notNull=False),
    "priceCents": col("priceCents", "integer", default=0),
    "currency": col("currency", "varchar(3)", default="'NGN'"),
    "period": col("period", "varchar(8)", default="'month'"),
    "discountPercent": col("discountPercent", "integer", default=0),
    "pointsMultiplier": col("pointsMultiplier", "integer", default=1),
    "status": col("status", "varchar(16)", default="'active'"),
    "createdAt": col("createdAt", "timestamp", default="now()"),
    "updatedAt": col("updatedAt", "timestamp", default="now()"),
}, {
    "membership_plans_tenant_idx": idx("membership_plans_tenant_idx", ["tenantId", "status"]),
})

customer_memberships = table("customer_memberships", {
    "id": col("id", "uuid", pk=True, default="gen_random_uuid()"),
    "tenantId": col("tenantId", "varchar(36)"),
    "planId": col("planId", "uuid"),
    "customerId": col("customerId", "varchar(36)"),
    "status": col("status", "varchar(16)", default="'active'"),
    "startedAt": col("startedAt", "timestamp", default="now()"),
    "currentPeriodEnd": col("currentPeriodEnd", "timestamp", notNull=False),
    "cancelAtPeriodEnd": col("cancelAtPeriodEnd", "boolean", default=False),
    "orderId": col("orderId", "varchar(36)", notNull=False),
    "paymentRef": col("paymentRef", "varchar(128)", notNull=False),
    "createdAt": col("createdAt", "timestamp", default="now()"),
    "updatedAt": col("updatedAt", "timestamp", default="now()"),
}, {
    "customer_memberships_tenant_customer_idx": idx(
        "customer_memberships_tenant_customer_idx", ["tenantId", "customerId"]),
    "customer_memberships_plan_idx": idx(
        "customer_memberships_plan_idx", ["tenantId", "planId"]),
    "customer_memberships_live_uidx": idx(
        "customer_memberships_live_uidx", ["tenantId", "customerId"], unique=True),
})

snap = json.load(open(BASE))
assert "public.membership_plans" not in snap["tables"]
snap["tables"]["public.membership_plans"] = membership_plans
snap["tables"]["public.customer_memberships"] = customer_memberships
prev_id = snap["id"]
snap["prevId"] = prev_id
snap["id"] = str(uuid.uuid4())
json.dump(snap, open(OUT, "w"), indent=2)

j = json.load(open(JOURNAL))
last = j["entries"][-1]
assert last["idx"] == 174 and last["tag"] == "0174_w53_events", last
j["entries"].append({
    "idx": 175,
    "version": "7",
    "when": 1790433600000,
    "tag": "0175_w54_membership",
    "breakpoints": True,
})
json.dump(j, open(JOURNAL, "w"), indent=2)
print(f"0175 snapshot written ({len(snap['tables'])} tables), prevId={prev_id}, journal idx 175 appended")
