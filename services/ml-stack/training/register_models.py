"""
Register existing trained model weights into MLflow Model Registry.
Runs a quick validation pass to compute metrics, then logs to MLflow.
Memory-efficient: loads one model at a time.
"""
import os
import sys
import json
import time
from pathlib import Path
import numpy as np
import pandas as pd
import torch
import mlflow
import mlflow.pytorch
from sklearn.metrics import roc_auc_score, average_precision_score, f1_score
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).parent.parent))
from models.fraud_gnn_lstm import FraudGNNLSTM, TransactionSequenceDataset
from models.credit_tabnet import TabNet
from torch.utils.data import DataLoader

WEIGHTS_DIR = Path(__file__).parent.parent / "models" / "weights"
DATA_DIR    = Path(__file__).parent.parent / "data" / "generated"
DEVICE      = torch.device("cpu")  # CPU only to save memory

MLFLOW_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000")
mlflow.set_tracking_uri(MLFLOW_URI)

FRAUD_FEATURES = [
    "amount_ngn", "hour_of_day", "day_of_week", "is_weekend",
    "is_new_device", "is_vpn", "is_tor",
    "tx_count_1h", "tx_count_24h", "tx_count_7d",
    "tx_amount_1h", "tx_amount_24h",
    "unique_merchants_24h", "avg_amount_7d", "max_amount_7d",
    "time_on_site_sec", "pages_visited", "cart_abandon_rate",
    "days_since_account_creation", "device_age_days",
]

CREDIT_FEATURES = [
    "business_age_months", "monthly_revenue_ngn", "debt_to_revenue_ratio",
    "payment_history_score", "whatsapp_order_count_30d", "avg_order_value_ngn",
    "customer_return_rate", "inventory_turnover_days", "bank_account_age_months",
    "num_product_categories", "has_physical_store", "has_cac_registration",
    "social_media_followers", "whatsapp_response_time_min", "refund_rate",
]

def register_fraud_model():
    print("\n=== Registering Fraud Detection Model ===")
    weight_path = WEIGHTS_DIR / "fraud_gnn_lstm.pt"
    if not weight_path.exists():
        print(f"  Weight file not found: {weight_path}")
        return

    mlflow.set_experiment("fraud_detection")

    # Load validation data (small subset to save memory)
    val_df = pd.read_parquet(DATA_DIR / "fraud_val.parquet").sample(min(2000, 5000), random_state=42)
    scaler = StandardScaler()
    # Fit scaler on train sample
    train_df = pd.read_parquet(DATA_DIR / "fraud_train.parquet").sample(5000, random_state=42)
    scaler.fit(train_df[FRAUD_FEATURES].fillna(0).values)
    del train_df

    X_val = scaler.transform(val_df[FRAUD_FEATURES].fillna(0).values).astype(np.float32)
    y_val = val_df["is_fraud"].values.astype(np.float32)

    # Load model
    model = FraudGNNLSTM(input_dim=len(FRAUD_FEATURES)).to(DEVICE)
    checkpoint = torch.load(weight_path, map_location=DEVICE, weights_only=False)
    state = checkpoint["model_state_dict"] if isinstance(checkpoint, dict) and "model_state_dict" in checkpoint else checkpoint
    saved_auprc = checkpoint.get("best_auprc") if isinstance(checkpoint, dict) else None
    model.load_state_dict(state)
    model.eval()

    # Evaluate
    from models.fraud_gnn_lstm import TransactionSequenceDataset
    val_ds = TransactionSequenceDataset(X_val, y_val, seq_len=10)
    val_loader = DataLoader(val_ds, batch_size=256)
    preds, labels = [], []
    with torch.no_grad():
        for xb, yb in val_loader:
            logits = model(xb.to(DEVICE)).squeeze()
            preds.extend(torch.sigmoid(logits).cpu().numpy().tolist())
            labels.extend(yb.numpy().tolist())
    preds_arr = np.array(preds)
    labels_arr = np.array(labels)
    auroc = roc_auc_score(labels_arr, preds_arr)
    auprc = average_precision_score(labels_arr, preds_arr)
    f1 = f1_score(labels_arr, (preds_arr > 0.5).astype(int))
    print(f"  AUROC={auroc:.4f}  AUPRC={auprc:.4f}  F1={f1:.4f}")

    with mlflow.start_run(run_name="fraud_gnn_lstm_registered"):
        mlflow.log_params({
            "model": "FraudGNNLSTM", "input_dim": len(FRAUD_FEATURES),
            "architecture": "GNN+LSTM", "device": str(DEVICE),
            "weight_file": str(weight_path),
        })
        mlflow.log_metrics({"auroc": auroc, "auprc": auprc, "f1": f1})
        mlflow.pytorch.log_model(model, "fraud_model",
            registered_model_name="fraud_detection_gnn_lstm",
            serialization_format="pickle")
        print(f"  Registered as 'fraud_detection_gnn_lstm'")
    del model, val_ds, val_loader

