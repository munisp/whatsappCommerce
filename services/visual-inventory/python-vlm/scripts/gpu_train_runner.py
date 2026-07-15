#!/usr/bin/env python3
"""
GPU Training Pipeline Runner
============================
Launches YOLO fine-tuning on a remote GPU server (RunPod, Vast.ai, Lambda Labs,
or any SSH-accessible machine) and tracks training progress.

Usage:
  # RunPod via SSH
  python gpu_train_runner.py --provider runpod --pod-id abc123 --ssh-key ~/.ssh/id_rsa

  # Any SSH server
  python gpu_train_runner.py --provider ssh --host 192.168.1.100 --user ubuntu --ssh-key ~/.ssh/id_rsa

  # Local GPU (no SSH)
  python gpu_train_runner.py --provider local

  # Dry run (validate dataset only)
  python gpu_train_runner.py --provider local --dry-run

Requirements:
  pip install paramiko boto3 requests tqdm pyyaml
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

# ── Configuration ─────────────────────────────────────────────────────────────
DATASET_ARCHIVE = "/home/ubuntu/webdev-static-assets/fmcg-dataset/fmcg_training_dataset.tar.gz"
DATASET_YAML = "dataset/dataset.yaml"
YOLO_MODEL = os.getenv("YOLO_BASE_MODEL", "yolo11s.pt")
EPOCHS = int(os.getenv("YOLO_EPOCHS", "100"))
BATCH_SIZE = int(os.getenv("YOLO_BATCH", "16"))
IMG_SIZE = int(os.getenv("YOLO_IMGSZ", "640"))
PROJECT_NAME = "nigerian_fmcg"
RUN_NAME = f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

# Nigerian FMCG class names (must match build_dataset.py)
CLASS_NAMES = [
    "indomie_pack", "maggi_cube", "knorr_cube", "royco_cube",
    "dano_milk_sachet", "peak_milk_sachet", "cowbell_sachet",
    "bigi_cola_bottle", "coca_cola_bottle", "coca_cola_can",
    "malta_guinness_bottle", "eva_water_bottle", "pure_water_sachet",
    "chivita_juice", "gino_tomato_sachet", "tasty_tom_tomato",
    "mama_gold_rice", "caprice_rice", "garri_bag",
    "devon_kings_oil", "mamador_oil",
    "omo_sachet", "ariel_sachet",
    "key_soap", "dettol_soap",
    "vaseline_sachet", "robb_balm",
    "cabin_biscuit", "digestive_biscuit", "dangote_noodles",
]

REMOTE_WORKDIR = "/workspace/fmcg_training"

TRAIN_SCRIPT = f"""#!/bin/bash
set -e
echo "=== Nigerian FMCG YOLO Training Pipeline ==="
echo "Started: $(date)"

# Install dependencies
pip install ultralytics boto3 --quiet

# Extract dataset
mkdir -p {REMOTE_WORKDIR}
cd {REMOTE_WORKDIR}
tar -xzf fmcg_training_dataset.tar.gz
echo "Dataset extracted: $(find dataset -name '*.jpg' | wc -l) images"

# Verify dataset
python3 -c "
from ultralytics import YOLO
import yaml
with open('dataset/dataset.yaml') as f:
    cfg = yaml.safe_load(f)
print('Classes:', cfg['nc'], cfg['names'][:5], '...')
print('Train images:', len(list(__import__('pathlib').Path('dataset/images/train').glob('*.jpg'))))
print('Val images:', len(list(__import__('pathlib').Path('dataset/images/val').glob('*.jpg'))))
"

# Run training
echo "=== Starting YOLO Training ==="
python3 -c "
from ultralytics import YOLO
model = YOLO('{YOLO_MODEL}')
results = model.train(
    data='dataset/dataset.yaml',
    epochs={EPOCHS},
    batch={BATCH_SIZE},
    imgsz={IMG_SIZE},
    project='{PROJECT_NAME}',
    name='{RUN_NAME}',
    device='0' if __import__('torch').cuda.is_available() else 'cpu',
    workers=4,
    patience=20,
    save=True,
    save_period=10,
    val=True,
    plots=True,
    # Augmentation for Nigerian market conditions
    hsv_h=0.015, hsv_s=0.7, hsv_v=0.4,
    flipud=0.0, fliplr=0.5,
    mosaic=1.0, mixup=0.1, copy_paste=0.1,
    degrees=10.0, translate=0.1, scale=0.5,
    # Nigerian lighting conditions
    erasing=0.4,
)
print('Training complete!')
print('Best mAP50:', results.results_dict.get('metrics/mAP50(B)', 'N/A'))
print('Best mAP50-95:', results.results_dict.get('metrics/mAP50-95(B)', 'N/A'))
"

