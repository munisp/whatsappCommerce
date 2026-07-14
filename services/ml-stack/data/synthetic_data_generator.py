"""
Nigerian WhatsApp Commerce Synthetic Data Generator
====================================================
Generates realistic training data for:
  1. Fraud detection (GNN + LSTM)
  2. Credit scoring (TabNet)
  3. NLP intent classification (5 Nigerian languages)
  4. Inventory demand forecasting

Distributions are calibrated to Nigerian e-commerce patterns:
  - Paystack/Flutterwave transaction volumes and amounts
  - Nigerian state-level geography (36 states + FCT)
  - Naira (NGN) amounts with realistic price bands
  - Nigerian phone number patterns (+234)
  - Yoruba/Hausa/Igbo/Pidgin/English intent samples
  - Fraud patterns from CBN/NIBSS fraud reports (2022-2024)
"""

import json
import random
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from faker import Faker
from scipy import stats

fake = Faker("en_NG")
rng = np.random.default_rng(42)

# ── Nigerian Geography ──────────────────────────────────────────────────────
NIGERIAN_STATES = [
    "Lagos", "Abuja", "Kano", "Rivers", "Oyo", "Delta", "Anambra", "Kaduna",
    "Enugu", "Imo", "Ogun", "Borno", "Edo", "Katsina", "Akwa Ibom",
    "Bauchi", "Ondo", "Sokoto", "Cross River", "Abia", "Kwara", "Osun",
    "Niger", "Plateau", "Zamfara", "Benue", "Kebbi", "Jigawa", "Gombe",
    "Ekiti", "Nassarawa", "Adamawa", "Taraba", "Ebonyi", "Bayelsa", "Yobe", "FCT"
]

# Population-weighted state probabilities (Lagos, Kano, Rivers dominate)
STATE_WEIGHTS = [
    0.18, 0.09, 0.08, 0.07, 0.06, 0.05, 0.04, 0.04,
    0.03, 0.03, 0.03, 0.03, 0.03, 0.02, 0.02,
    0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02,
    0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01,
    0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.02
]

# ── Product Categories & Price Bands (NGN) ──────────────────────────────────
PRODUCT_CATEGORIES = {
    "fashion": {"min": 2500, "max": 85000, "fraud_rate": 0.04, "weight": 0.28},
    "electronics": {"min": 15000, "max": 850000, "fraud_rate": 0.09, "weight": 0.18},
    "food_groceries": {"min": 500, "max": 35000, "fraud_rate": 0.01, "weight": 0.22},
    "beauty_health": {"min": 1500, "max": 45000, "fraud_rate": 0.03, "weight": 0.12},
    "home_appliances": {"min": 8000, "max": 650000, "fraud_rate": 0.06, "weight": 0.08},
    "phones_tablets": {"min": 35000, "max": 1200000, "fraud_rate": 0.12, "weight": 0.07},
    "books_education": {"min": 800, "max": 25000, "fraud_rate": 0.005, "weight": 0.03},
    "sports_fitness": {"min": 3000, "max": 120000, "fraud_rate": 0.02, "weight": 0.02},
}

# ── Fraud Pattern Types (from CBN/NIBSS reports) ────────────────────────────
FRAUD_PATTERNS = {
    "account_takeover": 0.31,      # Stolen credentials
    "card_not_present": 0.24,      # CNP fraud
    "identity_theft": 0.18,        # Fake identity documents
    "triangulation": 0.12,         # Fake storefront + real goods
    "refund_abuse": 0.09,          # Fraudulent refund claims
    "friendly_fraud": 0.06,        # Chargeback abuse
}

