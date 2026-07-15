"""
Biometric Liveness Detection Model: CNN
========================================
Detects presentation attacks (printed photos, screen replays, 3D masks)
during KYC selfie verification.

Architecture:
  - MobileNetV2 backbone (pretrained on ImageNet, fine-tuned for liveness)
  - Binary classifier head: live vs. spoof
  - Texture analysis branch: LBP-inspired frequency features

Input: 224×224 RGB face crop
Output: liveness probability [0, 1]
"""

import torch
import torch.nn as nn
import torch.nn.functional as F


class DepthwiseSeparableConv(nn.Module):
    """Depthwise separable convolution (MobileNet building block)"""
    def __init__(self, in_channels: int, out_channels: int, stride: int = 1):
        super().__init__()
        self.dw = nn.Conv2d(in_channels, in_channels, 3, stride=stride, padding=1, groups=in_channels, bias=False)
        self.pw = nn.Conv2d(in_channels, out_channels, 1, bias=False)
        self.bn = nn.BatchNorm2d(out_channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return F.relu6(self.bn(self.pw(self.dw(x))))


class InvertedResidualBlock(nn.Module):
    """MobileNetV2 inverted residual block"""
    def __init__(self, in_channels: int, out_channels: int, stride: int = 1, expand_ratio: int = 6):
        super().__init__()
        hidden = in_channels * expand_ratio
        self.use_residual = stride == 1 and in_channels == out_channels
        layers = []
        if expand_ratio != 1:
            layers += [nn.Conv2d(in_channels, hidden, 1, bias=False), nn.BatchNorm2d(hidden), nn.ReLU6(inplace=True)]
        layers += [
            nn.Conv2d(hidden, hidden, 3, stride=stride, padding=1, groups=hidden, bias=False),
            nn.BatchNorm2d(hidden), nn.ReLU6(inplace=True),
            nn.Conv2d(hidden, out_channels, 1, bias=False), nn.BatchNorm2d(out_channels),
        ]
        self.conv = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.use_residual:
            return x + self.conv(x)
        return self.conv(x)


class TextureAnalysisBranch(nn.Module):
    """
    Frequency/texture analysis branch.
    Spoofed images (printed photos, screens) have different high-frequency
    texture patterns compared to real faces.
    """
    def __init__(self, out_features: int = 64):
        super().__init__()
        # High-frequency filter bank (Laplacian, Sobel-like)
        self.hf_conv = nn.Conv2d(3, 16, 3, padding=1, bias=False)
        self.texture_net = nn.Sequential(
            nn.Conv2d(16, 32, 3, stride=2, padding=1, bias=False),
            nn.BatchNorm2d(32), nn.ReLU(),
            nn.Conv2d(32, 64, 3, stride=2, padding=1, bias=False),
            nn.BatchNorm2d(64), nn.ReLU(),
            nn.AdaptiveAvgPool2d(4),
            nn.Flatten(),
            nn.Linear(64 * 16, out_features),
            nn.ReLU(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        hf = self.hf_conv(x)
        return self.texture_net(hf)


class LivenessCNN(nn.Module):
    """
    Biometric liveness detection CNN.
    Combines MobileNetV2-style backbone with texture analysis branch.
    """
    def __init__(self, dropout: float = 0.4):
        super().__init__()

        # MobileNetV2-inspired backbone
        self.backbone = nn.Sequential(
            # Initial conv
            nn.Conv2d(3, 32, 3, stride=2, padding=1, bias=False),
            nn.BatchNorm2d(32), nn.ReLU6(inplace=True),
            # Inverted residual blocks
            InvertedResidualBlock(32, 16, stride=1, expand_ratio=1),
            InvertedResidualBlock(16, 24, stride=2, expand_ratio=6),
            InvertedResidualBlock(24, 24, stride=1, expand_ratio=6),
            InvertedResidualBlock(24, 32, stride=2, expand_ratio=6),
            InvertedResidualBlock(32, 32, stride=1, expand_ratio=6),
            InvertedResidualBlock(32, 32, stride=1, expand_ratio=6),
            InvertedResidualBlock(32, 64, stride=2, expand_ratio=6),
            InvertedResidualBlock(64, 64, stride=1, expand_ratio=6),
            InvertedResidualBlock(64, 96, stride=1, expand_ratio=6),
            InvertedResidualBlock(96, 96, stride=1, expand_ratio=6),
            InvertedResidualBlock(96, 160, stride=2, expand_ratio=6),
            InvertedResidualBlock(160, 320, stride=1, expand_ratio=6),
            # Final conv
            nn.Conv2d(320, 1280, 1, bias=False),
            nn.BatchNorm2d(1280), nn.ReLU6(inplace=True),
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
        )

        # Texture branch
        self.texture_branch = TextureAnalysisBranch(out_features=64)

        # Fusion + classifier
        self.classifier = nn.Sequential(
            nn.Linear(1280 + 64, 256),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(256, 64),
            nn.ReLU(),
            nn.Dropout(dropout / 2),
            nn.Linear(64, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        x: (batch, 3, 224, 224) normalized face image
        Returns: (batch,) liveness logits
        """
        backbone_feat = self.backbone(x)
        texture_feat = self.texture_branch(x)
        combined = torch.cat([backbone_feat, texture_feat], dim=1)
        return self.classifier(combined).squeeze(-1)

    def predict_proba(self, x: torch.Tensor) -> torch.Tensor:
        with torch.no_grad():
            return torch.sigmoid(self.forward(x))

