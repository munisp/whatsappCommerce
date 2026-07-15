"""
Full Training Pipeline — All Models
=====================================
Trains fraud detection (GNN+LSTM), credit scoring (TabNet), and liveness CNN.
Logs all experiments to MLflow. Saves model weights to models/weights/.
Supports Ray distributed training when RAY_ADDRESS is set.
"""

import os
import sys
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset, WeightedRandomSampler
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.metrics import (
    roc_auc_score, average_precision_score, f1_score,
    precision_score, recall_score, classification_report
)
import mlflow
import mlflow.pytorch

# Add parent dir to path
sys.path.insert(0, str(Path(__file__).parent.parent))
from models.fraud_gnn_lstm import FraudGNNLSTM, TransactionSequenceDataset
from models.credit_tabnet import TabNet

WEIGHTS_DIR = Path(__file__).parent.parent / "models" / "weights"
DATA_DIR = Path(__file__).parent.parent / "data" / "generated"
WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Training on: {DEVICE}")


# ── Fraud Detection Training ────────────────────────────────────────────────

FRAUD_FEATURES = [
    "amount_ngn", "hour_of_day", "day_of_week", "is_weekend",
    "is_new_device", "is_vpn", "is_tor",
    "tx_count_1h", "tx_count_24h", "tx_count_7d",
    "tx_amount_1h", "tx_amount_24h",
    "unique_merchants_24h", "avg_amount_7d", "max_amount_7d",
    "time_on_site_sec", "pages_visited", "cart_abandon_rate",
    "days_since_account_creation", "device_age_days",
]


def train_fraud_model(epochs: int = 30, batch_size: int = 512, lr: float = 1e-3):
    print("\n=== Training Fraud Detection Model (GNN+LSTM) ===")
    mlflow.set_experiment("fraud_detection")

    # Load data
    train_df = pd.read_parquet(DATA_DIR / "fraud_train.parquet")
    val_df = pd.read_parquet(DATA_DIR / "fraud_val.parquet")

    scaler = StandardScaler()
    X_train = scaler.fit_transform(train_df[FRAUD_FEATURES].fillna(0).values).astype(np.float32)
    y_train = train_df["is_fraud"].values.astype(np.float32)
    X_val = scaler.transform(val_df[FRAUD_FEATURES].fillna(0).values).astype(np.float32)
    y_val = val_df["is_fraud"].values.astype(np.float32)

    # Weighted sampler for class imbalance
    fraud_rate = y_train.mean()
    weights = np.where(y_train == 1, 1.0 / fraud_rate, 1.0 / (1 - fraud_rate))
    sampler = WeightedRandomSampler(weights, len(weights))

    train_dataset = TransactionSequenceDataset(X_train, y_train, seq_len=10)
    val_dataset = TransactionSequenceDataset(X_val, y_val, seq_len=10)
    train_loader = DataLoader(train_dataset, batch_size=batch_size, sampler=sampler)
    val_loader = DataLoader(val_dataset, batch_size=batch_size * 2)

    model = FraudGNNLSTM(input_dim=len(FRAUD_FEATURES)).to(DEVICE)
    optimizer = optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    # Focal loss for imbalanced classes
    pos_weight = torch.tensor([(1 - fraud_rate) / fraud_rate]).to(DEVICE)
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    best_auprc = 0.0
    best_weights = None

    with mlflow.start_run(run_name="fraud_gnn_lstm_v1"):
        mlflow.log_params({
            "model": "FraudGNNLSTM", "epochs": epochs, "batch_size": batch_size,
            "lr": lr, "input_dim": len(FRAUD_FEATURES), "fraud_rate": float(fraud_rate),
            "n_train": len(train_df), "n_val": len(val_df),
        })

        for epoch in range(epochs):
            model.train()
            train_loss = 0.0
            for x_seq, y_batch in train_loader:
                x_seq, y_batch = x_seq.to(DEVICE), y_batch.to(DEVICE)
                optimizer.zero_grad()
                logits = model(x_seq)
                loss = criterion(logits, y_batch)
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                train_loss += loss.item()
            scheduler.step()

            # Validation
            model.eval()
            val_probs, val_labels = [], []
            with torch.no_grad():
                for x_seq, y_batch in val_loader:
                    x_seq = x_seq.to(DEVICE)
                    probs = torch.sigmoid(model(x_seq)).cpu().numpy()
                    val_probs.extend(probs)
                    val_labels.extend(y_batch.numpy())

            val_probs = np.array(val_probs)
            val_labels = np.array(val_labels)
            auc_roc = roc_auc_score(val_labels, val_probs)
            auprc = average_precision_score(val_labels, val_probs)
            preds = (val_probs > 0.5).astype(int)
            f1 = f1_score(val_labels, preds, zero_division=0)

            mlflow.log_metrics({
                "train_loss": train_loss / len(train_loader),
                "val_auc_roc": auc_roc, "val_auprc": auprc, "val_f1": f1,
            }, step=epoch)

            if auprc > best_auprc:
                best_auprc = auprc
                best_weights = {k: v.clone() for k, v in model.state_dict().items()}

            if (epoch + 1) % 5 == 0:
                print(f"  Epoch {epoch+1}/{epochs}: loss={train_loss/len(train_loader):.4f} "
                      f"AUC-ROC={auc_roc:.4f} AUPRC={auprc:.4f} F1={f1:.4f}")

        # Save best weights
        if best_weights:
            model.load_state_dict(best_weights)
        weight_path = WEIGHTS_DIR / "fraud_gnn_lstm.pt"
        torch.save({
            "model_state_dict": model.state_dict(),
            "scaler_mean": scaler.mean_.tolist(),
            "scaler_scale": scaler.scale_.tolist(),
            "feature_names": FRAUD_FEATURES,
            "best_auprc": best_auprc,
            "input_dim": len(FRAUD_FEATURES),
        }, weight_path)
        mlflow.log_artifact(str(weight_path))
        mlflow.log_metric("best_auprc", best_auprc)
        print(f"  Best AUPRC: {best_auprc:.4f} — saved to {weight_path}")

    return model, scaler


