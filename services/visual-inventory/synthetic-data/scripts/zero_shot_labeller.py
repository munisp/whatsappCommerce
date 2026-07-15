"""
Zero-Shot Labeller using Autodistill + GroundingDINO
=====================================================
Labels real shelf images from the platform S3 store WITHOUT any manual annotation.
Uses GroundingDINO to detect Nigerian FMCG products by text prompt.

Usage:
  python zero_shot_labeller.py \
    --db-url $DATABASE_URL \
    --s3-bucket $S3_BUCKET \
    --output-dir ./labelled_dataset \
    --classes indomie,maggi,dano,bigi,cowbell \
    --confidence 0.35
"""

import argparse
import os
import json
import tempfile
from pathlib import Path
import httpx
import boto3
import psycopg2
import yaml
from tqdm import tqdm
from PIL import Image
import numpy as np

# Nigerian FMCG class definitions with text prompts for GroundingDINO
NIGERIAN_FMCG_CLASSES = {
    # Beverages
    "coca_cola_bottle":     ["coca cola bottle", "coke bottle", "red cola bottle"],
    "coca_cola_can":        ["coca cola can", "coke can"],
    "bigi_cola":            ["bigi cola bottle", "bigi orange", "bigi drink"],
    "malta_guinness":       ["malta guinness bottle", "malta drink", "malt drink bottle"],
    "eva_water":            ["eva water bottle", "eva mineral water"],
    "pure_water_sachet":    ["pure water sachet", "water sachet", "nylon water bag"],
    "chivita_juice":        ["chivita juice pack", "chivita box", "juice carton"],
    # Noodles
    "indomie_pack":         ["indomie noodles pack", "indomie sachet", "instant noodles pack"],
    "dangote_noodles":      ["dangote noodles", "dangote pasta pack"],
    # Seasoning
    "maggi_cube":           ["maggi cube", "maggi seasoning cube", "maggi bouillon"],
    "knorr_cube":           ["knorr cube", "knorr seasoning", "knorr bouillon"],
    "royco_cube":           ["royco cube", "royco seasoning"],
    "gino_tomato":          ["gino tomato paste sachet", "gino tomato tin"],
    "tasty_tom":            ["tasty tom tomato paste", "tasty tom sachet"],
    # Dairy
    "dano_milk":            ["dano milk sachet", "dano powdered milk", "dano milk tin"],
    "peak_milk":            ["peak milk tin", "peak milk sachet", "peak evaporated milk"],
    "cowbell_sachet":       ["cowbell milk sachet", "cowbell chocolate drink sachet"],
    # Grains
    "mama_gold_rice":       ["mama gold rice bag", "mama gold 5kg", "mama gold 10kg"],
    "caprice_rice":         ["caprice rice bag", "caprice parboiled rice"],
    "garri_bag":            ["garri bag", "white garri", "yellow garri", "cassava flakes bag"],
    # Cooking oil
    "devon_kings_oil":      ["devon kings oil bottle", "devon kings vegetable oil"],
    "mamador_oil":          ["mamador oil bottle", "mamador vegetable oil"],
    # Detergent
    "omo_sachet":           ["omo detergent sachet", "omo washing powder sachet"],
    "ariel_sachet":         ["ariel detergent sachet", "ariel washing powder"],
    "key_soap":             ["key soap bar", "key laundry soap"],
    # Personal care
    "dettol_soap":          ["dettol soap bar", "dettol antiseptic soap"],
    "vaseline_sachet":      ["vaseline sachet", "vaseline petroleum jelly sachet"],
    "robb":                 ["robb balm", "robb mentholated rub"],
    # Snacks
    "digestive_biscuit":    ["digestive biscuit pack", "mcvities digestive"],
    "cabin_biscuit":        ["cabin biscuit", "cabin crackers pack"],
}


def download_s3_image(s3_client, bucket: str, key: str, local_path: str) -> bool:
    """Download an image from S3 to a local path."""
    try:
        s3_client.download_file(bucket, key, local_path)
        return True
    except Exception as e:
        print(f"  [WARN] Failed to download {key}: {e}")
        return False