# ── NLP Intent Samples (5 Nigerian Languages) ───────────────────────────────
NLP_INTENTS = {
    "browse_products": {
        "english": ["show me your products", "what do you have?", "I want to see items", "list your products", "what can I buy?"],
        "yoruba": ["ẹ jọ, ẹ fi awọn ọja rẹ hàn mi", "kini o ni fun tita?", "mo fẹ ri awọn nkan", "ẹ jọ ẹ sọ fun mi nipa awọn ọja rẹ"],
        "hausa": ["nuna mini kayan ka", "me kake da shi?", "ina son ganin kayayyaki", "kawo min jerin kayan ka"],
        "igbo": ["gosi m ihe i nwere", "kedu ihe i na-ere?", "achọrọ m ịhụ ihe ndị i nwere", "dee m ihe ndị i na-ere"],
        "pidgin": ["show me wetin you get", "wetin you dey sell?", "make I see your things", "abeg show me your products"],
    },
    "add_to_cart": {
        "english": ["add this to cart", "I want to buy this", "put it in my bag", "I'll take one", "add 2 of these"],
        "yoruba": ["fi eyi kun apo mi", "mo fẹ ra eyi", "fi meji kun apo mi", "mo fẹ ra ọkan"],
        "hausa": ["sa wannan a cikin kwandon sayan", "ina son sayan wannan", "sa biyu a cikin kwandon", "ina son ɗaya"],
        "igbo": ["tinye nke a n'ụdọ m", "achọrọ m ịzụ nke a", "tinye abụọ n'ụdọ m", "achọrọ m otu"],
        "pidgin": ["add am for my cart", "I wan buy this one", "put two for my bag", "I go take one"],
    },
    "checkout": {
        "english": ["I want to checkout", "how do I pay?", "complete my order", "proceed to payment", "I'm ready to pay"],
        "yoruba": ["mo fẹ san owo", "bawo ni mo ṣe le san?", "pari aṣẹ mi", "jẹ ki a lọ si isanwo"],
        "hausa": ["ina son biyan kuɗi", "yaya zan biya?", "kammala oda na", "tafi biyan kuɗi"],
        "igbo": ["achọrọ m ịkwụ ụgwọ", "otu m ga-esi kwụọ ụgwọ?", "mechaa iwu m", "gaa n'ịkwụ ụgwọ"],
        "pidgin": ["I wan pay now", "how I go pay?", "finish my order", "make I pay"],
    },
    "track_order": {
        "english": ["where is my order?", "track my package", "when will it arrive?", "order status", "delivery update"],
        "yoruba": ["nibo ni aṣẹ mi?", "ṣe aṣẹ mi ti de?", "igba wo ni yoo de?", "ipo aṣẹ mi"],
        "hausa": ["ina oda na?", "yaushe zai isa?", "halin oda na", "bi oda na"],
        "igbo": ["ebe nọ iwu m?", "mgbe ọ ga-abịa?", "ọnọdụ iwu m", "soro iwu m"],
        "pidgin": ["where my order dey?", "when e go reach?", "wetin happen to my order?", "track my thing"],
    },
    "customer_support": {
        "english": ["I have a problem", "help me", "I want to return this", "this is wrong", "speak to human"],
        "yoruba": ["mo ni iṣoro", "ẹ ran mi lọwọ", "mo fẹ da eyi pada", "eyi ko tọ", "mo fẹ sọrọ pẹlu eniyan"],
        "hausa": ["ina da matsala", "taimaka ni", "ina son mayar da wannan", "wannan ba daidai ba ne", "ina son magana da mutum"],
        "igbo": ["enwere m nsogbu", "nyere m aka", "achọrọ m iweghachi nke a", "nke a ezighi ezi", "achọrọ m ikwu okwu na mmadụ"],
        "pidgin": ["I get problem", "help me abeg", "I wan return this thing", "this one no correct", "make I talk to person"],
    },
}


def generate_phone_number() -> str:
    """Nigerian phone number (+234 format)"""
    prefixes = ["0703", "0706", "0803", "0806", "0810", "0813", "0816", "0903", "0906",
                "0704", "0708", "0802", "0808", "0812", "0814", "0817", "0818", "0909",
                "0701", "0805", "0807", "0811", "0815", "0819", "0901", "0902", "0904"]
    prefix = random.choice(prefixes)
    suffix = "".join([str(random.randint(0, 9)) for _ in range(7)])
    return f"+234{prefix[1:]}{suffix}"


def generate_transaction_amount(category: str, is_fraud: bool = False) -> float:
    """Generate realistic NGN transaction amount with fraud-specific patterns"""
    cat = PRODUCT_CATEGORIES[category]
    if is_fraud:
        # Fraud transactions cluster at high amounts or just below limits
        fraud_type = random.choices(list(FRAUD_PATTERNS.keys()), weights=list(FRAUD_PATTERNS.values()))[0]
        if fraud_type in ("account_takeover", "card_not_present"):
            # High-value transactions
            return round(rng.uniform(cat["max"] * 0.7, cat["max"] * 1.3), 2)
        elif fraud_type == "refund_abuse":
            return round(rng.uniform(cat["min"], cat["max"] * 0.3), 2)
        else:
            return round(rng.uniform(cat["min"] * 0.5, cat["max"]), 2)
    else:
        # Legitimate: log-normal distribution (most transactions are small-medium)
        log_mean = np.log((cat["min"] + cat["max"]) / 4)
        log_std = 0.8
        amount = np.exp(rng.normal(log_mean, log_std))
        return round(float(np.clip(amount, cat["min"], cat["max"])), 2)


