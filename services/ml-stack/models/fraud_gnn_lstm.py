"""
Fraud Detection Model: Graph Neural Network + LSTM
===================================================
Architecture:
  - GNN layer (GraphSAGE) to learn customer-merchant relationship embeddings
  - LSTM layer to capture temporal transaction sequences
  - MLP classifier head

Trained on Nigerian WhatsApp Commerce transaction data.
Target metric: AUPRC (area under precision-recall curve) — preferred over AUC-ROC
for imbalanced fraud datasets.
"""

import json
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler


class TransactionSequenceDataset(Dataset):
    """Dataset for LSTM temporal sequence modeling"""
    def __init__(self, features: np.ndarray, labels: np.ndarray, seq_len: int = 10):
        self.features = torch.FloatTensor(features)
        self.labels = torch.FloatTensor(labels)
        self.seq_len = seq_len

    def __len__(self):
        return len(self.labels)

    def __getitem__(self, idx):
        # For simplicity, use the same feature vector repeated (in production: use real sequences)
        seq = self.features[idx].unsqueeze(0).repeat(self.seq_len, 1)
        return seq, self.labels[idx]


class GraphSAGELayer(nn.Module):
    """Simplified GraphSAGE layer for transaction graph"""
    def __init__(self, in_features: int, out_features: int):
        super().__init__()
        self.linear = nn.Linear(in_features * 2, out_features)
        self.bn = nn.BatchNorm1d(out_features)

    def forward(self, x: torch.Tensor, adj: Optional[torch.Tensor] = None) -> torch.Tensor:
        if adj is not None:
            # Aggregate neighbor features
            neighbor_agg = torch.mm(adj, x)
            combined = torch.cat([x, neighbor_agg], dim=1)
        else:
            combined = torch.cat([x, x], dim=1)
        out = self.linear(combined)
        if out.size(0) > 1:
            out = self.bn(out)
        return F.relu(out)


class FraudGNNLSTM(nn.Module):
    """
    Fraud Detection: GNN + LSTM + MLP classifier

    Input features (tabular):
      - amount_ngn, hour_of_day, day_of_week, is_weekend
      - is_new_device, is_vpn, is_tor
      - tx_count_1h, tx_count_24h, tx_count_7d
      - tx_amount_1h, tx_amount_24h
      - unique_merchants_24h, avg_amount_7d, max_amount_7d
      - time_on_site_sec, pages_visited, cart_abandon_rate
      - days_since_account_creation, device_age_days
    """
    def __init__(
        self,
        input_dim: int = 20,
        gnn_hidden: int = 64,
        lstm_hidden: int = 128,
        lstm_layers: int = 2,
        mlp_hidden: int = 64,
        dropout: float = 0.3,
    ):
        super().__init__()
        self.input_dim = input_dim

        # Feature embedding
        self.input_bn = nn.BatchNorm1d(input_dim)
        self.feature_embed = nn.Sequential(
            nn.Linear(input_dim, gnn_hidden),
            nn.ReLU(),
            nn.Dropout(dropout),
        )

        # GNN layers
        self.gnn1 = GraphSAGELayer(gnn_hidden, gnn_hidden)
        self.gnn2 = GraphSAGELayer(gnn_hidden, gnn_hidden)

        # LSTM for temporal patterns
        self.lstm = nn.LSTM(
            input_size=gnn_hidden,
            hidden_size=lstm_hidden,
            num_layers=lstm_layers,
            batch_first=True,
            dropout=dropout if lstm_layers > 1 else 0,
            bidirectional=True,
        )

        # Attention over LSTM outputs
        self.attention = nn.Linear(lstm_hidden * 2, 1)

        # MLP classifier
        self.classifier = nn.Sequential(
            nn.Linear(lstm_hidden * 2, mlp_hidden),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(mlp_hidden, mlp_hidden // 2),
            nn.ReLU(),
            nn.Dropout(dropout / 2),
            nn.Linear(mlp_hidden // 2, 1),
        )

    def forward(self, x_seq: torch.Tensor, adj: Optional[torch.Tensor] = None) -> torch.Tensor:
        """
        x_seq: (batch, seq_len, input_dim)
        Returns: (batch,) fraud probability logits
        """
        batch_size, seq_len, feat_dim = x_seq.shape

        # Process each timestep through GNN
        gnn_out = []
        for t in range(seq_len):
            x_t = x_seq[:, t, :]
            if x_t.size(0) > 1:
                x_t = self.input_bn(x_t)
            x_t = self.feature_embed(x_t)
            x_t = self.gnn1(x_t, adj)
            x_t = self.gnn2(x_t, adj)
            gnn_out.append(x_t)

        # Stack into sequence: (batch, seq_len, gnn_hidden)
        gnn_seq = torch.stack(gnn_out, dim=1)

        # LSTM
        lstm_out, _ = self.lstm(gnn_seq)  # (batch, seq_len, lstm_hidden*2)

        # Attention pooling
        attn_weights = F.softmax(self.attention(lstm_out), dim=1)  # (batch, seq_len, 1)
        context = (lstm_out * attn_weights).sum(dim=1)  # (batch, lstm_hidden*2)

        # Classify
        logits = self.classifier(context).squeeze(-1)
        return logits

    def predict_proba(self, x_seq: torch.Tensor) -> torch.Tensor:
        """Returns fraud probability [0, 1]"""
        with torch.no_grad():
            logits = self.forward(x_seq)
            return torch.sigmoid(logits)


