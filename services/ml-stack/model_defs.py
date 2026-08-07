"""
Model architecture definitions — single source of truth for inference.
======================================================================
These classes are verbatim copies of the architectures in
``models/fraud_gnn_lstm.py`` and ``models/credit_tabnet.py`` (used by
``training/train_all.py``). They are replicated here so that the inference
server, the CLI predictor, and the lakehouse pipeline can reconstruct the
exact modules that the committed state_dicts in ``models/weights/`` were
trained with — without depending on training-only imports (mlflow, etc.).

If you change an architecture in ``models/``, update it here too, otherwise
``load_state_dict`` will fail (which is intentional — it prevents silent
architecture drift).
"""

from typing import Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F


# ── Fraud model (mirrors models/fraud_gnn_lstm.py) ────────────────────────────


class GraphSAGELayer(nn.Module):
    """Simplified GraphSAGE layer for transaction graph"""

    def __init__(self, in_features: int, out_features: int):
        super().__init__()
        self.linear = nn.Linear(in_features * 2, out_features)
        self.bn = nn.BatchNorm1d(out_features)

    def forward(self, x: torch.Tensor, adj: Optional[torch.Tensor] = None) -> torch.Tensor:
        if adj is not None:
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
    Fraud Detection: GNN + LSTM + MLP classifier.

    Input: x_seq of shape (batch, seq_len, input_dim) where input_dim=20
    matches FRAUD_FEATURES in training/train_all.py.
    Returns: (batch,) fraud logits (apply sigmoid for probability).
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

        self.input_bn = nn.BatchNorm1d(input_dim)
        self.feature_embed = nn.Sequential(
            nn.Linear(input_dim, gnn_hidden),
            nn.ReLU(),
            nn.Dropout(dropout),
        )

        self.gnn1 = GraphSAGELayer(gnn_hidden, gnn_hidden)
        self.gnn2 = GraphSAGELayer(gnn_hidden, gnn_hidden)

        self.lstm = nn.LSTM(
            input_size=gnn_hidden,
            hidden_size=lstm_hidden,
            num_layers=lstm_layers,
            batch_first=True,
            dropout=dropout if lstm_layers > 1 else 0,
            bidirectional=True,
        )

        self.attention = nn.Linear(lstm_hidden * 2, 1)

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
        batch_size, seq_len, feat_dim = x_seq.shape

        gnn_out = []
        for t in range(seq_len):
            x_t = x_seq[:, t, :]
            if x_t.size(0) > 1:
                x_t = self.input_bn(x_t)
            x_t = self.feature_embed(x_t)
            x_t = self.gnn1(x_t, adj)
            x_t = self.gnn2(x_t, adj)
            gnn_out.append(x_t)

        gnn_seq = torch.stack(gnn_out, dim=1)
        lstm_out, _ = self.lstm(gnn_seq)

        attn_weights = F.softmax(self.attention(lstm_out), dim=1)
        context = (lstm_out * attn_weights).sum(dim=1)

        logits = self.classifier(context).squeeze(-1)
        return logits

    def predict_proba(self, x_seq: torch.Tensor) -> torch.Tensor:
        with torch.no_grad():
            logits = self.forward(x_seq)
            return torch.sigmoid(logits)


# ── Credit model (mirrors models/credit_tabnet.py) ────────────────────────────


class GLUBlock(nn.Module):
    """Gated Linear Unit block used in TabNet feature transformer"""

    def __init__(self, in_features: int, out_features: int, shared_layer: Optional[nn.Linear] = None):
        super().__init__()
        self.shared = shared_layer
        self.step_layer = nn.Linear(in_features, out_features * 2, bias=False)
        self.bn = nn.BatchNorm1d(out_features * 2)
        self.out_features = out_features

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.shared is not None:
            h = self.shared(x)
        else:
            h = x
        h = h + self.step_layer(x)
        if h.size(0) > 1:
            h = self.bn(h)
        h1, h2 = h.chunk(2, dim=-1)
        return h1 * torch.sigmoid(h2)


