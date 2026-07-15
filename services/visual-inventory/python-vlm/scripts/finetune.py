#!/usr/bin/env python3
"""
YOLO Fine-tuning Script for Nigerian FMCG Visual Inventory
===========================================================
Active Learning Pipeline:
  1. Pull human-verified corrections from the platform DB
  2. Download the corresponding scan images from S3
  3. Convert corrections → YOLO bounding-box label files
  4. Build a YOLO dataset YAML with Nigerian FMCG class names
  5. Run YOLO11 fine-tuning (transfer learning from COCO weights)
  6. Evaluate on a held-out validation split
  7. Export the best model weights for deployment

Usage:
  python finetune.py [--min-corrections 50] [--epochs 50] [--model yolo11n.pt]
                     [--output-dir ./runs/finetune] [--dry-run]

Environment variables required:
  DATABASE_URL      PostgreSQL connection string
  S3_BUCKET         S3 bucket name for scan images
  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  (or use IAM role)
  OLLAMA_BASE_URL   (optional) Ollama endpoint for VLM-assisted label review
"""

import argparse
import json
import logging
import os
import shutil
import sys
import tempfile
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("finetune")

# ── Nigerian FMCG Class Taxonomy ──────────────────────────────────────────────
# These are the canonical class names the model will learn.
# Aliases are used to normalise corrections from operators.
FMCG_CLASSES: list[dict[str, Any]] = [
    # Beverages
    {"id": 0,  "name": "coca_cola_bottle",      "aliases": ["coke", "coca cola", "coca-cola bottle"]},
    {"id": 1,  "name": "coca_cola_can",          "aliases": ["coke can", "coca cola can"]},
    {"id": 2,  "name": "pepsi_bottle",           "aliases": ["pepsi", "pepsi bottle"]},
    {"id": 3,  "name": "bigi_cola",              "aliases": ["bigi", "bigi cola", "bigi drink"]},
    {"id": 4,  "name": "bigi_orange",            "aliases": ["bigi orange", "bigi orange drink"]},
    {"id": 5,  "name": "malta_guinness",         "aliases": ["malta", "malta guinness", "malt drink"]},
    {"id": 6,  "name": "eva_water_bottle",       "aliases": ["eva water", "eva", "eva 75cl"]},
    {"id": 7,  "name": "pure_water_sachet",      "aliases": ["pure water", "sachet water", "water sachet", "nylon water"]},
    {"id": 8,  "name": "chivita_juice",          "aliases": ["chivita", "chivita juice", "chivita active"]},
    {"id": 9,  "name": "five_alive_juice",       "aliases": ["five alive", "five alive juice"]},
    # Noodles
    {"id": 10, "name": "indomie_chicken",        "aliases": ["indomie chicken", "indomie chicken flavour"]},
    {"id": 11, "name": "indomie_onion_chicken",  "aliases": ["indomie onion", "indomie onion chicken"]},
    {"id": 12, "name": "indomie_jollof",         "aliases": ["indomie jollof", "indomie jollof flavour"]},
    {"id": 13, "name": "dangote_noodles",        "aliases": ["dangote noodles", "dangote"]},
    {"id": 14, "name": "nasco_noodles",          "aliases": ["nasco", "nasco noodles"]},
    # Seasoning
    {"id": 15, "name": "maggi_cube",             "aliases": ["maggi", "maggi cube", "maggi seasoning"]},
    {"id": 16, "name": "knorr_cube",             "aliases": ["knorr", "knorr cube", "knorr chicken"]},
    {"id": 17, "name": "royco_cube",             "aliases": ["royco", "royco cube", "royco mixed"]},
    {"id": 18, "name": "gino_tomato_paste",      "aliases": ["gino", "gino tomato", "gino paste"]},
    {"id": 19, "name": "tasty_tom_paste",        "aliases": ["tasty tom", "tastytom", "tasty tom paste"]},
    # Dairy
    {"id": 20, "name": "dano_milk_sachet",       "aliases": ["dano", "dano milk", "dano sachet"]},
    {"id": 21, "name": "peak_milk_tin",          "aliases": ["peak", "peak milk", "peak tin"]},
    {"id": 22, "name": "cowbell_sachet",         "aliases": ["cowbell", "cowbell milk", "cowbell sachet"]},
    {"id": 23, "name": "carnation_milk",         "aliases": ["carnation", "carnation milk"]},
    {"id": 24, "name": "three_crowns_milk",      "aliases": ["three crowns", "3 crowns"]},
    # Grains
    {"id": 25, "name": "mama_gold_rice",         "aliases": ["mama gold", "mama gold rice"]},
    {"id": 26, "name": "caprice_rice",           "aliases": ["caprice", "caprice rice"]},
    {"id": 27, "name": "dangote_flour",          "aliases": ["dangote flour", "dangote semolina"]},
    {"id": 28, "name": "white_garri_bag",        "aliases": ["garri", "white garri", "ijebu garri"]},
    {"id": 29, "name": "yellow_garri_bag",       "aliases": ["yellow garri", "eba garri"]},
    # Cooking Oil
    {"id": 30, "name": "devon_kings_oil",        "aliases": ["devon king", "devon kings", "devon kings oil"]},
    {"id": 31, "name": "mamador_oil",            "aliases": ["mamador", "mamador oil"]},
    {"id": 32, "name": "kings_oil",              "aliases": ["kings oil", "kings vegetable oil"]},
    {"id": 33, "name": "zomi_palm_oil",          "aliases": ["zomi", "zomi oil", "palm oil"]},
    # Detergent
    {"id": 34, "name": "omo_sachet",             "aliases": ["omo", "omo sachet", "omo detergent"]},
    {"id": 35, "name": "ariel_sachet",           "aliases": ["ariel", "ariel sachet", "ariel powder"]},
    {"id": 36, "name": "klin_sachet",            "aliases": ["klin", "klin sachet", "klin detergent"]},
    {"id": 37, "name": "sunlight_soap",          "aliases": ["sunlight", "sunlight soap", "sunlight bar"]},
    {"id": 38, "name": "key_soap",               "aliases": ["key soap", "key bar soap"]},
    # Personal Care
    {"id": 39, "name": "dettol_soap",            "aliases": ["dettol", "dettol soap", "dettol bar"]},
    {"id": 40, "name": "vaseline_sachet",        "aliases": ["vaseline", "vaseline sachet", "petroleum jelly"]},
    {"id": 41, "name": "robb_balm",              "aliases": ["robb", "robb balm", "robb ointment"]},
    {"id": 42, "name": "panadol_tablet",         "aliases": ["panadol", "panadol tablet", "paracetamol"]},
    # Snacks
    {"id": 43, "name": "digestive_biscuit",      "aliases": ["digestive", "digestive biscuit"]},
    {"id": 44, "name": "cabin_biscuit",          "aliases": ["cabin", "cabin biscuit", "cabin crackers"]},
    {"id": 45, "name": "pringles_can",           "aliases": ["pringles", "pringles can", "pringles chips"]},
    {"id": 46, "name": "lays_chips",             "aliases": ["lays", "lay's", "lays chips"]},
    # Generic fallback
    {"id": 47, "name": "unknown_product",        "aliases": ["unknown", "other", "misc"]},
]

