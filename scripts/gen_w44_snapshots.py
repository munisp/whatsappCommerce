#!/usr/bin/env python3
"""Generate W44 (Coder C) cumulative snapshots 0140-0142 + journal entries,
chained from the 0135 tip. Cumulative: each snapshot is the previous plus
the new tables/columns (full column union)."""
import json, uuid, copy

BASE = "drizzle/meta/0135_address_change_requests_snapshot.json"
JOURNAL = "drizzle/meta/_journal.json"

def col(name, typ, notNull=True, pk=False, default=None):
    c = {"name": name, "type": typ, "primaryKey": pk, "notNull": notNull}
    if default is not None:
        c["default"] = default
    return c

def idx(name, cols, unique=False):
    return {"name": name,
            "columns": [{"expression": c, "isExpression": False, "asc": True, "nulls": "last"} for c in cols],
            "isUnique": unique, "concurrently": False, "method": "btree", "with": {}}

def table(name, columns, indexes=None):
    return {"name": name, "schema": "", "columns": columns,
            "indexes": indexes or {}, "foreignKeys": {}, "compositePrimaryKeys": {},
            "uniqueConstraints": {}, "policies": {}, "checkConstraints": {}, "isRLSEnabled": False}

svc_appt = table("service_appointments", {
    "id": col("id", "uuid", pk=True, default="gen_random_uuid()"),
    "tenant_id": col("tenant_id", "varchar(36)"),
    "customer_id": col("customer_id", "varchar(36)"),
    "service_product_id": col("service_product_id", "varchar(36)"),
    "starts_at": col("starts_at", "timestamp"),
    "ends_at": col("ends_at", "timestamp"),
    "deposit_cents": col("deposit_cents", "integer", default=0),
    "deposit_status": col("deposit_status", "varchar(16)", default="'booked'::character varying".replace("booked", "pending")),
    "deposit_ref": col("deposit_ref", "varchar(128)", notNull=False),
    "remainder_cents": col("remainder_cents", "integer", default=0),
    "remainder_status": col("remainder_status", "varchar(16)", notNull=False),
    "remainder_ref": col("remainder_ref", "varchar(128)", notNull=False),
    "status": col("status", "varchar(16)", default="'booked'::character varying"),
    "order_id": col("order_id", "varchar(36)", notNull=False),
    "channel": col("channel", "varchar(16)", default="'whatsapp'::character varying"),
    "created_at": col("created_at", "timestamp", default="now()"),
    "updated_at": col("updated_at", "timestamp", default="now()"),
}, {
    "service_appt_tenant_product_time_idx": idx("service_appt_tenant_product_time_idx", ["tenant_id", "service_product_id", "starts_at"]),
    "service_appt_tenant_customer_idx": idx("service_appt_tenant_customer_idx", ["tenant_id", "customer_id"]),
    "service_appt_tenant_status_idx": idx("service_appt_tenant_status_idx", ["tenant_id", "status"]),
})

sub_plans = table("subscription_plans", {
    "id": col("id", "uuid", pk=True, default="gen_random_uuid()"),
    "tenant_id": col("tenant_id", "varchar(36)"),
    "product_id": col("product_id", "varchar(36)"),
    "name": col("name", "varchar(160)"),
    "interval": col("interval", "varchar(8)"),
    "price_cents": col("price_cents", "integer"),
    "status": col("status", "varchar(16)", default="'active'::character varying"),
    "created_at": col("created_at", "timestamp", default="now()"),
}, {
    "subscription_plans_tenant_idx": idx("subscription_plans_tenant_idx", ["tenant_id", "status"]),
})
sub_plans["checkConstraints"] = {}  # check constraint represented loosely; SQL is authoritative

cust_subs = table("customer_subscriptions", {
    "id": col("id", "uuid", pk=True, default="gen_random_uuid()"),
    "tenant_id": col("tenant_id", "varchar(36)"),
    "plan_id": col("plan_id", "uuid"),
    "customer_id": col("customer_id", "varchar(36)"),
    "status": col("status", "varchar(16)", default="'active'::character varying"),
    "next_billing_at": col("next_billing_at", "timestamp"),
    "payment_token_id": col("payment_token_id", "uuid", notNull=False),
    "retry_count": col("retry_count", "integer", default=0),
    "last_billed_period": col("last_billed_period", "varchar(32)", notNull=False),
    "last_charge_ref": col("last_charge_ref", "varchar(128)", notNull=False),
    "created_at": col("created_at", "timestamp", default="now()"),
    "updated_at": col("updated_at", "timestamp", default="now()"),
}, {
    "customer_subs_tenant_status_due_idx": idx("customer_subs_tenant_status_due_idx", ["tenant_id", "status", "next_billing_at"]),
    "customer_subs_tenant_customer_idx": idx("customer_subs_tenant_customer_idx", ["tenant_id", "customer_id"]),
    "customer_subs_live_uidx": idx("customer_subs_live_uidx", ["tenant_id", "plan_id", "customer_id"], unique=True),
})

