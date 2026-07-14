"""
Credit Scoring Model: TabNet
============================
TabNet uses sequential attention to select relevant features at each step,
providing interpretable feature importance — critical for credit decisions
that must be explainable under Nigerian CBN lending regulations.

Architecture:
  - Feature transformer with shared + step-specific layers
  - Sequential attention mechanism
  - Sparse feature selection (interpretable)
"""

import torch
import torch.nn as nn
import torch.nn.functional as F

from typing import Optional, Tuple


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
        return h1 * torch.sigmoid(h2)  # GLU activation


class TabNet(nn.Module):
    """
    TabNet for credit scoring.

    Input features (17):
      - business_age_months, monthly_revenue_ngn, debt_to_revenue_ratio
      - payment_history_score, whatsapp_order_count_30d, avg_order_value_ngn
      - customer_return_rate, inventory_turnover_days, bank_account_age_months
      - num_product_categories, has_physical_store, has_cac_registration
      - social_media_followers, whatsapp_response_time_min, refund_rate
      - state_encoded (one-hot → PCA to 2 dims)
    Output: default probability [0, 1]
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

        # Input batch norm
        self.initial_bn = nn.BatchNorm1d(input_dim, momentum=momentum, eps=epsilon)

        # Shared layers across all steps
        self.shared_fc1 = nn.Linear(input_dim, hidden_dim * 2, bias=False)
        self.shared_fc2 = nn.Linear(hidden_dim, hidden_dim * 2, bias=False)
        self.shared_bn1 = nn.BatchNorm1d(hidden_dim * 2, momentum=momentum, eps=epsilon)
        self.shared_bn2 = nn.BatchNorm1d(hidden_dim * 2, momentum=momentum, eps=epsilon)

        # Step-specific layers
        self.step_feature_transformers = nn.ModuleList([
            nn.Sequential(
                nn.Linear(hidden_dim, hidden_dim * 2, bias=False),
                nn.BatchNorm1d(hidden_dim * 2, momentum=momentum, eps=epsilon),
            ) for _ in range(n_steps)
        ])

        # Attention transformers
        self.attention_transformers = nn.ModuleList([
            nn.Sequential(
                nn.Linear(hidden_dim, input_dim, bias=False),
                nn.BatchNorm1d(input_dim, momentum=momentum, eps=epsilon),
            ) for _ in range(n_steps)
        ])

        # Final output
        self.final_fc = nn.Linear(hidden_dim, output_dim)

        self._feature_importances: Optional[torch.Tensor] = None

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        Returns: (logits, entropy_loss)
        entropy_loss is the sparsity regularization term for feature selection.
        """
        x = self.initial_bn(x)

        B = x.size(0)
        prior_scales = torch.ones(B, self.input_dim, device=x.device)
        complementary_factor = torch.zeros(B, self.input_dim, device=x.device)
        h = torch.zeros(B, self.hidden_dim, device=x.device)
        total_entropy = torch.zeros(1, device=x.device)
        step_outputs = []
        feature_importances = []

        for step in range(self.n_steps):
            # Attention
            attn_input = self.attention_transformers[step](h)
            attn_input = attn_input * prior_scales
            attn_weights = F.softmax(attn_input, dim=-1)  # (B, input_dim)
            feature_importances.append(attn_weights)

            # Update prior scales (penalize re-using same features)
            prior_scales = prior_scales * (self.gamma - attn_weights)

            # Masked features
            masked_x = attn_weights * x  # (B, input_dim)

            # Feature transformer: shared + step-specific
            h_shared = self.shared_fc1(masked_x)
            h_shared_bn = self.shared_bn1(h_shared)
            h1, h2 = h_shared_bn.chunk(2, dim=-1)
            h_step = h1 * torch.sigmoid(h2)  # GLU

            step_out = self.step_feature_transformers[step](h_step)
            step_out_bn = step_out
            s1, s2 = step_out_bn.chunk(2, dim=-1)
            h = (h + s1 * torch.sigmoid(s2)) * (0.5 ** 0.5)

            step_outputs.append(F.relu(h))

            # Entropy for sparsity regularization
            total_entropy += (-attn_weights * torch.log(attn_weights + 1e-15)).sum(dim=-1).mean()

        # Aggregate step outputs
        final_repr = sum(step_outputs)
        logits = self.final_fc(final_repr).squeeze(-1)

        # Store feature importances
        self._feature_importances = torch.stack(feature_importances, dim=0).mean(dim=0)

        entropy_loss = total_entropy * self.sparsity_reg
        return logits, entropy_loss

    def get_feature_importances(self) -> Optional[torch.Tensor]:
        """Returns mean attention weights across steps (feature importance scores)"""
        return self._feature_importances

    def predict_proba(self, x: torch.Tensor) -> torch.Tensor:
        with torch.no_grad():
            logits, _ = self.forward(x)
            return torch.sigmoid(logits)