# Build alias → class_id lookup
ALIAS_TO_CLASS: dict[str, int] = {}
CLASS_NAMES: list[str] = []
for cls in FMCG_CLASSES:
    CLASS_NAMES.append(cls["name"])
    ALIAS_TO_CLASS[cls["name"].lower()] = cls["id"]
    for alias in cls["aliases"]:
        ALIAS_TO_CLASS[alias.lower()] = cls["id"]


def normalise_label(raw: str) -> int:
    """Map a raw operator label to a YOLO class id. Returns 47 (unknown) if not found."""
    raw_lower = raw.strip().lower()
    # Exact match
    if raw_lower in ALIAS_TO_CLASS:
        return ALIAS_TO_CLASS[raw_lower]
    # Partial match (longest match wins)
    best_id, best_len = 47, 0
    for alias, cid in ALIAS_TO_CLASS.items():
        if alias in raw_lower and len(alias) > best_len:
            best_id, best_len = cid, len(alias)
    return best_id


# ── Database helpers ──────────────────────────────────────────────────────────
def fetch_corrections(db_url: str, min_confidence: float = 0.0) -> list[dict]:
    """
    Pull human-verified corrections from the platform database.
    Returns a list of correction records with associated session image URLs.
    """
    try:
        import psycopg2
        import psycopg2.extras
    except ImportError:
        log.error("psycopg2 not installed. Run: pip install psycopg2-binary")
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Join corrections with their session image URLs
    cur.execute("""
        SELECT
            vc.id,
            vc."sessionId",
            vc."detectedLabel",
            vc."correctedLabel",
            vc."correctedCount",
            vc."originalCount",
            vc."boundingBox",
            vc."confidence",
            vis."imageUrl",
            vis."imageKey",
            vis."scanLocation",
            vis."detectedItems"
        FROM vi_corrections vc
        JOIN visual_inventory_sessions vis ON vis.id = vc."sessionId"
        WHERE vc."isGroundTruth" = true
          AND vc."confidence" >= %s
          AND vis."imageUrl" IS NOT NULL
          AND vis."imageUrl" != ''
        ORDER BY vc."createdAt" DESC
    """, (min_confidence,))

    rows = [dict(r) for r in cur.fetchall()]
    cur.close()
    conn.close()
    log.info(f"Fetched {len(rows)} ground-truth corrections from DB")
    return rows