def run_grounding_dino(image_path: str, class_prompts: dict, confidence: float) -> list:
    """
    Run GroundingDINO zero-shot detection on a single image.
    Returns list of {label, bbox_xyxy, confidence} dicts.
    """
    try:
        from autodistill.detection import CaptionOntology
        from autodistill_grounding_dino import GroundingDINO

        # Build ontology: text_prompt -> class_label
        ontology_map = {}
        for class_label, prompts in class_prompts.items():
            for prompt in prompts:
                ontology_map[prompt] = class_label

        ontology = CaptionOntology(ontology_map)
        model = GroundingDINO(ontology=ontology, box_threshold=confidence, text_threshold=confidence)
        results = model.predict(image_path)

        detections = []
        for i, bbox in enumerate(results.xyxy):
            detections.append({
                "label": results.data["class_name"][i],
                "bbox_xyxy": bbox.tolist(),
                "confidence": float(results.confidence[i]),
            })
        return detections
    except ImportError:
        print("  [WARN] autodistill-grounding-dino not installed. Using Ollama VLM fallback.")
        return run_ollama_vlm_detection(image_path, class_prompts, confidence)


def run_ollama_vlm_detection(image_path: str, class_prompts: dict, confidence: float) -> list:
    """
    Fallback: use Ollama Qwen2.5-VL / Gemma3 for zero-shot detection when
    GroundingDINO is not available (CPU-only environments).
    Returns list of {label, bbox_xyxy, confidence} dicts.
    """
    import base64

    ollama_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
    model = os.environ.get("OLLAMA_VLM_MODEL", "qwen2.5vl:7b")

    with open(image_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode()

    class_list = ", ".join(list(class_prompts.keys())[:20])
    prompt = (
        f"You are a retail shelf inventory AI. Analyse this shelf image and detect all visible products.\n"
        f"Known Nigerian FMCG product classes: {class_list}\n"
        f"For each detected product, respond with JSON array: "
        f'[{{"label": "class_name", "bbox": [x1,y1,x2,y2], "confidence": 0.0-1.0}}]\n'
        f"Coordinates are pixel values. Return ONLY the JSON array, no other text."
    )

    try:
        resp = httpx.post(
            f"{ollama_url}/api/generate",
            json={"model": model, "prompt": prompt, "images": [img_b64], "stream": False},
            timeout=60,
        )
        resp.raise_for_status()
        raw = resp.json().get("response", "[]")
        # Extract JSON from response
        start = raw.find("[")
        end = raw.rfind("]") + 1
        if start >= 0 and end > start:
            detections = json.loads(raw[start:end])
            return [
                {
                    "label": d.get("label", "unknown"),
                    "bbox_xyxy": d.get("bbox", [0, 0, 100, 100]),
                    "confidence": float(d.get("confidence", 0.5)),
                }
                for d in detections
                if float(d.get("confidence", 0)) >= confidence
            ]
    except Exception as e:
        print(f"  [WARN] Ollama VLM detection failed: {e}")
    return []


def bbox_to_yolo(bbox_xyxy: list, img_w: int, img_h: int) -> tuple:
    """Convert [x1,y1,x2,y2] to YOLO format (cx,cy,w,h) normalised 0-1."""
    x1, y1, x2, y2 = bbox_xyxy
    cx = ((x1 + x2) / 2) / img_w
    cy = ((y1 + y2) / 2) / img_h
    w = (x2 - x1) / img_w
    h = (y2 - y1) / img_h
    return cx, cy, w, h


def label_images_from_db(db_url: str, s3_bucket: str, output_dir: str,
                          classes: list, confidence: float, limit: int):
    """Pull scan session images from DB/S3 and run zero-shot labelling."""
    output_path = Path(output_dir)
    images_dir = output_path / "images" / "train"
    labels_dir = output_path / "labels" / "train"
    images_dir.mkdir(parents=True, exist_ok=True)
    labels_dir.mkdir(parents=True, exist_ok=True)

    # Filter class_prompts to only requested classes
    class_prompts = {k: v for k, v in NIGERIAN_FMCG_CLASSES.items()
                     if not classes or k in classes}
    class_names = sorted(class_prompts.keys())
    class_index = {name: i for i, name in enumerate(class_names)}

    # Connect to DB and get scan sessions with S3 image keys
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    cur.execute("""
        SELECT id, image_s3_key, scan_location
        FROM visual_inventory_sessions
        WHERE image_s3_key IS NOT NULL
        ORDER BY created_at DESC
        LIMIT %s
    """, (limit,))
    sessions = cur.fetchall()
    cur.close()
    conn.close()

    if not sessions:
        print("[INFO] No sessions with S3 images found. Run some visual inventory scans first.")
        return class_names

    s3 = boto3.client("s3")
    labelled = 0

    for session_id, s3_key, location in tqdm(sessions, desc="Labelling images"):
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_path = tmp.name

        if not download_s3_image(s3, s3_bucket, s3_key, tmp_path):
            continue

        try:
            img = Image.open(tmp_path)
            img_w, img_h = img.size
        except Exception:
            continue

        detections = run_grounding_dino(tmp_path, class_prompts, confidence)
        if not detections:
            os.unlink(tmp_path)
            continue

        # Save image
        img_out = images_dir / f"session_{session_id}.jpg"
        img.save(str(img_out))

        # Save YOLO label file
        label_out = labels_dir / f"session_{session_id}.txt"
        with open(label_out, "w") as lf:
            for det in detections:
                if det["label"] not in class_index:
                    continue
                cls_id = class_index[det["label"]]
                cx, cy, w, h = bbox_to_yolo(det["bbox_xyxy"], img_w, img_h)
                lf.write(f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n")
        labelled += 1
        os.unlink(tmp_path)

    print(f"[INFO] Labelled {labelled}/{len(sessions)} images → {output_dir}")
    return class_names


def write_dataset_yaml(output_dir: str, class_names: list):
    """Write the YOLO dataset.yaml file."""
    yaml_path = Path(output_dir) / "dataset.yaml"
    data = {
        "path": str(Path(output_dir).resolve()),
        "train": "images/train",
        "val": "images/val",
        "nc": len(class_names),
        "names": class_names,
    }
    with open(yaml_path, "w") as f:
        yaml.dump(data, f, default_flow_style=False)
    print(f"[INFO] Dataset YAML written to {yaml_path}")
    return str(yaml_path)


def main():
    parser = argparse.ArgumentParser(description="Zero-Shot Labeller for Nigerian FMCG products")
    parser.add_argument("--db-url", default=os.environ.get("DATABASE_URL"), help="PostgreSQL connection URL")
    parser.add_argument("--s3-bucket", default=os.environ.get("S3_BUCKET"), help="S3 bucket name")
    parser.add_argument("--output-dir", default="./zero_shot_dataset", help="Output directory for YOLO dataset")
    parser.add_argument("--classes", default="", help="Comma-separated class names (empty = all)")
    parser.add_argument("--confidence", type=float, default=0.35, help="Detection confidence threshold")
    parser.add_argument("--limit", type=int, default=500, help="Max images to process")
    parser.add_argument("--list-classes", action="store_true", help="List all available class names and exit")
    args = parser.parse_args()

    if args.list_classes:
        print("Available Nigerian FMCG classes:")
        for cls, prompts in NIGERIAN_FMCG_CLASSES.items():
            print(f"  {cls}: {', '.join(prompts[:2])}")
        return

    classes = [c.strip() for c in args.classes.split(",") if c.strip()]
    class_names = label_images_from_db(
        db_url=args.db_url,
        s3_bucket=args.s3_bucket,
        output_dir=args.output_dir,
        classes=classes,
        confidence=args.confidence,
        limit=args.limit,
    )
    write_dataset_yaml(args.output_dir, class_names)
    print("[DONE] Zero-shot labelling complete. Run finetune.py --dataset-yaml to train.")


if __name__ == "__main__":
    main()