def generate_velocity_features(customer_id: str, tx_history: list) -> dict:
    """Compute velocity features for fraud detection"""
    now = datetime.now()
    last_1h = [t for t in tx_history if (now - t["timestamp"]).seconds < 3600]
    last_24h = [t for t in tx_history if (now - t["timestamp"]).days < 1]
    last_7d = [t for t in tx_history if (now - t["timestamp"]).days < 7]
    return {
        "tx_count_1h": len(last_1h),
        "tx_count_24h": len(last_24h),
        "tx_count_7d": len(last_7d),
        "tx_amount_1h": sum(t["amount"] for t in last_1h),
        "tx_amount_24h": sum(t["amount"] for t in last_24h),
        "unique_merchants_24h": len(set(t.get("merchant_id", "") for t in last_24h)),
        "avg_amount_7d": np.mean([t["amount"] for t in last_7d]) if last_7d else 0,
        "max_amount_7d": max((t["amount"] for t in last_7d), default=0),
    }


def generate_fraud_dataset(n_samples: int = 50000) -> pd.DataFrame:
    """
    Generate fraud detection training dataset.
    Class imbalance: ~3.2% fraud rate (calibrated to NIBSS 2023 report).
    """
    print(f"Generating {n_samples} fraud detection samples...")
    records = []
    fraud_rate = 0.032
    n_fraud = int(n_samples * fraud_rate)
    n_legit = n_samples - n_fraud

    customer_histories: dict[str, list] = {}

    for i in range(n_samples):
        is_fraud = i < n_fraud
        customer_id = f"cust_{rng.integers(1, n_samples // 5):06d}"
        category = random.choices(
            list(PRODUCT_CATEGORIES.keys()),
            weights=[v["weight"] for v in PRODUCT_CATEGORIES.values()]
        )[0]
        amount = generate_transaction_amount(category, is_fraud)
        state = random.choices(NIGERIAN_STATES, weights=STATE_WEIGHTS)[0]

        # Time features (fraud peaks at night: 11pm-3am)
        if is_fraud:
            hour = random.choices(range(24), weights=[
                0.5, 0.8, 1.2, 1.5, 1.2, 0.8, 0.5, 0.3, 0.3, 0.4, 0.5, 0.6,
                0.7, 0.7, 0.7, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.6, 1.8
            ])[0]
        else:
            hour = random.choices(range(24), weights=[
                0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.5, 1.0, 1.5, 2.0, 2.5, 2.8,
                2.5, 2.0, 2.0, 2.2, 2.5, 2.8, 2.5, 2.0, 1.5, 1.0, 0.5, 0.3
            ])[0]

        days_ago = rng.integers(0, 365)
        tx_time = datetime.now() - timedelta(days=int(days_ago), hours=hour)

        # Velocity features
        history = customer_histories.get(customer_id, [])
        velocity = generate_velocity_features(customer_id, history)

        # Device/network features
        device_age_days = rng.integers(0, 730) if not is_fraud else rng.integers(0, 30)
        is_new_device = device_age_days < 7
        ip_country = "NG" if not is_fraud else random.choices(["NG", "GH", "ZA", "US", "GB"], weights=[0.4, 0.2, 0.15, 0.15, 0.1])[0]
        is_vpn = False if not is_fraud else (random.random() < 0.35)
        is_tor = False if not is_fraud else (random.random() < 0.08)

        # Behavioral features
        time_on_site_sec = rng.integers(30, 1800) if not is_fraud else rng.integers(5, 120)
        pages_visited = rng.integers(3, 25) if not is_fraud else rng.integers(1, 5)
        cart_abandon_rate = rng.uniform(0.1, 0.4) if not is_fraud else rng.uniform(0.6, 1.0)

        record = {
            "transaction_id": str(uuid.uuid4()),
            "customer_id": customer_id,
            "amount_ngn": amount,
            "category": category,
            "state": state,
            "hour_of_day": hour,
            "day_of_week": tx_time.weekday(),
            "is_weekend": int(tx_time.weekday() >= 5),
            "days_since_account_creation": int(rng.integers(1, 1825)),
            "device_age_days": int(device_age_days),
            "is_new_device": int(is_new_device),
            "ip_country": ip_country,
            "is_vpn": int(is_vpn),
            "is_tor": int(is_tor),
            "time_on_site_sec": int(time_on_site_sec),
            "pages_visited": int(pages_visited),
            "cart_abandon_rate": float(cart_abandon_rate),
            **velocity,
            "fraud_pattern": random.choices(list(FRAUD_PATTERNS.keys()), weights=list(FRAUD_PATTERNS.values()))[0] if is_fraud else "none",
            "is_fraud": int(is_fraud),
        }
        records.append(record)

        # Update history
        if customer_id not in customer_histories:
            customer_histories[customer_id] = []
        customer_histories[customer_id].append({"timestamp": tx_time, "amount": amount, "merchant_id": category})

    df = pd.DataFrame(records)
    # Shuffle to mix fraud/legit
    df = df.sample(frac=1, random_state=42).reset_index(drop=True)
    print(f"  Fraud rate: {df['is_fraud'].mean():.3%} ({df['is_fraud'].sum()} fraud / {len(df)} total)")
    return df