# ── Image download ────────────────────────────────────────────────────────────
def download_image(url: str, dest: Path) -> bool:
    """Download an image from S3/URL to a local path. Returns True on success."""
    try:
        if url.startswith("http"):
            urllib.request.urlretrieve(url, dest)
        else:
            # Relative path — try S3 download via boto3
            try:
                import boto3
                s3 = boto3.client("s3")
                bucket = os.environ.get("S3_BUCKET", "")
                key = url.lstrip("/")
                s3.download_file(bucket, key, str(dest))
            except Exception as e:
                log.warning(f"S3 download failed for {url}: {e}")
                return False
        return True
    except Exception as e:
        log.warning(f"Failed to download {url}: {e}")
        return False


# ── YOLO label generation ─────────────────────────────────────────────────────
def correction_to_yolo_label(correction: dict, img_width: int, img_height: int) -> str | None:
    """
    Convert a single correction record to a YOLO label line.
    Format: <class_id> <cx> <cy> <w> <h>  (all normalised 0–1)
    """
    label = correction.get("correctedLabel") or correction.get("detectedLabel", "")
    class_id = normalise_label(label)

    bbox = correction.get("boundingBox")
    if bbox:
        # bbox stored as [x1, y1, x2, y2] in pixel coords
        if isinstance(bbox, str):
            bbox = json.loads(bbox)
        x1, y1, x2, y2 = bbox
        cx = ((x1 + x2) / 2) / img_width
        cy = ((y1 + y2) / 2) / img_height
        w  = (x2 - x1) / img_width
        h  = (y2 - y1) / img_height
        # Clamp to [0, 1]
        cx, cy, w, h = max(0.0, min(1.0, cx)), max(0.0, min(1.0, cy)), max(0.01, min(1.0, w)), max(0.01, min(1.0, h))
    else:
        # No bbox — use full image as bounding box (coarse label, still useful)
        cx, cy, w, h = 0.5, 0.5, 1.0, 1.0

    return f"{class_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}"


