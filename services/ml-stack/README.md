# WhatsApp Commerce ML Stack

End-to-end AI/ML/DL/GNN stack for fraud detection, credit scoring, biometric liveness, and NLP.

## Architecture

```
Production DB (PostgreSQL)
        │
        ▼
┌─────────────────────┐
│  Lakehouse Pipeline │  DuckDB → Delta Lake (parquet partitioned by date)
│  (pipeline/)        │  Feature engineering with window functions
└─────────────────────┘
        │
        ▼
┌─────────────────────┐
│  Feature Store      │  Point-in-time correct features
│  (DuckDB warehouse) │  Velocity, ratios, behavioral signals
└─────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  Model Training (training/)                                 │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ FraudGNNLSTM     │  │ TabNet       │  │ LivenessCNN  │  │
│  │ GNN + LSTM       │  │ Credit Score │  │ MobileNetV2  │  │
│  │ AUPRC: 1.000*    │  │ AUC: 1.000*  │  │ Biometric    │  │
│  └──────────────────┘  └──────────────┘  └──────────────┘  │
│  * On synthetic data — see Honest Gaps section below        │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  MLOps (monitoring/)                                        │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Drift Detector   │  │ A/B Testing  │  │ MLflow       │  │
│  │ PSI + KS + KL    │  │ Mann-Whitney │  │ Registry     │  │
│  └──────────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────┐
│ Continuous Training │  Triggered by drift alerts or new data threshold
│ (training/          │  Warm-start from existing weights
│  continuous_trainer)│  Auto A/B test on improvement
└─────────────────────┘
```

## Models

| Model | Architecture | Task | Input Features | Output |
|---|---|---|---|---|
| `fraud_gnn_lstm.pt` | GraphSAGE + BiLSTM + Attention | Transaction fraud detection | 20 tabular features | Fraud probability [0,1] |
| `credit_tabnet.pt` | TabNet (sequential attention) | SME credit default prediction | 15 tabular features | Default probability [0,1] |
| `liveness_cnn` | MobileNetV2 + Texture branch | Biometric liveness detection | 224×224 RGB face crop | Liveness probability [0,1] |

## Honest Gaps (Production Readiness)

| Gap | Status | Path to Production |
|---|---|---|
| Model weights trained on synthetic data | ✓ Weights exist, synthetic distributions calibrated to CBN/NIBSS reports | Replace with real transaction data from production DB via Lakehouse pipeline |
| Real Nigerian fraud patterns | Synthetic fraud rate 3.2% (NIBSS 2023: 3.1%) | Ingest real labeled fraud cases from NIBSS/bank partners |
| MLflow tracking server | Config ready (`docker-compose.mlops.yml`) | Deploy with `docker-compose -f docker-compose.mlops.yml up -d` |
| Ray distributed training | Config ready (`ray_train_config.py`) | Set `RAY_ADDRESS=ray-head:6379` and run `python ray_train_config.py` |
| A/B test in production | Infrastructure ready (`ab_testing.py`) | Wire `ABTestManager.route_request()` into the fraud scoring API endpoint |
| Drift monitoring | PSI/KS/KL implemented | Schedule `DriftDetector.check_feature_drift()` via heartbeat every 6h |
| Continuous training | `ContinuousTrainer.run_full_pipeline()` ready | Register heartbeat job after deployment (see Deploy Checklist) |

## Quick Start

```bash
# 1. Generate synthetic training data
python3 data/synthetic_data_generator.py

# 2. Train all models (5 epochs for smoke test, 30+ for production)
MLFLOW_ALLOW_FILE_STORE=true python3 training/train_all.py --model all --epochs 30

# 3. Start MLOps infrastructure
docker-compose -f docker-compose.mlops.yml up -d

# 4. Run continuous training check
python3 training/continuous_trainer.py

# 5. Launch Ray distributed training (requires Ray cluster)
python3 ray_train_config.py
```

## Data Pipeline

```bash
# Ingest production data into Lakehouse
python3 -c "
from pipeline.lakehouse import LakehousePipeline
p = LakehousePipeline()
p.ingest_from_parquet('data/generated/fraud_train.parquet')
p.compute_fraud_features()
p.export_delta_snapshot()
"
```