def generate_credit_scoring_dataset(n_samples: int = 20000) -> pd.DataFrame:
    """
    Generate credit scoring dataset for Nigerian SME merchants.
    Target: probability of default within 90 days.
    Default rate: ~18% (calibrated to Nigerian SME lending data).
    """
    print(f"Generating {n_samples} credit scoring samples...")
    records = []
    default_rate = 0.18

    for i in range(n_samples):
        is_default = random.random() < default_rate
        state = random.choices(NIGERIAN_STATES, weights=STATE_WEIGHTS)[0]
        business_age_months = rng.integers(1, 120)
        monthly_revenue_ngn = np.exp(rng.normal(np.log(500000), 1.2))
        monthly_revenue_ngn = float(np.clip(monthly_revenue_ngn, 50000, 50000000))

        # Defaults tend to have lower revenue, shorter history, higher debt
        if is_default:
            monthly_revenue_ngn *= rng.uniform(0.3, 0.8)
            debt_to_revenue = rng.uniform(0.5, 3.0)
            payment_history_score = rng.integers(300, 600)
            whatsapp_order_count_30d = rng.integers(0, 15)
            avg_order_value = rng.uniform(2000, 25000)
            customer_return_rate = rng.uniform(0.05, 0.3)
            inventory_turnover_days = rng.integers(45, 180)
            bank_account_age_months = rng.integers(1, 36)
        else:
            debt_to_revenue = rng.uniform(0.05, 0.8)
            payment_history_score = rng.integers(550, 850)
            whatsapp_order_count_30d = rng.integers(5, 200)
            avg_order_value = rng.uniform(5000, 150000)
            customer_return_rate = rng.uniform(0.2, 0.75)
            inventory_turnover_days = rng.integers(7, 60)
            bank_account_age_months = rng.integers(12, 120)

        records.append({
            "merchant_id": f"merch_{i:06d}",
            "state": state,
            "business_age_months": int(business_age_months),
            "monthly_revenue_ngn": round(monthly_revenue_ngn, 2),
            "debt_to_revenue_ratio": round(float(debt_to_revenue), 4),
            "payment_history_score": int(payment_history_score),
            "whatsapp_order_count_30d": int(whatsapp_order_count_30d),
            "avg_order_value_ngn": round(float(avg_order_value), 2),
            "customer_return_rate": round(float(customer_return_rate), 4),
            "inventory_turnover_days": int(inventory_turnover_days),
            "bank_account_age_months": int(bank_account_age_months),
            "num_product_categories": int(rng.integers(1, 8)),
            "has_physical_store": int(random.random() < 0.35),
            "has_cac_registration": int(random.random() < 0.45 if is_default else random.random() < 0.72),
            "social_media_followers": int(rng.integers(0, 50000)),
            "whatsapp_response_time_min": round(float(rng.uniform(1, 480)), 1),
            "refund_rate": round(float(rng.uniform(0.15, 0.5) if is_default else rng.uniform(0.01, 0.15)), 4),
            "is_default_90d": int(is_default),
        })

    df = pd.DataFrame(records)
    df = df.sample(frac=1, random_state=42).reset_index(drop=True)
    print(f"  Default rate: {df['is_default_90d'].mean():.3%}")
    return df