# ── Dataset builder ───────────────────────────────────────────────────────────
def build_dataset(corrections: list[dict], dataset_dir: Path, val_split: float = 0.15) -> Path:
    """
    Build a YOLO-format dataset directory from corrections.
    Returns the path to the dataset YAML file.
    """
    import random
    from PIL import Image as PILImage

    train_img = dataset_dir / "images" / "train"
    val_img   = dataset_dir / "images" / "val"
    train_lbl = dataset_dir / "labels" / "train"
    val_lbl   = dataset_dir / "labels" / "val"
    for d in [train_img, val_img, train_lbl, val_lbl]:
        d.mkdir(parents=True, exist_ok=True)

    # Group corrections by session (one image per session)
    sessions: dict[str, list[dict]] = {}
    for c in corrections:
        sid = c["sessionId"]
        sessions.setdefault(sid, []).append(c)

    session_ids = list(sessions.keys())
    random.shuffle(session_ids)
    n_val = max(1, int(len(session_ids) * val_split))
    val_sessions = set(session_ids[:n_val])

    processed, skipped = 0, 0
    for sid, corrs in sessions.items():
        img_url = corrs[0]["imageUrl"]
        split   = "val" if sid in val_sessions else "train"
        img_dest = (val_img if split == "val" else train_img) / f"{sid}.jpg"
        lbl_dest = (val_lbl if split == "val" else train_lbl) / f"{sid}.txt"

        if not download_image(img_url, img_dest):
            skipped += 1
            continue

        # Get image dimensions for normalisation
        try:
            with PILImage.open(img_dest) as img:
                img_w, img_h = img.size
        except Exception:
            img_w, img_h = 640, 640  # fallback

        label_lines = []
        for c in corrs:
            line = correction_to_yolo_label(c, img_w, img_h)
            if line:
                label_lines.append(line)

        if label_lines:
            lbl_dest.write_text("\n".join(label_lines))
            processed += 1
        else:
            img_dest.unlink(missing_ok=True)
            skipped += 1

    log.info(f"Dataset built: {processed} sessions processed, {skipped} skipped")
    log.info(f"Train: {len(list(train_img.glob('*.jpg')))} images | Val: {len(list(val_img.glob('*.jpg')))} images")

    # Write dataset YAML
    yaml_path = dataset_dir / "dataset.yaml"
    yaml_content = f"""# Nigerian FMCG Visual Inventory Dataset
# Auto-generated by finetune.py on {datetime.now().isoformat()}
# Source: WhatsApp Commerce Platform — human-verified operator corrections

path: {dataset_dir.resolve()}
train: images/train
val:   images/val

nc: {len(CLASS_NAMES)}
names:
"""
    for i, name in enumerate(CLASS_NAMES):
        yaml_content += f"  {i}: {name}\n"

    yaml_path.write_text(yaml_content)
    log.info(f"Dataset YAML written to {yaml_path}")
    return yaml_path


# ── YOLO training ─────────────────────────────────────────────────────────────
def run_training(
    yaml_path: Path,
    base_model: str,
    epochs: int,
    output_dir: Path,
    img_size: int = 640,
    batch: int = 16,
    device: str = "auto",
) -> Path:
    """
    Fine-tune YOLO11 on the Nigerian FMCG dataset.
    Returns the path to the best weights file.
    """
    try:
        from ultralytics import YOLO
    except ImportError:
        log.error("ultralytics not installed. Run: pip install ultralytics")
        sys.exit(1)

    log.info(f"Loading base model: {base_model}")
    model = YOLO(base_model)  # Downloads COCO pre-trained weights if not cached

    log.info(f"Starting fine-tuning: {epochs} epochs, img_size={img_size}, batch={batch}, device={device}")
    results = model.train(
        data=str(yaml_path),
        epochs=epochs,
        imgsz=img_size,
        batch=batch,
        device=device,
        project=str(output_dir),
        name="nigerian_fmcg",
        exist_ok=True,
        # Transfer learning settings
        freeze=10,          # Freeze first 10 layers (backbone), fine-tune head
        lr0=0.001,          # Lower LR for fine-tuning
        lrf=0.01,
        momentum=0.937,
        weight_decay=0.0005,
        warmup_epochs=3,
        # Augmentation for African market conditions (varied lighting, outdoor markets)
        hsv_h=0.015,        # Hue variation (different lighting conditions)
        hsv_s=0.7,          # Saturation variation
        hsv_v=0.4,          # Value/brightness variation (indoor vs outdoor markets)
        flipud=0.0,
        fliplr=0.5,
        mosaic=1.0,         # Mosaic augmentation for dense shelf detection
        mixup=0.1,
        copy_paste=0.1,     # Copy-paste for sachet products (small objects)
        # Validation
        val=True,
        save=True,
        save_period=10,
        plots=True,
    )

    best_weights = output_dir / "nigerian_fmcg" / "weights" / "best.pt"
    if best_weights.exists():
        log.info(f"Training complete. Best weights: {best_weights}")
        log.info(f"mAP50: {results.results_dict.get('metrics/mAP50(B)', 'N/A')}")
        log.info(f"mAP50-95: {results.results_dict.get('metrics/mAP50-95(B)', 'N/A')}")
    else:
        log.warning("Training complete but best.pt not found at expected path")
        # Search for it
        candidates = list(output_dir.rglob("best.pt"))
        if candidates:
            best_weights = candidates[0]
            log.info(f"Found best weights at: {best_weights}")

    return best_weights