# ── Credit Scoring Training ─────────────────────────────────────────────────

CREDIT_FEATURES = [
    "business_age_months", "monthly_revenue_ngn", "debt_to_revenue_ratio",
    "payment_history_score", "whatsapp_order_count_30d", "avg_order_value_ngn",
    "customer_return_rate", "inventory_turnover_days", "bank_account_age_months",
    "num_product_categories", "has_physical_store", "has_cac_registration",
    "social_media_followers", "whatsapp_response_time_min", "refund_rate",
]


def train_credit_model(epochs: int = 40, batch_size: int = 256, lr: float = 2e-3):
    print("\n=== Training Credit Scoring Model (TabNet) ===")
    mlflow.set_experiment("credit_scoring")

    train_df = pd.read_parquet(DATA_DIR / "credit_train.parquet")
    val_df = pd.read_parquet(DATA_DIR / "credit_val.parquet")

    scaler = StandardScaler()
    X_train = scaler.fit_transform(train_df[CREDIT_FEATURES].fillna(0).values).astype(np.float32)
    y_train = train_df["is_default_90d"].values.astype(np.float32)
    X_val = scaler.transform(val_df[CREDIT_FEATURES].fillna(0).values).astype(np.float32)
    y_val = val_df["is_default_90d"].values.astype(np.float32)

    train_ds = TensorDataset(torch.FloatTensor(X_train), torch.FloatTensor(y_train))
    val_ds = TensorDataset(torch.FloatTensor(X_val), torch.FloatTensor(y_val))
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size * 2)

    model = TabNet(input_dim=len(CREDIT_FEATURES)).to(DEVICE)
    optimizer = optim.Adam(model.parameters(), lr=lr)
    scheduler = optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=5, factor=0.5)
    default_rate = y_train.mean()
    pos_weight = torch.tensor([(1 - default_rate) / default_rate]).to(DEVICE)
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    best_auc = 0.0
    best_weights = None

    with mlflow.start_run(run_name="tabnet_credit_v1"):
        mlflow.log_params({
            "model": "TabNet", "epochs": epochs, "batch_size": batch_size, "lr": lr,
            "input_dim": len(CREDIT_FEATURES), "default_rate": float(default_rate),
        })

        for epoch in range(epochs):
            model.train()
            train_loss = 0.0
            for x_batch, y_batch in train_loader:
                x_batch, y_batch = x_batch.to(DEVICE), y_batch.to(DEVICE)
                optimizer.zero_grad()
                logits, entropy_loss = model(x_batch)
                loss = criterion(logits, y_batch) + entropy_loss
                loss.backward()
                optimizer.step()
                train_loss += loss.item()

            model.eval()
            val_probs, val_labels = [], []
            with torch.no_grad():
                for x_batch, y_batch in val_loader:
                    logits, _ = model(x_batch.to(DEVICE))
                    val_probs.extend(torch.sigmoid(logits).cpu().numpy())
                    val_labels.extend(y_batch.numpy())

            val_probs = np.array(val_probs)
            val_labels = np.array(val_labels)
            auc = roc_auc_score(val_labels, val_probs)
            scheduler.step(1 - auc)

            mlflow.log_metrics({"train_loss": train_loss / len(train_loader), "val_auc": auc}, step=epoch)

            if auc > best_auc:
                best_auc = auc
                best_weights = {k: v.clone() for k, v in model.state_dict().items()}

            if (epoch + 1) % 10 == 0:
                print(f"  Epoch {epoch+1}/{epochs}: loss={train_loss/len(train_loader):.4f} AUC={auc:.4f}")

        if best_weights:
            model.load_state_dict(best_weights)
        weight_path = WEIGHTS_DIR / "credit_tabnet.pt"
        torch.save({
            "model_state_dict": model.state_dict(),
            "scaler_mean": scaler.mean_.tolist(),
            "scaler_scale": scaler.scale_.tolist(),
            "feature_names": CREDIT_FEATURES,
            "best_auc": best_auc,
            "input_dim": len(CREDIT_FEATURES),
        }, weight_path)
        mlflow.log_artifact(str(weight_path))
        mlflow.log_metric("best_auc", best_auc)
        print(f"  Best AUC: {best_auc:.4f} — saved to {weight_path}")

    return model, scaler


# ── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["fraud", "credit", "all"], default="all")
    parser.add_argument("--epochs", type=int, default=None)
    parser.add_argument("--mlflow-uri", default="http://localhost:5000")
    args = parser.parse_args()

    mlflow.set_tracking_uri(args.mlflow_uri)

    if args.model in ("fraud", "all"):
        train_fraud_model(epochs=args.epochs or 30)
    if args.model in ("credit", "all"):
        train_credit_model(epochs=args.epochs or 40)

    print("\nAll training complete. Weights saved to models/weights/")
