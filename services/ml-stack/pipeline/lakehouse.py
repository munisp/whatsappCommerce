"""
Lakehouse Data Pipeline
========================
Production DB (PostgreSQL) → Delta Lake → Feature Store → Training Data Loader

Uses DuckDB as the local query engine (zero-dependency, runs in-process).
In production, replace DuckDB with Apache Spark + Delta Lake on S3/MinIO.

Pipeline stages:
  1. Extract: Pull raw transactions from PostgreSQL
  2. Transform: Feature engineering (velocity, ratios, encodings)
  3. Load: Write to Delta Lake partitioned by date
  4. Feature Store: Materialize point-in-time correct features
  5. Training Loader: Return train/val splits as PyTorch DataLoaders
"""

import os
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Tuple

import duckdb
import numpy as np
import pandas as pd
import torch
from torch.utils.data import DataLoader, TensorDataset
from sklearn.preprocessing import StandardScaler

LAKEHOUSE_DIR = Path(__file__).parent.parent / "data" / "lakehouse"
FEATURE_STORE_DIR = LAKEHOUSE_DIR / "feature_store"
DELTA_DIR = LAKEHOUSE_DIR / "delta"

for d in [LAKEHOUSE_DIR, FEATURE_STORE_DIR, DELTA_DIR]:
    d.mkdir(parents=True, exist_ok=True)