pin_batches = table("digital_pin_batches", {
    "id": col("id", "uuid", pk=True, default="gen_random_uuid()"),
    "tenant_id": col("tenant_id", "varchar(36)"),
    "product_id": col("product_id", "varchar(36)"),
    "uploaded_by": col("uploaded_by", "varchar(64)"),
    "pin_count": col("pin_count", "integer", default=0),
    "created_at": col("created_at", "timestamp", default="now()"),
}, {
    "digital_pin_batches_tenant_product_idx": idx("digital_pin_batches_tenant_product_idx", ["tenant_id", "product_id"]),
})

pins = table("digital_pins", {
    "id": col("id", "uuid", pk=True, default="gen_random_uuid()"),
    "batch_id": col("batch_id", "uuid"),
    "tenant_id": col("tenant_id", "varchar(36)"),
    "product_id": col("product_id", "varchar(36)"),
    "pin_encrypted": col("pin_encrypted", "text"),
    "status": col("status", "varchar(16)", default="'available'::character varying"),
    "order_line_id": col("order_line_id", "varchar(36)", notNull=False),
    "order_id": col("order_id", "varchar(36)", notNull=False),
    "sold_at": col("sold_at", "timestamp", notNull=False),
    "revealed_at": col("revealed_at", "timestamp", notNull=False),
    "created_at": col("created_at", "timestamp", default="now()"),
}, {
    "digital_pins_batch_idx": idx("digital_pins_batch_idx", ["batch_id"]),
    "digital_pins_tenant_status_idx": idx("digital_pins_tenant_status_idx", ["tenant_id", "status"]),
    "digital_pins_available_idx": idx("digital_pins_available_idx", ["tenant_id", "product_id"]),
})

snap = json.load(open(BASE))
prev_id = snap["id"]

def write(tag, mut):
    global snap, prev_id
    s = copy.deepcopy(snap)
    mut(s)
    new_id = str(uuid.uuid4())
    s["id"] = new_id
    s["prevId"] = prev_id
    with open(f"drizzle/meta/{tag}_snapshot.json", "w") as f:
        json.dump(s, f, indent=2)
    snap, prev_id = s, new_id
    return new_id

def mut0140(s):
    s["tables"]["public.tenants"]["columns"]["appointmentCancelWindowHours"] = \
        col("appointmentCancelWindowHours", "integer", default=24)
    s["tables"]["public.products"]["columns"]["serviceBookingEnabled"] = \
        col("serviceBookingEnabled", "boolean", default="false")
    s["tables"]["public.products"]["columns"]["serviceDurationMinutes"] = \
        col("serviceDurationMinutes", "integer", default=60)
    s["tables"]["public.service_appointments"] = svc_appt

def mut0141(s):
    s["tables"]["public.subscription_plans"] = sub_plans
    s["tables"]["public.customer_subscriptions"] = cust_subs

def mut0142(s):
    s["tables"]["public.products"]["columns"]["digitalPinEnabled"] = \
        col("digitalPinEnabled", "boolean", default="false")
    s["tables"]["public.digital_pin_batches"] = pin_batches
    s["tables"]["public.digital_pins"] = pins

id140 = write("0140_service_appointments", mut0140)
id141 = write("0141_subscriptions", mut0141)
id142 = write("0142_digital_pins", mut0142)

j = json.load(open(JOURNAL))
entries = j["entries"]
base_when = entries[-1]["when"]
for i, tag in enumerate(["0140_service_appointments", "0141_subscriptions", "0142_digital_pins"]):
    entries.append({"idx": 140 + i, "version": "7",
                    "when": base_when + (i + 1) * 100000, "tag": tag, "breakpoints": True})
with open(JOURNAL, "w") as f:
    json.dump(j, f, indent=2)
print("chained:", snap["id"][:8], "prev:", prev_id[:8])
print("0135 id:", json.load(open(BASE))["id"], "-> 0140 prevId:", json.load(open("drizzle/meta/0140_service_appointments_snapshot.json"))["prevId"])
print("0141 prevId:", json.load(open("drizzle/meta/0141_subscriptions_snapshot.json"))["prevId"])
print("0142 prevId:", json.load(open("drizzle/meta/0142_digital_pins_snapshot.json"))["prevId"])