def register_credit_model():
    print("\n=== Registering Credit Scoring Model ===")
    weight_path = WEIGHTS_DIR / "credit_tabnet.pt"
    if not weight_path.exists():
        print(f"  Weight file not found: {weight_path}")
        return

    mlflow.set_experiment("credit_scoring")

    val_df = pd.read_parquet(DATA_DIR / "credit_val.parquet").sample(min(2000, len(pd.read_parquet(DATA_DIR / "credit_val.parquet"))), random_state=42)
    train_df = pd.read_parquet(DATA_DIR / "credit_train.parquet").sample(3000, random_state=42)
    scaler = StandardScaler()
    scaler.fit(train_df[CREDIT_FEATURES].fillna(0).values)
    del train_df

    X_val = scaler.transform(val_df[CREDIT_FEATURES].fillna(0).values).astype(np.float32)
    y_val = val_df["is_default_90d"].values.astype(np.float32)

    model = TabNet(input_dim=len(CREDIT_FEATURES)).to(DEVICE)
    checkpoint = torch.load(weight_path, map_location=DEVICE, weights_only=False)
    state = checkpoint["model_state_dict"] if isinstance(checkpoint, dict) and "model_state_dict" in checkpoint else checkpoint
    saved_auprc = checkpoint.get("best_auprc") if isinstance(checkpoint, dict) else None
    model.load_state_dict(state)
    model.eval()

    import torch.nn.functional as F
    X_t = torch.tensor(X_val)
    with torch.no_grad():
        logits = model(X_t).squeeze()
        preds = torch.sigmoid(logits).numpy()
    auroc = roc_auc_score(y_val, preds)
    f1 = f1_score(y_val, (preds > 0.5).astype(int))
    print(f"  AUROC={auroc:.4f}  F1={f1:.4f}")

    with mlflow.start_run(run_name="credit_tabnet_registered"):
        mlflow.log_params({
            "model": "TabNet", "input_dim": len(CREDIT_FEATURES),
            "architecture": "TabNet", "device": str(DEVICE),
            "weight_file": str(weight_path),
        })
        mlflow.log_metrics({"auroc": auroc, "f1": f1})
        mlflow.pytorch.log_model(model, "credit_model",
            registered_model_name="credit_scoring_tabnet",
            serialization_format="pickle")
        print(f"  Registered as 'credit_scoring_tabnet'")
    del model

if __name__ == "__main__":
    print(f"MLflow tracking URI: {MLFLOW_URI}")
    register_fraud_model()
    register_credit_model()
    print("\n=== All models registered in MLflow ===")
    # Write a summary JSON for the Node.js server to read
    summary = {
        "registeredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "models": [
            {"name": "fraud_detection_gnn_lstm", "weightFile": "fraud_gnn_lstm.pt", "status": "registered"},
            {"name": "credit_scoring_tabnet",    "weightFile": "credit_tabnet.pt",   "status": "registered"},
        ]
    }
    out = WEIGHTS_DIR / "registry_summary.json"
    out.write_text(json.dumps(summary, indent=2))
    print(f"Summary written to {out}")
