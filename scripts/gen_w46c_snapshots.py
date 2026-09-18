#!/usr/bin/env python3
"""Generate W46 (Coder C, uc-money) cumulative snapshots 0152-0153 + journal
entries, chained from the 0151 tip. Cumulative: each snapshot is the previous
plus the new tables/columns (full column union)."""
import json, uuid, copy

BASE = "drizzle/meta/0151_payment_outbox_snapshot.json"
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

auctions = table("auctions", {
    "id": col("id", "uuid", pk=True, default="gen_random_uuid()"),
    "tenant_id": col("tenant_id", "varchar(36)"),
    "product_id": col("product_id", "varchar(36)"),
    "title": col("title", "varchar(255)", notNull=False),
    "start_price_cents": col("start_price_cents", "integer"),
    "min_increment_cents": col("min_increment_cents", "integer", default=100),
    "reserve_cents": col("reserve_cents", "integer", notNull=False),
    "anti_snipe_seconds": col("anti_snipe_seconds", "integer", default=0),
    "status": col("status", "varchar(16)", default="'active'::character varying"),
    "current_bid_cents": col("current_bid_cents", "integer", notNull=False),
    "current_bidder_id": col("current_bidder_id", "varchar(64)", notNull=False),
    "bid_count": col("bid_count", "integer", default=0),
    "winner_order_id": col("winner_order_id", "varchar(36)", notNull=False),
    "ends_at": col("ends_at", "timestamp"),
    "created_by": col("created_by", "varchar(64)", notNull=False),
    "created_at": col("created_at", "timestamp", default="now()"),
    "closed_at": col("closed_at", "timestamp", notNull=False),
}, {
    "auctions_tenant_status_ends_idx": idx("auctions_tenant_status_ends_idx", ["tenant_id", "status", "ends_at"]),
    "auctions_tenant_product_idx": idx("auctions_tenant_product_idx", ["tenant_id", "product_id"]),
})

auction_bids = table("auction_bids", {
    "id": col("id", "uuid", pk=True, default="gen_random_uuid()"),
    "tenant_id": col("tenant_id", "varchar(36)"),
    "auction_id": col("auction_id", "uuid"),
    "bidder_id": col("bidder_id", "varchar(64)"),
    "amount_cents": col("amount_cents", "integer"),
    "status": col("status", "varchar(16)", default="'active'::character varying"),
    "created_at": col("created_at", "timestamp", default="now()"),
}, {
    "auction_bids_auction_amount_idx": idx("auction_bids_auction_amount_idx", ["auction_id", "amount_cents"]),
    "auction_bids_tenant_bidder_idx": idx("auction_bids_tenant_bidder_idx", ["tenant_id", "bidder_id"]),
})

order_amendments = table("order_amendments", {
    "id": col("id", "uuid", pk=True, default="gen_random_uuid()"),
    "tenant_id": col("tenant_id", "varchar(36)"),
    "order_id": col("order_id", "varchar(36)"),
    "prev_total_cents": col("prev_total_cents", "integer"),
    "new_total_cents": col("new_total_cents", "integer"),
    "delta_cents": col("delta_cents", "integer"),
    "items": col("items", "jsonb"),
    "reason": col("reason", "text", notNull=False),
    "status": col("status", "varchar(24)", default="'applied'::character varying"),
    "payment_intent_id": col("payment_intent_id", "varchar(36)", notNull=False),
    "actor": col("actor", "varchar(128)", notNull=False),
    "created_at": col("created_at", "timestamp", default="now()"),
}, {
    "order_amendments_tenant_order_idx": idx("order_amendments_tenant_order_idx", ["tenant_id", "order_id"]),
    "order_amendments_tenant_created_idx": idx("order_amendments_tenant_created_idx", ["tenant_id", "created_at"]),
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

def mut0152(s):
    # orders.tipCents (camelCase — the orders table uses camel column names)
    s["tables"]["public.orders"]["columns"]["tipCents"] = col("tipCents", "integer", default=0)
    # products open-amount / donation flags (camelCase)
    s["tables"]["public.products"]["columns"]["openAmountEnabled"] = \
        col("openAmountEnabled", "boolean", default="false")
    s["tables"]["public.products"]["columns"]["donationMinCents"] = \
        col("donationMinCents", "integer", notNull=False)
    s["tables"]["public.auctions"] = auctions
    s["tables"]["public.auction_bids"] = auction_bids

def mut0153(s):
    s["tables"]["public.order_amendments"] = order_amendments

id152 = write("0152_w46_auctions_tips_donations", mut0152)
id153 = write("0153_w46_order_amendments", mut0153)

j = json.load(open(JOURNAL))
entries = j["entries"]
base_when = entries[-1]["when"]
for i, tag in enumerate(["0152_w46_auctions_tips_donations", "0153_w46_order_amendments"]):
    entries.append({"idx": 152 + i, "version": "7",
                    "when": base_when + (i + 1) * 60000, "tag": tag, "breakpoints": True})
with open(JOURNAL, "w") as f:
    json.dump(j, f, indent=2)
print("0151 id:", json.load(open(BASE))["id"])
print("0152 prevId:", json.load(open("drizzle/meta/0152_w46_auctions_tips_donations_snapshot.json"))["prevId"])
print("0153 prevId:", json.load(open("drizzle/meta/0153_w46_order_amendments_snapshot.json"))["prevId"])
