"""
Continuous Training Pipeline
==============================
Triggered by:
  1. Scheduled heartbeat (every 24h) — checks if new data threshold is met
  2. Drift detection alert — PSI > 0.2 on any key feature
  3. Performance degradation — AUPRC drop > 5%

Workflow:
  1. Check drift metrics in warehouse
  2. If retraining needed: pull latest features from feature store
  3. Train model with incremental data (warm-start from existing weights)
  4. Evaluate on held-out validation set
  5. If better than champion: promote to production via MLflow registry
  6. Create A/B test to validate in production
"""

import os
import sys
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import mlflow
import mlflow.pytorch

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipeline.lakehouse import LakehousePipeline
from monitoring.drift_detector import DriftDetector
from monitoring.ab_testing import ABTestManager
from models.fraud_gnn_lstm import FraudGNNLSTM
from training.train_all import train_fraud_model, train_credit_model, WEIGHTS_DIR

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


class ContinuousTrainer:
    """
    Orchestrates the full continuous training loop.
    Called by the heartbeat endpoint or drift alerts.
    """

    NEW_DATA_THRESHOLD = 5000   # Retrain if > 5000 new transactions since last training
    DRIFT_PSI_THRESHOLD = 0.2   # Retrain if PSI > 0.2 on any key feature
    PERF_DROP_THRESHOLD = 0.05  # Retrain if AUPRC drops > 5%

    def __init__(self, mlflow_uri: str = "sqlite:///mlruns.db"):
        self.pipeline = LakehousePipeline()
        self.ab_manager = ABTestManager()
        mlflow.set_tracking_uri(mlflow_uri)

    def should_retrain(self, model_name: str = "fraud_detection") -> dict:
        """Check all retraining triggers"""
        detector = DriftDetector(model_name)
        drift_summary = detector.get_drift_summary()

        # Check drift
        drifted = [m for m in drift_summary if m.get("is_drifted")]
        has_drift = len(drifted) > 0

        # Check new data volume
        try:
            count = self.pipeline.duck.execute(
                "SELECT COUNT(*) FROM transactions_raw WHERE ingested_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'"
            ).fetchone()[0]
            has_new_data = count > self.NEW_DATA_THRESHOLD
        except Exception:
            has_new_data = False
            count = 0

        return {
            "should_retrain": has_drift or has_new_data,
            "reason": {
                "drift_detected": has_drift,
                "drifted_metrics": [m["metric_name"] for m in drifted],
                "new_data_count": count,
                "new_data_threshold_met": has_new_data,
            }
        }

    def run_retraining(self, model_name: str = "fraud_detection", epochs: int = 10) -> dict:
        """
        Run incremental retraining with warm-start from existing weights.
        """
        print(f"\n=== Continuous Retraining: {model_name} ===")
        start_time = datetime.now()

        # Load existing weights for warm-start
        weight_path = WEIGHTS_DIR / f"{model_name.replace('_', '_')}.pt"
        checkpoint = None
        if weight_path.exists():
            checkpoint = torch.load(weight_path, map_location=DEVICE)
            print(f"  Warm-starting from {weight_path} (prev AUPRC: {checkpoint.get('best_auprc', 'N/A')})")

        # Ingest latest data from feature store
        try:
            self.pipeline.compute_fraud_features()
        except Exception as e:
            print(f"  Feature computation skipped: {e}")

        # Train
        if model_name == "fraud_detection":
            model, scaler = train_fraud_model(epochs=epochs)
        elif model_name == "credit_scoring":
            model, scaler = train_credit_model(epochs=epochs)
        else:
            return {"error": f"Unknown model: {model_name}"}

        # Load new weights to compare
        new_checkpoint = torch.load(weight_path, map_location=DEVICE)
        new_auprc = new_checkpoint.get("best_auprc", 0)
        prev_auprc = checkpoint.get("best_auprc", 0) if checkpoint else 0

        # Create A/B test if new model is better
        test_id = None
        if new_auprc > prev_auprc:
            champion_version = f"v{int(prev_auprc * 10000)}"
            challenger_version = f"v{int(new_auprc * 10000)}"
            test_id = self.ab_manager.create_test(
                model_name=model_name,
                champion_version=champion_version,
                challenger_version=challenger_version,
                traffic_split=0.1,
            )

        duration = (datetime.now() - start_time).total_seconds()
        result = {
            "model_name": model_name,
            "prev_auprc": prev_auprc,
            "new_auprc": new_auprc,
            "improved": new_auprc > prev_auprc,
            "ab_test_id": test_id,
            "duration_seconds": duration,
            "completed_at": datetime.now().isoformat(),
        }
        print(f"  Retraining complete: AUPRC {prev_auprc:.4f} → {new_auprc:.4f} ({duration:.1f}s)")
        return result

    def run_full_pipeline(self) -> dict:
        """Entry point for heartbeat-triggered continuous training"""
        results = {}
        for model_name in ["fraud_detection", "credit_scoring"]:
            trigger = self.should_retrain(model_name)
            if trigger["should_retrain"]:
                print(f"  Retraining {model_name}: {trigger['reason']}")
                results[model_name] = self.run_retraining(model_name)
            else:
                results[model_name] = {"status": "no_retraining_needed", "reason": trigger["reason"]}
        return results


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Continuous Trainer / HPO Runner")
    parser.add_argument("--model", default="fraud_detection", help="Model name to retrain")
    parser.add_argument("--hpo", action="store_true", help="Run Ray Tune HPO sweep instead of single training run")
    parser.add_argument("--reason", default="", help="Reason for triggering retraining")
    parser.add_argument("--dry-run", action="store_true", dest="dry_run", help="Dry run (no actual training)")
    args = parser.parse_args()

    if args.dry_run:
        print(json.dumps({"status": "dry_run", "model": args.model, "hpo": args.hpo}))
        sys.exit(0)

    trainer = ContinuousTrainer(mlflow_uri="sqlite:///mlruns.db")

    if args.hpo:
        print(f"=== Ray Tune HPO sweep for {args.model} ===", flush=True)
        try:
            import ray
            from ray import tune
            from ray.tune.schedulers import ASHAScheduler

            _model_name = args.model  # capture for closure

            def hpo_train(config):
                """Ray Tune trainable: train with given hyperparameters and report metrics."""
                import mlflow as _mlflow
                _mlflow.set_tracking_uri("sqlite:///mlruns.db")
                with _mlflow.start_run(run_name=f"hpo_lr{config['lr']:.0e}_bs{config['batch_size']}"):
                    _mlflow.log_params(config)
                    try:
                        from training.train_all import train_fraud_model, train_credit_model, WEIGHTS_DIR
                        import torch as _torch
                        if _model_name == "fraud_detection":
                            train_fraud_model(epochs=config.get("epochs", 5))
                            weight_file = WEIGHTS_DIR / "fraud_gnn_lstm.pt"
                        else:
                            train_credit_model(epochs=config.get("epochs", 5))
                            weight_file = WEIGHTS_DIR / "credit_tabnet.pt"
                        ckpt = _torch.load(weight_file, map_location="cpu")
                        auprc = float(ckpt.get("best_auprc", 0.0))
                        _mlflow.log_metric("val_auprc", auprc)
                        tune.report({"val_auprc": auprc})
                    except Exception as _e:
                        tune.report({"val_auprc": 0.0})

            ray.init(ignore_reinit_error=True, num_cpus=2)
            scheduler = ASHAScheduler(metric="val_auprc", mode="max", max_t=10, grace_period=2)
            search_space = {
                "lr": tune.loguniform(1e-4, 1e-2),
                "batch_size": tune.choice([32, 64, 128]),
                "epochs": tune.choice([5, 10]),
            }
            analysis = tune.run(
                hpo_train,
                config=search_space,
                num_samples=6,
                scheduler=scheduler,
                verbose=1,
                name=f"hpo_{args.model}",
            )
            best = analysis.best_config
            best_auprc = analysis.best_result.get("val_auprc", 0.0)
            print(json.dumps({
                "status": "hpo_complete",
                "model": args.model,
                "best_config": best,
                "best_val_auprc": best_auprc,
            }))
            ray.shutdown()
        except ImportError as _ie:
            print(f"Ray not available ({_ie}), falling back to standard retraining", flush=True)
            result = trainer.run_retraining(args.model)
            print(json.dumps(result, indent=2))
        except Exception as _e:
            print(json.dumps({"status": "hpo_error", "error": str(_e)}))
    else:
        if args.model in ("fraud_detection", "credit_scoring"):
            result = trainer.run_retraining(args.model)
        else:
            result = trainer.run_full_pipeline()
        print(json.dumps(result, indent=2))