def generate_gnn_graph(fraud_df: pd.DataFrame) -> dict:
    """
    Build a transaction graph for GNN training.
    Nodes: customers + merchants (categories)
    Edges: transactions between customer and merchant
    Node features: aggregated transaction statistics
    Edge features: amount, hour, is_fraud
    """
    print("Building GNN transaction graph...")
    customers = fraud_df["customer_id"].unique()
    merchants = fraud_df["category"].unique()

    customer_idx = {c: i for i, c in enumerate(customers)}
    merchant_idx = {m: i + len(customers) for i, m in enumerate(merchants)}

    edges_src = []
    edges_dst = []
    edge_features = []
    edge_labels = []

    for _, row in fraud_df.iterrows():
        src = customer_idx[row["customer_id"]]
        dst = merchant_idx[row["category"]]
        edges_src.append(src)
        edges_dst.append(dst)
        edge_features.append([
            row["amount_ngn"] / 1_000_000,  # Normalize to millions NGN
            row["hour_of_day"] / 24.0,
            row["is_weekend"],
            row["is_vpn"],
            row["is_tor"],
            row["tx_count_24h"] / 100.0,
        ])
        edge_labels.append(row["is_fraud"])

    # Node features: per-customer aggregated stats
    node_features = []
    for c in customers:
        cdf = fraud_df[fraud_df["customer_id"] == c]
        node_features.append([
            float(cdf["amount_ngn"].mean() / 1_000_000),
            float(cdf["amount_ngn"].std() / 1_000_000) if len(cdf) > 1 else 0.0,
            float(cdf["is_fraud"].mean()),
            float(len(cdf) / 100.0),
            float(cdf["tx_count_24h"].mean() / 100.0),
        ])
    for m in merchants:
        mdf = fraud_df[fraud_df["category"] == m]
        node_features.append([
            float(mdf["amount_ngn"].mean() / 1_000_000),
            float(mdf["amount_ngn"].std() / 1_000_000) if len(mdf) > 1 else 0.0,
            float(mdf["is_fraud"].mean()),
            float(len(mdf) / 1000.0),
            float(mdf["tx_count_24h"].mean() / 100.0),
        ])

    graph = {
        "num_nodes": len(customers) + len(merchants),
        "num_edges": len(edges_src),
        "edges_src": edges_src,
        "edges_dst": edges_dst,
        "edge_features": edge_features,
        "edge_labels": edge_labels,
        "node_features": node_features,
        "customer_idx": customer_idx,
        "merchant_idx": merchant_idx,
    }
    print(f"  Graph: {graph['num_nodes']} nodes, {graph['num_edges']} edges")
    return graph


def generate_nlp_dataset(n_per_intent: int = 2000) -> pd.DataFrame:
    """Generate multilingual NLP intent classification dataset"""
    print(f"Generating NLP dataset ({n_per_intent} samples per intent per language)...")
    records = []
    intents = list(NLP_INTENTS.keys())
    languages = ["english", "yoruba", "hausa", "igbo", "pidgin"]

    for intent in intents:
        for lang in languages:
            base_samples = NLP_INTENTS[intent][lang]
            for _ in range(n_per_intent):
                # Augment: randomly pick a base sample and add noise
                text = random.choice(base_samples)
                # Add emoji noise (common in Nigerian WhatsApp)
                if random.random() < 0.3:
                    emojis = ["🙏", "😊", "👍", "❤️", "🛒", "💰", "📦", "✅"]
                    text = text + " " + random.choice(emojis)
                # Add typos (common in mobile typing)
                if random.random() < 0.15:
                    words = text.split()
                    if words:
                        idx = random.randint(0, len(words) - 1)
                        word = words[idx]
                        if len(word) > 2:
                            pos = random.randint(0, len(word) - 1)
                            words[idx] = word[:pos] + word[pos+1:]
                        text = " ".join(words)
                records.append({"text": text, "intent": intent, "language": lang})

    df = pd.DataFrame(records)
    df = df.sample(frac=1, random_state=42).reset_index(drop=True)
    print(f"  Total NLP samples: {len(df)}")
    return df