# Export to ONNX for deployment
echo "=== Exporting to ONNX ==="
python3 -c "
from ultralytics import YOLO
import glob
best_weights = sorted(glob.glob('{PROJECT_NAME}/{RUN_NAME}/weights/best.pt'))
if best_weights:
    model = YOLO(best_weights[-1])
    model.export(format='onnx', opset=12, simplify=True)
    print('ONNX exported:', best_weights[-1].replace('.pt', '.onnx'))
else:
    print('WARNING: No best.pt found, using last.pt')
    model = YOLO('{PROJECT_NAME}/{RUN_NAME}/weights/last.pt')
    model.export(format='onnx', opset=12, simplify=True)
"

# Create deployment manifest
cat > deployment_manifest.json << EOF
{{
  "run_name": "{RUN_NAME}",
  "model_base": "{YOLO_MODEL}",
  "epochs": {EPOCHS},
  "classes": {json.dumps(CLASS_NAMES)},
  "trained_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "best_weights": "{PROJECT_NAME}/{RUN_NAME}/weights/best.pt",
  "onnx_weights": "{PROJECT_NAME}/{RUN_NAME}/weights/best.onnx",
  "deploy_env_var": "YOLO_MODEL_PATH",
  "deploy_value": "{REMOTE_WORKDIR}/{PROJECT_NAME}/{RUN_NAME}/weights/best.pt"
}}
EOF