class TabNet(nn.Module):
    """
    TabNet for credit scoring.

    Input: (batch, input_dim) where input_dim=15 matches CREDIT_FEATURES in
    training/train_all.py. Returns (logits, entropy_loss).
    """

    def __init__(
        self,
        input_dim: int = 17,
        n_steps: int = 5,
        n_shared: int = 2,
        n_independent: int = 2,
        hidden_dim: int = 64,
        output_dim: int = 1,
        momentum: float = 0.02,
        epsilon: float = 1e-5,
        virtual_batch_size: int = 256,
        sparsity_reg: float = 1e-5,
        gamma: float = 1.3,
    ):
        super().__init__()
        self.input_dim = input_dim
        self.n_steps = n_steps
        self.hidden_dim = hidden_dim
        self.sparsity_reg = sparsity_reg
        self.gamma = gamma

        self.initial_bn = nn.BatchNorm1d(input_dim, momentum=momentum, eps=epsilon)

        self.shared_fc1 = nn.Linear(input_dim, hidden_dim * 2, bias=False)
        self.shared_fc2 = nn.Linear(hidden_dim, hidden_dim * 2, bias=False)
        self.shared_bn1 = nn.BatchNorm1d(hidden_dim * 2, momentum=momentum, eps=epsilon)
        self.shared_bn2 = nn.BatchNorm1d(hidden_dim * 2, momentum=momentum, eps=epsilon)

        self.step_feature_transformers = nn.ModuleList([
            nn.Sequential(
                nn.Linear(hidden_dim, hidden_dim * 2, bias=False),
                nn.BatchNorm1d(hidden_dim * 2, momentum=momentum, eps=epsilon),
            ) for _ in range(n_steps)
        ])

        self.attention_transformers = nn.ModuleList([
            nn.Sequential(
                nn.Linear(hidden_dim, input_dim, bias=False),
                nn.BatchNorm1d(input_dim, momentum=momentum, eps=epsilon),
            ) for _ in range(n_steps)
        ])

        self.final_fc = nn.Linear(hidden_dim, output_dim)

        self._feature_importances: Optional[torch.Tensor] = None

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        x = self.initial_bn(x)

        B = x.size(0)
        prior_scales = torch.ones(B, self.input_dim, device=x.device)
        h = torch.zeros(B, self.hidden_dim, device=x.device)
        total_entropy = torch.zeros(1, device=x.device)
        step_outputs = []
        feature_importances = []

        for step in range(self.n_steps):
            attn_input = self.attention_transformers[step](h)
            attn_input = attn_input * prior_scales
            attn_weights = F.softmax(attn_input, dim=-1)
            feature_importances.append(attn_weights)

            prior_scales = prior_scales * (self.gamma - attn_weights)

            masked_x = attn_weights * x

            h_shared = self.shared_fc1(masked_x)
            h_shared_bn = self.shared_bn1(h_shared)
            h1, h2 = h_shared_bn.chunk(2, dim=-1)
            h_step = h1 * torch.sigmoid(h2)

            step_out = self.step_feature_transformers[step](h_step)
            s1, s2 = step_out.chunk(2, dim=-1)
            h = (h + s1 * torch.sigmoid(s2)) * (0.5 ** 0.5)

            step_outputs.append(F.relu(h))

            total_entropy += (-attn_weights * torch.log(attn_weights + 1e-15)).sum(dim=-1).mean()

        final_repr = sum(step_outputs)
        logits = self.final_fc(final_repr).squeeze(-1)

        self._feature_importances = torch.stack(feature_importances, dim=0).mean(dim=0)

        entropy_loss = total_entropy * self.sparsity_reg
        return logits, entropy_loss

    def get_feature_importances(self) -> Optional[torch.Tensor]:
        return self._feature_importances

    def predict_proba(self, x: torch.Tensor) -> torch.Tensor:
        with torch.no_grad():
            logits, _ = self.forward(x)
            return torch.sigmoid(logits)