def generate_demand_forecast_dataset(n_products: int = 500, n_days: int = 365) -> pd.DataFrame:
    """Generate inventory demand forecasting dataset"""
    print(f"Generating demand forecast dataset ({n_products} products × {n_days} days)...")
    records = []
    categories = list(PRODUCT_CATEGORIES.keys())

    for p in range(n_products):
        category = random.choice(categories)
        base_demand = rng.integers(2, 50)
        trend = rng.uniform(-0.001, 0.003)  # Slight upward trend for most
        seasonality_amplitude = rng.uniform(0.1, 0.5)

        for d in range(n_days):
            date = datetime(2024, 1, 1) + timedelta(days=d)
            # Weekly seasonality (weekends higher for fashion/food)
            weekly = np.sin(2 * np.pi * d / 7) * seasonality_amplitude
            # Monthly seasonality (end of month payday effect in Nigeria)
            monthly = np.sin(2 * np.pi * d / 30) * seasonality_amplitude * 0.5
            # Yearly seasonality (Christmas, Eid, Easter spikes)
            yearly = np.sin(2 * np.pi * d / 365) * seasonality_amplitude * 0.3
            # Payday spike (25th-31st of month)
            payday_boost = 1.4 if date.day >= 25 else 1.0
            # Ramadan effect for food/fashion (April in 2024)
            ramadan_boost = 1.3 if (date.month == 4 and category in ("food_groceries", "fashion")) else 1.0
            demand = max(0, int(
                base_demand * (1 + trend * d) * (1 + weekly + monthly + yearly) * payday_boost * ramadan_boost
                + rng.normal(0, base_demand * 0.2)
            ))
            records.append({
                "product_id": f"prod_{p:04d}",
                "category": category,
                "date": date.strftime("%Y-%m-%d"),
                "day_of_week": date.weekday(),
                "day_of_month": date.day,
                "month": date.month,
                "is_weekend": int(date.weekday() >= 5),
                "is_payday_week": int(date.day >= 25),
                "is_ramadan": int(date.month == 4),
                "demand_units": demand,
            })

    df = pd.DataFrame(records)
    print(f"  Total demand records: {len(df)}")
    return df


def save_datasets(output_dir: str = "data/generated") -> None:
    """Generate and save all datasets"""
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    # Fraud detection
    fraud_df = generate_fraud_dataset(50000)
    fraud_df.to_parquet(f"{output_dir}/fraud_train.parquet", index=False)
    fraud_df.sample(frac=0.2, random_state=99).to_parquet(f"{output_dir}/fraud_val.parquet", index=False)
    print(f"  Saved fraud datasets to {output_dir}/fraud_*.parquet")

    # GNN graph
    graph = generate_gnn_graph(fraud_df)
    with open(f"{output_dir}/transaction_graph.json", "w") as f:
        json.dump({k: v if not isinstance(v, np.ndarray) else v.tolist() for k, v in graph.items()}, f)
    print(f"  Saved GNN graph to {output_dir}/transaction_graph.json")

    # Credit scoring
    credit_df = generate_credit_scoring_dataset(20000)
    credit_df.to_parquet(f"{output_dir}/credit_train.parquet", index=False)
    credit_df.sample(frac=0.2, random_state=99).to_parquet(f"{output_dir}/credit_val.parquet", index=False)
    print(f"  Saved credit datasets to {output_dir}/credit_*.parquet")

    # NLP
    nlp_df = generate_nlp_dataset(2000)
    nlp_df.to_parquet(f"{output_dir}/nlp_train.parquet", index=False)
    nlp_df.sample(frac=0.2, random_state=99).to_parquet(f"{output_dir}/nlp_val.parquet", index=False)
    print(f"  Saved NLP datasets to {output_dir}/nlp_*.parquet")

    # Demand forecast
    demand_df = generate_demand_forecast_dataset(500, 365)
    demand_df.to_parquet(f"{output_dir}/demand_train.parquet", index=False)
    print(f"  Saved demand forecast dataset to {output_dir}/demand_train.parquet")

    print(f"\nAll datasets saved to {output_dir}/")
    return fraud_df, credit_df, nlp_df, demand_df, graph


if __name__ == "__main__":
    save_datasets("data/generated")