# ── Export & deployment ───────────────────────────────────────────────────────
def export_model(weights_path: Path, output_dir: Path, formats: list[str] = ["onnx"]) -> dict[str, Path]:
    """
    Export the fine-tuned model to deployment formats.
    ONNX is recommended for the Python VLM service.
    """
    try:
        from ultralytics import YOLO
    except ImportError:
        return {}

    model = YOLO(str(weights_path))
    exported: dict[str, Path] = {"pt": weights_path}

    for fmt in formats:
        try:
            log.info(f"Exporting to {fmt}...")
            export_path = model.export(format=fmt, imgsz=640, dynamic=True, simplify=True)
            exported[fmt] = Path(export_path)
            log.info(f"Exported {fmt}: {export_path}")
        except Exception as e:
            log.warning(f"Export to {fmt} failed: {e}")

    # Copy best weights to a versioned deployment directory
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    deploy_dir = output_dir / "deploy" / f"nigerian_fmcg_{timestamp}"
    deploy_dir.mkdir(parents=True, exist_ok=True)

    for fmt, path in exported.items():
        if path.exists():
            dest = deploy_dir / path.name
            shutil.copy2(path, dest)
            log.info(f"Copied {fmt} model to {dest}")

    # Write deployment manifest
    manifest = {
        "timestamp": timestamp,
        "base_model": "yolo11n.pt",
        "num_classes": len(CLASS_NAMES),
        "class_names": CLASS_NAMES,
        "formats": {fmt: str(path.name) for fmt, path in exported.items() if path.exists()},
        "deployment_dir": str(deploy_dir),
        "ollama_integration": {
            "description": "Use ONNX model in python-vlm service alongside Ollama VLM",
            "model_path_env": "YOLO_MODEL_PATH",
            "set_to": str(deploy_dir / "best.onnx") if (deploy_dir / "best.onnx").exists() else str(deploy_dir / "best.pt"),
        },
    }
    (deploy_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    log.info(f"Deployment manifest: {deploy_dir / 'manifest.json'}")
    return exported


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Fine-tune YOLO11 on Nigerian FMCG products using operator corrections"
    )
    parser.add_argument("--min-corrections", type=int, default=50,
                        help="Minimum number of corrections required to start training (default: 50)")
    parser.add_argument("--min-confidence", type=float, default=0.0,
                        help="Minimum correction confidence score (0.0–1.0, default: 0.0)")
    parser.add_argument("--epochs", type=int, default=50,
                        help="Number of training epochs (default: 50)")
    parser.add_argument("--model", default="yolo11n.pt",
                        help="Base YOLO model (default: yolo11n.pt). Use yolo11s.pt for better accuracy.")
    parser.add_argument("--img-size", type=int, default=640,
                        help="Input image size (default: 640)")
    parser.add_argument("--batch", type=int, default=16,
                        help="Batch size (default: 16). Reduce to 8 if OOM.")
    parser.add_argument("--device", default="auto",
                        help="Training device: auto, cpu, cuda, mps (default: auto)")
    parser.add_argument("--output-dir", default="./runs/finetune",
                        help="Output directory for training runs (default: ./runs/finetune)")
    parser.add_argument("--val-split", type=float, default=0.15,
                        help="Fraction of sessions to use for validation (default: 0.15)")
    parser.add_argument("--export-formats", nargs="+", default=["onnx"],
                        help="Export formats after training (default: onnx)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch corrections and build dataset but do not train")
    parser.add_argument("--db-url", default=os.environ.get("DATABASE_URL", ""),
                        help="PostgreSQL connection string (or set DATABASE_URL env var)")
    parser.add_argument("--list-classes", action="store_true",
                        help="Print all FMCG class names and exit")
    args = parser.parse_args()

    if args.list_classes:
        print(f"\nNigerian FMCG Classes ({len(CLASS_NAMES)} total):\n")
        for cls in FMCG_CLASSES:
            print(f"  [{cls['id']:2d}] {cls['name']:<30}  aliases: {', '.join(cls['aliases'][:3])}")
        return

    if not args.db_url:
        log.error("DATABASE_URL not set. Pass --db-url or set the environment variable.")
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Step 1: Fetch corrections ─────────────────────────────────────────────
    log.info("=" * 60)
    log.info("Step 1/5: Fetching human-verified corrections from DB")
    corrections = fetch_corrections(args.db_url, args.min_confidence)

    if len(corrections) < args.min_corrections:
        log.warning(
            f"Only {len(corrections)} corrections found (minimum: {args.min_corrections}). "
            f"Collect more operator feedback before fine-tuning. "
            f"Use --min-corrections {len(corrections)} to override."
        )
        if not args.dry_run:
            sys.exit(0)

    # ── Step 2: Build dataset ─────────────────────────────────────────────────
    log.info("=" * 60)
    log.info("Step 2/5: Building YOLO dataset from corrections")
    with tempfile.TemporaryDirectory(prefix="fmcg_dataset_") as tmpdir:
        dataset_dir = Path(tmpdir) / "dataset"
        yaml_path = build_dataset(corrections, dataset_dir, val_split=args.val_split)

        # Count actual training samples
        n_train = len(list((dataset_dir / "images" / "train").glob("*.jpg")))
        n_val   = len(list((dataset_dir / "images" / "val").glob("*.jpg")))
        log.info(f"Dataset ready: {n_train} train + {n_val} val images")

        if n_train < 10:
            log.error(f"Too few training images ({n_train}). Need at least 10. Check image URLs and S3 access.")
            if not args.dry_run:
                sys.exit(1)

        if args.dry_run:
            log.info("Dry run complete. Dataset built but training skipped.")
            log.info(f"Dataset YAML: {yaml_path}")
            return

        # ── Step 3: Train ─────────────────────────────────────────────────────
        log.info("=" * 60)
        log.info(f"Step 3/5: Fine-tuning {args.model} for {args.epochs} epochs")
        log.info(f"Device: {args.device} | Batch: {args.batch} | ImgSize: {args.img_size}")
        best_weights = run_training(
            yaml_path=yaml_path,
            base_model=args.model,
            epochs=args.epochs,
            output_dir=output_dir,
            img_size=args.img_size,
            batch=args.batch,
            device=args.device,
        )

        # ── Step 4: Export ────────────────────────────────────────────────────
        log.info("=" * 60)
        log.info("Step 4/5: Exporting model for deployment")
        exported = export_model(best_weights, output_dir, formats=args.export_formats)

        # ── Step 5: Summary ───────────────────────────────────────────────────
        log.info("=" * 60)
        log.info("Step 5/5: Training complete!")
        log.info(f"Best weights: {best_weights}")
        log.info(f"Exported formats: {list(exported.keys())}")
        log.info("")
        log.info("Next steps:")
        log.info("  1. Copy best.onnx to the python-vlm service:")
        log.info("     cp runs/finetune/deploy/nigerian_fmcg_*/best.onnx ../app/models/")
        log.info("  2. Set YOLO_MODEL_PATH=app/models/best.onnx in the VLM service env")
        log.info("  3. Restart the python-vlm Docker container")
        log.info("  4. Run a test scan to verify improved accuracy")
        log.info("")
        log.info("Tip: Re-run this script weekly as operators correct more scans.")
        log.info("     The model improves continuously with each correction cycle.")


if __name__ == "__main__":
    main()
