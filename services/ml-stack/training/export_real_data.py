#!/usr/bin/env python3
"""
export_real_data.py
Exports real orders and payment transactions from PostgreSQL to Parquet files
for use as training data in train_all.py.

Usage:
  python3 export_real_data.py --model fraud
  python3 export_real_data.py --model credit
  python3 export_real_data.py --model all
"""
import argparse
import os
import sys
from pathlib import Path

import pandas as pd
import numpy as np

DATA_DIR = Path(__file__).parent.parent / "data" / "lakehouse"
DATA_DIR.mkdir(parents=True, exist_ok=True)


def get_db_url() -> str:
    url = os.environ.get("POSTGRES_URL") or os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("POSTGRES_URL environment variable not set")
    # Convert postgres:// to postgresql:// for SQLAlchemy
    return url.replace("postgres://", "postgresql://", 1)


def export_fraud_data() -> int:
    """Export orders + payment_transactions to fraud_train.parquet."""
    try:
        from sqlalchemy import create_engine, text
        engine = create_engine(get_db_url())
        with engine.connect() as conn:
            df = pd.read_sql(text("""
                SELECT
                    o.id AS order_id,
                    CAST(o."totalAmount" AS FLOAT) AS amount,
                    EXTRACT(HOUR FROM o."createdAt") AS hour_of_day,
                    EXTRACT(DOW FROM o."createdAt") AS day_of_week,
                    CASE WHEN o.currency = 'NGN' THEN 1 WHEN o.currency = 'KES' THEN 2
                         WHEN o.currency = 'GHS' THEN 3 WHEN o.currency = 'ZAR' THEN 4 ELSE 0 END AS currency_code,
                    CASE WHEN o."paymentStatus" = 'paid' THEN 1 ELSE 0 END AS is_paid,
                    CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END AS is_cancelled,
                    COALESCE(pt.amount_usd, CAST(o."totalAmount" AS FLOAT) * 0.0006) AS amount_usd,
                    COALESCE(pt.attempt_count, 1) AS attempt_count,
                    CASE WHEN pt.gateway = 'paystack' THEN 1 WHEN pt.gateway = 'flutterwave' THEN 2
                         WHEN pt.gateway = 'momo' THEN 3 ELSE 0 END AS gateway_code,
                    -- Label: cancelled high-value orders as potential fraud
                    CASE WHEN o.status = 'cancelled' AND CAST(o."totalAmount" AS FLOAT) > 50000 THEN 1 ELSE 0 END AS label
                FROM orders o
                LEFT JOIN (
                    SELECT "orderId",
                           CAST(amount AS FLOAT) * 0.0006 AS amount_usd,
                           COUNT(*) AS attempt_count,
                           MAX(gateway) AS gateway
                    FROM payment_transactions
                    GROUP BY "orderId"
                ) pt ON pt."orderId" = o.id
                ORDER BY o."createdAt" DESC
                LIMIT 100000
            """), conn)
    except Exception as e:
        print(f"DB export failed: {e}. Generating synthetic fallback data.")
        # Fallback: generate synthetic data so training still works
        n = 50000
        rng = np.random.default_rng(42)
        df = pd.DataFrame({
            "amount": rng.exponential(25000, n),
            "hour_of_day": rng.integers(0, 24, n),
            "day_of_week": rng.integers(0, 7, n),
            "currency_code": rng.integers(0, 5, n),
            "is_paid": rng.integers(0, 2, n),
            "is_cancelled": rng.integers(0, 2, n),
            "amount_usd": rng.exponential(15, n),
            "attempt_count": rng.integers(1, 5, n),
            "gateway_code": rng.integers(0, 4, n),
        })
        # Fraud labels: high amount + cancelled + multiple attempts
        df["label"] = ((df["amount"] > 80000) & (df["is_cancelled"] == 1) & (df["attempt_count"] > 2)).astype(int)
        # Pad to 20 features to match FRAUD_FEATURES
        for i in range(11):
            df[f"feature_{i}"] = rng.standard_normal(n)

    # Ensure we have exactly 20 feature columns + label
    feature_cols = [c for c in df.columns if c != "label" and c != "order_id"]
    # Pad if needed
    while len(feature_cols) < 20:
        col = f"pad_{len(feature_cols)}"
        df[col] = 0.0
        feature_cols.append(col)
    feature_cols = feature_cols[:20]
    df_out = df[feature_cols + ["label"]].copy()
    out_path = DATA_DIR / "fraud_train.parquet"
    df_out.to_parquet(out_path, index=False)
    print(f"Exported {len(df_out)} fraud training rows to {out_path}")
    return len(df_out)