class LakehousePipeline:
    """
    Orchestrates the full data pipeline from production DB to training data.
    """

    def __init__(self, db_url: Optional[str] = None):
        self.db_url = db_url or os.getenv("POSTGRES_URL", "")
        self.duck = duckdb.connect(str(LAKEHOUSE_DIR / "warehouse.duckdb"))
        self._init_warehouse()

    def _init_warehouse(self):
        """Initialize DuckDB warehouse schema"""
        self.duck.execute("""
            CREATE TABLE IF NOT EXISTS transactions_raw (
                transaction_id VARCHAR PRIMARY KEY,
                customer_id VARCHAR,
                tenant_id VARCHAR,
                amount_ngn DOUBLE,
                category VARCHAR,
                hour_of_day INTEGER,
                day_of_week INTEGER,
                is_weekend INTEGER,
                is_vpn INTEGER,
                is_tor INTEGER,
                is_fraud INTEGER DEFAULT 0,
                created_at TIMESTAMP,
                ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        self.duck.execute("""
            CREATE TABLE IF NOT EXISTS features_fraud (
                transaction_id VARCHAR PRIMARY KEY,
                amount_ngn DOUBLE,
                hour_of_day INTEGER,
                day_of_week INTEGER,
                is_weekend INTEGER,
                is_new_device INTEGER,
                is_vpn INTEGER,
                is_tor INTEGER,
                tx_count_1h DOUBLE,
                tx_count_24h DOUBLE,
                tx_count_7d DOUBLE,
                tx_amount_1h DOUBLE,
                tx_amount_24h DOUBLE,
                unique_merchants_24h DOUBLE,
                avg_amount_7d DOUBLE,
                max_amount_7d DOUBLE,
                time_on_site_sec DOUBLE,
                pages_visited DOUBLE,
                cart_abandon_rate DOUBLE,
                days_since_account_creation DOUBLE,
                device_age_days DOUBLE,
                is_fraud INTEGER,
                feature_date DATE,
                computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        self.duck.execute("""
            CREATE TABLE IF NOT EXISTS model_predictions (
                prediction_id VARCHAR PRIMARY KEY,
                transaction_id VARCHAR,
                model_name VARCHAR,
                model_version VARCHAR,
                prediction_score DOUBLE,
                prediction_label INTEGER,
                actual_label INTEGER,
                predicted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        self.duck.execute("""
            CREATE TABLE IF NOT EXISTS drift_metrics (
                metric_id VARCHAR PRIMARY KEY,
                model_name VARCHAR,
                metric_name VARCHAR,
                metric_value DOUBLE,
                threshold DOUBLE,
                is_drifted INTEGER,
                window_start TIMESTAMP,
                window_end TIMESTAMP,
                computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

    def ingest_from_parquet(self, parquet_path: str, table: str = "transactions_raw"):
        """Load synthetic/production data from parquet into the warehouse"""
        df = pd.read_parquet(parquet_path)
        # Map columns to warehouse schema
        if "transaction_id" not in df.columns:
            df["transaction_id"] = [f"tx_{i:08d}" for i in range(len(df))]
        if "customer_id" not in df.columns:
            df["customer_id"] = "unknown"
        if "tenant_id" not in df.columns:
            df["tenant_id"] = "default"
        if "created_at" not in df.columns:
            df["created_at"] = datetime.now()
        # Select only the columns that exist in the warehouse schema
        warehouse_cols = [
            "transaction_id", "customer_id", "tenant_id", "amount_ngn",
            "category", "hour_of_day", "day_of_week", "is_weekend",
            "is_vpn", "is_tor", "is_fraud", "created_at",
        ]
        for col in warehouse_cols:
            if col not in df.columns:
                df[col] = 0 if col not in ("transaction_id", "customer_id", "tenant_id", "category") else "unknown"
        df_insert = df[warehouse_cols].copy()
        cols_str = ", ".join(warehouse_cols)
        self.duck.execute(f"INSERT OR REPLACE INTO {table} ({cols_str}) SELECT {cols_str} FROM df_insert")
        print(f"  Ingested {len(df_insert)} rows into {table}")
        return len(df_insert)

    def compute_fraud_features(self, lookback_days: int = 30):
        """
        Compute point-in-time correct fraud features using window functions.
        This is the feature engineering step.
        """
        print("  Computing fraud features with velocity windows...")
        self.duck.execute("""
            INSERT OR REPLACE INTO features_fraud
            SELECT
                t.transaction_id,
                t.amount_ngn,
                t.hour_of_day,
                t.day_of_week,
                t.is_weekend,
                0 AS is_new_device,
                t.is_vpn,
                t.is_tor,
                -- Velocity features (window functions)
                COUNT(*) OVER (
                    PARTITION BY t.customer_id
                    ORDER BY t.created_at
                    RANGE BETWEEN INTERVAL '1 hour' PRECEDING AND CURRENT ROW
                ) - 1 AS tx_count_1h,
                COUNT(*) OVER (
                    PARTITION BY t.customer_id
                    ORDER BY t.created_at
                    RANGE BETWEEN INTERVAL '24 hours' PRECEDING AND CURRENT ROW
                ) - 1 AS tx_count_24h,
                COUNT(*) OVER (
                    PARTITION BY t.customer_id
                    ORDER BY t.created_at
                    RANGE BETWEEN INTERVAL '7 days' PRECEDING AND CURRENT ROW
                ) - 1 AS tx_count_7d,
                SUM(t.amount_ngn) OVER (
                    PARTITION BY t.customer_id
                    ORDER BY t.created_at
                    RANGE BETWEEN INTERVAL '1 hour' PRECEDING AND CURRENT ROW
                ) - t.amount_ngn AS tx_amount_1h,
                SUM(t.amount_ngn) OVER (
                    PARTITION BY t.customer_id
                    ORDER BY t.created_at
                    RANGE BETWEEN INTERVAL '24 hours' PRECEDING AND CURRENT ROW
                ) - t.amount_ngn AS tx_amount_24h,
                COUNT(DISTINCT t.category) OVER (
                    PARTITION BY t.customer_id
                    ORDER BY t.created_at
                    RANGE BETWEEN INTERVAL '24 hours' PRECEDING AND CURRENT ROW
                ) AS unique_merchants_24h,
                AVG(t.amount_ngn) OVER (
                    PARTITION BY t.customer_id
                    ORDER BY t.created_at
                    RANGE BETWEEN INTERVAL '7 days' PRECEDING AND CURRENT ROW
                ) AS avg_amount_7d,
                MAX(t.amount_ngn) OVER (
                    PARTITION BY t.customer_id
                    ORDER BY t.created_at
                    RANGE BETWEEN INTERVAL '7 days' PRECEDING AND CURRENT ROW
                ) AS max_amount_7d,
                60.0 AS time_on_site_sec,
                5.0 AS pages_visited,
                0.2 AS cart_abandon_rate,
                30.0 AS days_since_account_creation,
                90.0 AS device_age_days,
                t.is_fraud,
                CAST(t.created_at AS DATE) AS feature_date,
                CURRENT_TIMESTAMP AS computed_at
            FROM transactions_raw t
        """)
        count = self.duck.execute("SELECT COUNT(*) FROM features_fraud").fetchone()[0]
        print(f"  Feature store: {count} rows in features_fraud")
        return count

    def get_training_dataloader(
        self,
        feature_table: str = "features_fraud",
        label_col: str = "is_fraud",
        batch_size: int = 512,
        val_split: float = 0.2,
        seq_len: int = 10,
    ) -> Tuple[DataLoader, DataLoader, StandardScaler]:
        """
        Returns (train_loader, val_loader, scaler) ready for PyTorch training.
        """
        FEATURE_COLS = [
            "amount_ngn", "hour_of_day", "day_of_week", "is_weekend",
            "is_new_device", "is_vpn", "is_tor",
            "tx_count_1h", "tx_count_24h", "tx_count_7d",
            "tx_amount_1h", "tx_amount_24h",
            "unique_merchants_24h", "avg_amount_7d", "max_amount_7d",
            "time_on_site_sec", "pages_visited", "cart_abandon_rate",
            "days_since_account_creation", "device_age_days",
        ]
        df = self.duck.execute(
            f"SELECT {', '.join(FEATURE_COLS)}, {label_col} FROM {feature_table}"
        ).df()
        df = df.fillna(0)

        X = df[FEATURE_COLS].values.astype(np.float32)
        y = df[label_col].values.astype(np.float32)

        # Train/val split
        n_val = int(len(X) * val_split)
        idx = np.random.permutation(len(X))
        train_idx, val_idx = idx[n_val:], idx[:n_val]

        scaler = StandardScaler()
        X_train = scaler.fit_transform(X[train_idx])
        X_val = scaler.transform(X[val_idx])

        # Create sequence tensors (repeat single timestep for LSTM)
        def make_seq(arr, seq_len):
            t = torch.FloatTensor(arr)
            return t.unsqueeze(1).repeat(1, seq_len, 1)

        train_ds = TensorDataset(make_seq(X_train, seq_len), torch.FloatTensor(y[train_idx]))
        val_ds = TensorDataset(make_seq(X_val, seq_len), torch.FloatTensor(y[val_idx]))

        train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
        val_loader = DataLoader(val_ds, batch_size=batch_size * 2)

        print(f"  DataLoaders: {len(train_ds)} train / {len(val_ds)} val")
        return train_loader, val_loader, scaler

    def export_delta_snapshot(self, date: Optional[str] = None):
        """Export daily snapshot to Delta Lake (parquet partitioned by date)"""
        date = date or datetime.now().strftime("%Y-%m-%d")
        out_path = DELTA_DIR / f"features_fraud/date={date}"
        out_path.mkdir(parents=True, exist_ok=True)
        df = self.duck.execute(
            f"SELECT * FROM features_fraud WHERE feature_date = '{date}'"
        ).df()
        if len(df) > 0:
            df.to_parquet(out_path / "part-0.parquet", index=False)
            print(f"  Delta snapshot: {len(df)} rows → {out_path}")
        return len(df)

    def extract_from_postgres(self, days_back: int = 30) -> pd.DataFrame:
        """
        Pull real transaction data from the production PostgreSQL database.
        Maps wallet_transactions → fraud feature schema.
        Falls back to synthetic data if DB is empty or unreachable.
        """
        try:
            import psycopg2
            conn = psycopg2.connect(self.db_url)
            cur = conn.cursor()
            cur.execute("""
                SELECT
                    wt.id::text AS transaction_id,
                    wt.wallet_id::text AS customer_id,
                    wt.tenant_id::text AS tenant_id,
                    COALESCE(wt.amount, 0)::float AS amount_ngn,
                    COALESCE(wt.type::text, 'unknown') AS category,
                    EXTRACT(HOUR FROM wt.created_at)::int AS hour_of_day,
                    EXTRACT(DOW FROM wt.created_at)::int AS day_of_week,
                    CASE WHEN EXTRACT(DOW FROM wt.created_at) IN (0,6) THEN 1 ELSE 0 END AS is_weekend,
                    0 AS is_vpn,
                    0 AS is_tor,
                    0 AS is_fraud,
                    wt.created_at
                FROM wallet_transactions wt
                WHERE wt.created_at >= NOW() - INTERVAL '%s days'
                ORDER BY wt.created_at DESC
                LIMIT 50000
            """, (days_back,))
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]
            conn.close()
            if len(rows) > 0:
                df = pd.DataFrame(rows, columns=cols)
                print(f"[Lakehouse] Extracted {len(df)} real transactions from production DB")
                return df
            else:
                print("[Lakehouse] No production transactions found, using synthetic data")
                return self._load_synthetic_fallback()
        except Exception as e:
            print(f"[Lakehouse] DB extraction failed ({e}), using synthetic data")
            return self._load_synthetic_fallback()

    def _load_synthetic_fallback(self) -> pd.DataFrame:
        """Load synthetic training data as fallback when production DB is empty"""
        parquet_path = Path(__file__).parent.parent / "data" / "generated" / "fraud_train.parquet"
        if parquet_path.exists():
            df = pd.read_parquet(parquet_path)
            print(f"[Lakehouse] Loaded {len(df)} synthetic transactions as fallback")
            return df
        return pd.DataFrame()

    def run_full_pipeline(self, days_back: int = 30) -> dict:
        """
        Run the complete ETL pipeline: extract → ingest → compute features → export snapshot.
        Returns a summary dict with row counts and timing.
        """
        import time as _time
        t0 = _time.time()
        raw_df = self.extract_from_postgres(days_back=days_back)
        n_raw = len(raw_df)
        if n_raw > 0:
            tmp_path = str(LAKEHOUSE_DIR / "raw_extract.parquet")
            raw_df.to_parquet(tmp_path, index=False)
            self.ingest_from_parquet(tmp_path, table="transactions_raw")
        n_features = self.compute_fraud_features(lookback_days=days_back)
        n_snapshot = self.export_delta_snapshot()
        elapsed = round(_time.time() - t0, 2)
        return {
            "raw_rows": n_raw,
            "feature_rows": n_features if isinstance(n_features, int) else 0,
            "snapshot_rows": n_snapshot,
            "elapsed_seconds": elapsed,
            "timestamp": datetime.utcnow().isoformat(),
        }

from typing import Optional, Tuple, List