echo "=== Training Complete ==="
echo "Deployment manifest: deployment_manifest.json"
cat deployment_manifest.json
echo "Finished: $(date)"
"""


# ── SSH helpers ───────────────────────────────────────────────────────────────
def get_ssh_client(host: str, user: str, key_path: str, port: int = 22):
    """Create an authenticated SSH client."""
    try:
        import paramiko
    except ImportError:
        print("ERROR: paramiko not installed. Run: pip install paramiko")
        sys.exit(1)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Connecting to {user}@{host}:{port} ...")
    client.connect(host, port=port, username=user, key_filename=key_path, timeout=30)
    print("SSH connected.")
    return client


def upload_dataset(ssh_client, local_archive: str, remote_dir: str):
    """Upload the compressed dataset archive via SFTP."""
    sftp = ssh_client.open_sftp()
    remote_path = f"{remote_dir}/fmcg_training_dataset.tar.gz"
    archive_size_mb = os.path.getsize(local_archive) / 1024 / 1024
    print(f"Uploading dataset ({archive_size_mb:.1f} MB) to {remote_path} ...")

    try:
        from tqdm import tqdm
        with tqdm(total=os.path.getsize(local_archive), unit='B', unit_scale=True, desc="Upload") as pbar:
            def progress(transferred, total):
                pbar.update(transferred - pbar.n)
            sftp.put(local_archive, remote_path, callback=progress)
    except ImportError:
        sftp.put(local_archive, remote_path)

    sftp.close()
    print(f"Upload complete: {remote_path}")
    return remote_path


def run_remote_command(ssh_client, command: str, stream_output: bool = True) -> tuple[int, str]:
    """Execute a command on the remote server and optionally stream output."""
    stdin, stdout, stderr = ssh_client.exec_command(command, get_pty=True)
    output_lines = []

    if stream_output:
        for line in iter(stdout.readline, ""):
            print(line, end="", flush=True)
            output_lines.append(line)
    else:
        output_lines = stdout.readlines()

    exit_code = stdout.channel.recv_exit_status()
    return exit_code, "".join(output_lines)


def download_results(ssh_client, remote_dir: str, local_output_dir: str):
    """Download trained weights and deployment manifest."""
    sftp = ssh_client.open_sftp()
    Path(local_output_dir).mkdir(parents=True, exist_ok=True)

    # Download deployment manifest
    manifest_remote = f"{remote_dir}/deployment_manifest.json"
    manifest_local = f"{local_output_dir}/deployment_manifest.json"
    try:
        sftp.get(manifest_remote, manifest_local)
        with open(manifest_local) as f:
            manifest = json.load(f)
        print(f"\nDeployment manifest saved: {manifest_local}")
        print(f"Best weights path: {manifest.get('best_weights')}")
        print(f"ONNX path: {manifest.get('onnx_weights')}")
        print(f"\nTo deploy, set: YOLO_MODEL_PATH={manifest.get('deploy_value')}")
    except FileNotFoundError:
        print("WARNING: deployment_manifest.json not found on remote")

    sftp.close()


# ── RunPod helpers ────────────────────────────────────────────────────────────
def get_runpod_ssh_info(pod_id: str, api_key: str) -> tuple[str, int, str]:
    """Get SSH connection info for a RunPod pod via the RunPod API."""
    try:
        import requests
    except ImportError:
        print("ERROR: requests not installed. Run: pip install requests")
        sys.exit(1)

    headers = {"Authorization": f"Bearer {api_key}"}
    resp = requests.get(f"https://api.runpod.io/v2/pod/{pod_id}", headers=headers)
    resp.raise_for_status()
    pod = resp.json()

    # Extract SSH info from pod runtime
    runtime = pod.get("runtime", {})
    ports = runtime.get("ports", [])
    ssh_port_info = next((p for p in ports if p.get("privatePort") == 22), None)

    if not ssh_port_info:
        raise ValueError(f"No SSH port found for pod {pod_id}. Ensure SSH is enabled.")

    host = ssh_port_info.get("ip")
    port = ssh_port_info.get("publicPort", 22)
    print(f"RunPod SSH: {host}:{port}")
    return host, port, "root"


# ── Local GPU training ────────────────────────────────────────────────────────
def run_local_training(dataset_dir: str, dry_run: bool = False):
    """Run YOLO training on the local machine (requires GPU + ultralytics)."""
    try:
        from ultralytics import YOLO
        import torch
    except ImportError:
        print("ERROR: ultralytics not installed. Run: pip install ultralytics torch")
        sys.exit(1)

    dataset_yaml = Path(dataset_dir) / DATASET_YAML
    if not dataset_yaml.exists():
        print(f"ERROR: Dataset YAML not found at {dataset_yaml}")
        print("Run build_dataset.py first to generate the dataset.")
        sys.exit(1)

    device = "0" if __import__("torch").cuda.is_available() else "cpu"
    print(f"Device: {device}")
    print(f"Dataset: {dataset_yaml}")
    print(f"Model: {YOLO_MODEL}, Epochs: {EPOCHS}, Batch: {BATCH_SIZE}")

    if dry_run:
        print("\n[DRY RUN] Validating dataset structure...")
        import yaml
        with open(dataset_yaml) as f:
            cfg = yaml.safe_load(f)
        train_count = len(list((Path(dataset_dir) / "dataset/images/train").glob("*.jpg")))
        val_count = len(list((Path(dataset_dir) / "dataset/images/val").glob("*.jpg")))
        print(f"  Classes: {cfg['nc']} ({', '.join(cfg['names'][:5])} ...)")
        print(f"  Train images: {train_count}")
        print(f"  Val images: {val_count}")
        print(f"  Labels dir exists: {(Path(dataset_dir) / 'dataset/labels/train').exists()}")
        print("[DRY RUN] Dataset validation passed. Ready to train.")
        return

    model = YOLO(YOLO_MODEL)
    results = model.train(
        data=str(dataset_yaml),
        epochs=EPOCHS,
        batch=BATCH_SIZE,
        imgsz=IMG_SIZE,
        project=PROJECT_NAME,
        name=RUN_NAME,
        device=device,
        workers=4,
        patience=20,
        save=True,
        val=True,
        plots=True,
        hsv_h=0.015, hsv_s=0.7, hsv_v=0.4,
        flipud=0.0, fliplr=0.5,
        mosaic=1.0, mixup=0.1, copy_paste=0.1,
        degrees=10.0, translate=0.1, scale=0.5,
        erasing=0.4,
    )

    print(f"\nTraining complete!")
    print(f"mAP50: {results.results_dict.get('metrics/mAP50(B)', 'N/A')}")
    print(f"mAP50-95: {results.results_dict.get('metrics/mAP50-95(B)', 'N/A')}")

    # Export to ONNX
    best_pt = Path(PROJECT_NAME) / RUN_NAME / "weights" / "best.pt"
    if best_pt.exists():
        best_model = YOLO(str(best_pt))
        best_model.export(format="onnx", opset=12, simplify=True)
        print(f"ONNX exported: {best_pt.with_suffix('.onnx')}")
        print(f"\nTo deploy: set YOLO_MODEL_PATH={best_pt.resolve()}")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Nigerian FMCG YOLO GPU Training Runner")
    parser.add_argument("--provider", choices=["local", "ssh", "runpod"], default="local",
                        help="GPU provider: local | ssh | runpod")
    parser.add_argument("--host", help="SSH host (for --provider ssh)")
    parser.add_argument("--user", default="ubuntu", help="SSH user")
    parser.add_argument("--port", type=int, default=22, help="SSH port")
    parser.add_argument("--ssh-key", default="~/.ssh/id_rsa", help="Path to SSH private key")
    parser.add_argument("--pod-id", help="RunPod pod ID (for --provider runpod)")
    parser.add_argument("--runpod-api-key", default=os.getenv("RUNPOD_API_KEY"), help="RunPod API key")
    parser.add_argument("--dataset-dir", default="/home/ubuntu/webdev-static-assets/fmcg-dataset",
                        help="Local path to dataset directory")
    parser.add_argument("--output-dir", default="./training_results", help="Local dir for downloaded results")
    parser.add_argument("--dry-run", action="store_true", help="Validate dataset without training")
    parser.add_argument("--epochs", type=int, default=EPOCHS, help="Training epochs")
    parser.add_argument("--batch", type=int, default=BATCH_SIZE, help="Batch size")
    parser.add_argument("--model", default=YOLO_MODEL, help="YOLO base model")
    args = parser.parse_args()

    # Override globals from args
    global EPOCHS, BATCH_SIZE, YOLO_MODEL
    EPOCHS = args.epochs
    BATCH_SIZE = args.batch
    YOLO_MODEL = args.model

    print(f"=== Nigerian FMCG YOLO Training Runner ===")
    print(f"Provider: {args.provider} | Model: {YOLO_MODEL} | Epochs: {EPOCHS} | Batch: {BATCH_SIZE}")
    print(f"Classes: {len(CLASS_NAMES)} Nigerian FMCG products")
    print()

    if args.provider == "local":
        run_local_training(args.dataset_dir, dry_run=args.dry_run)
        return

    # Remote providers
    if args.provider == "runpod":
        if not args.pod_id or not args.runpod_api_key:
            print("ERROR: --pod-id and --runpod-api-key required for RunPod")
            sys.exit(1)
        host, port, user = get_runpod_ssh_info(args.pod_id, args.runpod_api_key)
        args.host, args.port, args.user = host, port, user

    if not args.host:
        print("ERROR: --host required for SSH provider")
        sys.exit(1)

    ssh = get_ssh_client(args.host, args.user, os.path.expanduser(args.ssh_key), args.port)

    try:
        # Create remote workdir
        run_remote_command(ssh, f"mkdir -p {REMOTE_WORKDIR}", stream_output=False)

        # Upload dataset
        archive = Path(args.dataset_dir) / "fmcg_training_dataset.tar.gz"
        if not archive.exists():
            print(f"ERROR: Dataset archive not found at {archive}")
            print("Run build_dataset.py first, then compress with:")
            print(f"  tar -czf {archive} -C {args.dataset_dir} products dataset")
            sys.exit(1)

        upload_dataset(ssh, str(archive), REMOTE_WORKDIR)

        if args.dry_run:
            print("\n[DRY RUN] Skipping remote training. Upload successful.")
            return

        # Write and execute training script
        script_path = f"{REMOTE_WORKDIR}/train.sh"
        run_remote_command(ssh, f"cat > {script_path} << 'TRAINEOF'\n{TRAIN_SCRIPT}\nTRAINEOF", stream_output=False)
        run_remote_command(ssh, f"chmod +x {script_path}", stream_output=False)

        print(f"\n=== Starting remote training on {args.host} ===")
        print(f"Script: {script_path}")
        print("Streaming output (Ctrl+C to detach — training continues remotely):\n")

        start = time.time()
        exit_code, _ = run_remote_command(ssh, f"bash {script_path}", stream_output=True)
        elapsed = time.time() - start

        print(f"\n=== Training {'completed' if exit_code == 0 else 'FAILED'} in {elapsed/60:.1f} min ===")

        if exit_code == 0:
            download_results(ssh, REMOTE_WORKDIR, args.output_dir)
        else:
            print(f"Training failed with exit code {exit_code}")
            sys.exit(1)

    finally:
        ssh.close()
        print("SSH connection closed.")


if __name__ == "__main__":
    main()
