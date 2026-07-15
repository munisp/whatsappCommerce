"""
Ray Distributed Training Configuration
========================================
Scales fraud detection training across multiple GPUs/nodes using Ray Train.
Falls back to single-node training if Ray is not available.
"""

import os
import sys
from pathlib import Path
from typing import Optional

import torch
import torch.nn as nn
from torch.utils.data import DataLoader

try:
    import ray
    import ray.train
    from ray.train import ScalingConfig, RunConfig
    from ray.train.torch import TorchTrainer
    RAY_AVAILABLE = True
except ImportError:
    RAY_AVAILABLE = False
    print("Ray not available — falling back to single-node training")

sys.path.insert(0, str(Path(__file__).parent))
from models.fraud_gnn_lstm import FraudGNNLSTM


def train_func_ray(config: dict):
    """
    Ray Train worker function — runs on each distributed worker.
    Each worker gets a shard of the training data.
    """
    import torch.distributed as dist
    from ray.train.torch import get_device, prepare_model, prepare_data_loader
    import pandas as pd
    import numpy as np
    from sklearn.preprocessing import StandardScaler
    from training.train_all import FRAUD_FEATURES
    from models.fraud_gnn_lstm import TransactionSequenceDataset
    from torch.utils.data import DataLoader, WeightedRandomSampler

    device = get_device()
    epochs = config.get("epochs", 30)
    batch_size = config.get("batch_size", 512)
    lr = config.get("lr", 1e-3)
    data_path = config.get("data_path", "data/generated/fraud_train.parquet")

    df = pd.read_parquet(data_path)
    scaler = StandardScaler()
    X = scaler.fit_transform(df[FRAUD_FEATURES].fillna(0).values).astype("float32")
    y = df["is_fraud"].values.astype("float32")

    fraud_rate = y.mean()
    weights = np.where(y == 1, 1.0 / fraud_rate, 1.0 / (1 - fraud_rate))
    sampler = WeightedRandomSampler(weights, len(weights))
    dataset = TransactionSequenceDataset(X, y, seq_len=10)
    loader = DataLoader(dataset, batch_size=batch_size, sampler=sampler)
    loader = prepare_data_loader(loader)

    model = FraudGNNLSTM(input_dim=len(FRAUD_FEATURES)).to(device)
    model = prepare_model(model)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    pos_weight = torch.tensor([(1 - fraud_rate) / fraud_rate]).to(device)
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    for epoch in range(epochs):
        model.train()
        total_loss = 0.0
        for x_seq, y_batch in loader:
            optimizer.zero_grad()
            logits = model(x_seq)
            loss = criterion(logits, y_batch)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            total_loss += loss.item()
        ray.train.report({"epoch": epoch, "loss": total_loss / len(loader)})


def launch_ray_training(
    num_workers: int = 2,
    use_gpu: bool = False,
    epochs: int = 30,
    ray_address: Optional[str] = None,
):
    """Launch distributed training via Ray Train"""
    if not RAY_AVAILABLE:
        print("Ray not available. Use train_all.py for single-node training.")
        return

    ray.init(address=ray_address or os.getenv("RAY_ADDRESS", "auto"), ignore_reinit_error=True)

    trainer = TorchTrainer(
        train_loop_per_worker=train_func_ray,
        train_loop_config={
            "epochs": epochs,
            "batch_size": 512,
            "lr": 1e-3,
            "data_path": str(Path(__file__).parent / "data/generated/fraud_train.parquet"),
        },
        scaling_config=ScalingConfig(
            num_workers=num_workers,
            use_gpu=use_gpu,
            resources_per_worker={"CPU": 2, "GPU": 1 if use_gpu else 0},
        ),
        run_config=RunConfig(name="fraud_detection_distributed"),
    )
    result = trainer.fit()
    print(f"Ray training complete: {result.metrics}")
    return result


if __name__ == "__main__":
    launch_ray_training(num_workers=2, use_gpu=False, epochs=5)