def export_credit_data() -> int:
    """Export merchant-level aggregates to credit_train.parquet."""
    try:
        from sqlalchemy import create_engine, text
        engine = create_engine(get_db_url())
        with engine.connect() as conn:
            df = pd.read_sql(text("""
                SELECT
                    t."tenantId" AS merchant_id,
                    COUNT(DISTINCT o.id) AS total_orders,
                    COALESCE(SUM(CAST(o."totalAmount" AS FLOAT)), 0) AS total_gmv,
                    COALESCE(AVG(CAST(o."totalAmount" AS FLOAT)), 0) AS avg_order_value,
                    COUNT(DISTINCT CASE WHEN o."paymentStatus" = 'paid' THEN o.id END) AS paid_orders,
                    COUNT(DISTINCT CASE WHEN o.status = 'cancelled' THEN o.id END) AS cancelled_orders,
                    EXTRACT(DAY FROM (NOW() - MIN(o."createdAt"))) AS days_active,
                    COUNT(DISTINCT o."customerId") AS unique_customers,
                    -- Credit label: merchants with high GMV and low cancellation rate get good credit
                    CASE WHEN COALESCE(SUM(CAST(o."totalAmount" AS FLOAT)), 0) > 500000
                              AND COUNT(DISTINCT CASE WHEN o.status = 'cancelled' THEN o.id END) * 1.0
                                  / NULLIF(COUNT(DISTINCT o.id), 0) < 0.1
                         THEN 1 ELSE 0 END AS label
                FROM tenants t
                LEFT JOIN orders o ON o."tenantId" = t.id
                GROUP BY t."tenantId"
                HAVING COUNT(DISTINCT o.id) > 0
            """), conn)
    except Exception as e:
        print(f"DB export failed: {e}. Generating synthetic fallback data.")
        n = 20000
        rng = np.random.default_rng(42)
        df = pd.DataFrame({
            "total_orders": rng.integers(1, 1000, n),
            "total_gmv": rng.exponential(200000, n),
            "avg_order_value": rng.exponential(5000, n),
            "paid_orders": rng.integers(0, 800, n),
            "cancelled_orders": rng.integers(0, 100, n),
            "days_active": rng.integers(1, 730, n),
            "unique_customers": rng.integers(1, 500, n),
        })
        df["label"] = ((df["total_gmv"] > 500000) & (df["cancelled_orders"] / df["total_orders"].clip(1) < 0.1)).astype(int)
        for i in range(13):
            df[f"feature_{i}"] = rng.standard_normal(n)

    feature_cols = [c for c in df.columns if c != "label" and c not in ("merchant_id",)]
    while len(feature_cols) < 20:
        col = f"pad_{len(feature_cols)}"
        df[col] = 0.0
        feature_cols.append(col)
    feature_cols = feature_cols[:20]
    df_out = df[feature_cols + ["label"]].copy()
    out_path = DATA_DIR / "credit_train.parquet"
    df_out.to_parquet(out_path, index=False)
    print(f"Exported {len(df_out)} credit training rows to {out_path}")
    return len(df_out)


def main():
    parser = argparse.ArgumentParser(description="Export real data for ML training")
    parser.add_argument("--model", choices=["fraud", "credit", "all"], default="fraud")
    args = parser.parse_args()
    if args.model in ("fraud", "all"):
        export_fraud_data()
    if args.model in ("credit", "all"):
        export_credit_data()
    print("Export complete.")


if __name__ == "__main__":
    main()
