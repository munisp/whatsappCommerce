#!/usr/bin/env python3
"""
build_dataset.py — End-to-end YOLO dataset builder for Nigerian FMCG products

This script takes the collected product images (one class per folder) and:
  1. Validates all images and removes corrupt/unreadable files
  2. Generates pseudo-labels using GroundingDINO zero-shot detection
     (or falls back to whole-image bounding boxes for clean product shots)
  3. Applies cut-paste augmentation to create synthetic shelf scenes
  4. Splits into train/val sets (80/20)
  5. Writes the YOLO dataset.yaml
  6. Prints a training command ready to run

Usage:
  python build_dataset.py --products-dir ./products --output-dir ./dataset
  python build_dataset.py --products-dir ./products --output-dir ./dataset --augment-count 50
  python build_dataset.py --products-dir ./products --output-dir ./dataset --use-grounding-dino

Requirements (install in the python-vlm container):
  pip install ultralytics pillow numpy opencv-python-headless tqdm
  # For GroundingDINO zero-shot labelling (optional, GPU recommended):
  pip install autodistill autodistill-grounding-dino
"""

import argparse
import json
import os
import random
import shutil
import sys
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter
from tqdm import tqdm

# ── Class registry (matches finetune.py and taxonomy.ts) ─────────────────────
CLASSES = [
    "indomie_pack", "maggi_cube", "knorr_cube", "royco_cube",
    "dano_milk", "peak_milk", "cowbell_sachet",
    "bigi_cola", "coca_cola_bottle", "coca_cola_can",
    "malta_guinness", "eva_water", "pure_water_sachet", "chivita_juice",
    "gino_tomato", "tasty_tom",
    "mama_gold_rice", "caprice_rice", "garri_bag",
    "devon_kings_oil", "mamador_oil",
    "omo_sachet", "ariel_sachet",
    "key_soap", "dettol_soap",
    "vaseline_sachet", "robb",
    "cabin_biscuit", "digestive_biscuit", "dangote_noodles",
]
CLASS_TO_IDX = {c: i for i, c in enumerate(CLASSES)}

# ── Background colours for synthetic shelf scenes ─────────────────────────────
SHELF_BACKGROUNDS = [
    (245, 245, 220),  # Beige (wood shelf)
    (200, 200, 200),  # Light grey (metal shelf)
    (255, 255, 255),  # White (clean background)
    (180, 160, 140),  # Warm brown (wooden market stall)
    (220, 220, 200),  # Off-white (concrete wall)
    (160, 180, 160),  # Muted green (outdoor market)
]


def validate_images(products_dir: Path) -> dict[str, list[Path]]:
    """Validate all product images and return {class_name: [valid_paths]}."""
    valid: dict[str, list[Path]] = {}
    total_valid = 0
    total_invalid = 0

    for cls in CLASSES:
        cls_dir = products_dir / cls
        if not cls_dir.exists():
            print(f"  ⚠ Missing class directory: {cls}")
            valid[cls] = []
            continue

        cls_valid = []
        for img_path in sorted(cls_dir.iterdir()):
            if img_path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
                continue
            try:
                with Image.open(img_path) as img:
                    img.verify()
                cls_valid.append(img_path)
                total_valid += 1
            except Exception as e:
                print(f"  ✗ Corrupt image {img_path.name}: {e}")
                total_invalid += 1

        valid[cls] = cls_valid

    print(f"\n✓ Validated {total_valid} images ({total_invalid} corrupt/skipped)")
    ready = sum(1 for v in valid.values() if len(v) >= 2)
    print(f"✓ {ready}/{len(CLASSES)} classes have ≥2 images\n")
    return valid


def whole_image_bbox_label(class_idx: int, padding: float = 0.05) -> str:
    """
    Generate a YOLO label treating the whole image as one bounding box.
    Used for clean product shots on white/neutral backgrounds.
    Adds a small padding to avoid touching the edges.
    Format: <class_idx> <cx> <cy> <w> <h>  (all normalised 0-1)
    """
    cx, cy = 0.5, 0.5
    w = 1.0 - 2 * padding
    h = 1.0 - 2 * padding
    return f"{class_idx} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}"


def augment_image(img: Image.Image) -> Image.Image:
    """Apply random augmentations to a product image."""
    # Random brightness
    factor = random.uniform(0.6, 1.4)
    img = ImageEnhance.Brightness(img).enhance(factor)
    # Random contrast
    factor = random.uniform(0.7, 1.3)
    img = ImageEnhance.Contrast(img).enhance(factor)
    # Random saturation
    factor = random.uniform(0.5, 1.5)
    img = ImageEnhance.Color(img).enhance(factor)
    # Random slight blur (simulates camera focus variation)
    if random.random() < 0.3:
        img = img.filter(ImageFilter.GaussianBlur(radius=random.uniform(0.5, 1.5)))
    # Random horizontal flip
    if random.random() < 0.5:
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    # Random rotation ±15 degrees
    angle = random.uniform(-15, 15)
    img = img.rotate(angle, expand=False, fillcolor=(255, 255, 255))
    return img


def create_synthetic_scene(
    product_images: dict[str, list[Path]],
    scene_size: tuple[int, int] = (640, 640),
    products_per_scene: int = 3,
    product_scale: float = 0.25,
) -> tuple[Image.Image, list[tuple[int, float, float, float, float]]]:
    """
    Create a synthetic shelf scene by pasting product images onto a background.
    Returns (scene_image, [(class_idx, cx, cy, w, h), ...]) in YOLO format.
    """
    bg_color = random.choice(SHELF_BACKGROUNDS)
    # Add slight noise to background
    bg_array = np.full((scene_size[1], scene_size[0], 3), bg_color, dtype=np.uint8)
    noise = np.random.randint(-15, 15, bg_array.shape, dtype=np.int16)
    bg_array = np.clip(bg_array.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    scene = Image.fromarray(bg_array, "RGB")

    annotations = []
    # Pick random classes for this scene
    available_classes = [c for c, imgs in product_images.items() if imgs]
    if not available_classes:
        return scene, annotations

    chosen_classes = random.choices(available_classes, k=min(products_per_scene, len(available_classes)))
    sw, sh = scene_size
    product_w = int(sw * product_scale)
    product_h = int(sh * product_scale)

    placed: list[tuple[int, int, int, int]] = []  # (x1, y1, x2, y2)

    for cls in chosen_classes:
        src_path = random.choice(product_images[cls])
        try:
            with Image.open(src_path) as prod_img:
                prod_img = prod_img.convert("RGBA")
                # Resize product
                scale = random.uniform(0.8, 1.2)
                pw = int(product_w * scale)
                ph = int(product_h * scale)
                prod_img = prod_img.resize((pw, ph), Image.LANCZOS)
                # Augment
                prod_rgb = augment_image(prod_img.convert("RGB"))
                prod_img = prod_rgb.convert("RGBA")

                # Find non-overlapping position (max 20 attempts)
                for _ in range(20):
                    x1 = random.randint(0, max(0, sw - pw))
                    y1 = random.randint(0, max(0, sh - ph))
                    x2, y2 = x1 + pw, y1 + ph
                    # Check overlap
                    overlap = any(
                        not (x2 < px1 or x1 > px2 or y2 < py1 or y1 > py2)
                        for px1, py1, px2, py2 in placed
                    )
                    if not overlap:
                        break

                scene.paste(prod_rgb, (x1, y1))
                placed.append((x1, y1, x2, y2))

                # YOLO annotation
                cx = (x1 + x2) / 2 / sw
                cy = (y1 + y2) / 2 / sh
                w = pw / sw
                h = ph / sh
                annotations.append((CLASS_TO_IDX[cls], cx, cy, w, h))
        except Exception as e:
            print(f"  ⚠ Failed to paste {src_path.name}: {e}")

    return scene, annotations


def write_yolo_label(label_path: Path, annotations: list[tuple[int, float, float, float, float]]) -> None:
    with open(label_path, "w") as f:
        for cls_idx, cx, cy, w, h in annotations:
            f.write(f"{cls_idx} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n")


def build_dataset(
    products_dir: Path,
    output_dir: Path,
    augment_count: int = 200,
    val_split: float = 0.2,
    use_grounding_dino: bool = False,
) -> None:
    print("=" * 60)
    print("Nigerian FMCG YOLO Dataset Builder")
    print("=" * 60)

    # Validate images
    product_images = validate_images(products_dir)

    # Create output directories
    for split in ["train", "val"]:
        (output_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (output_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    all_samples: list[tuple[Path, Path, str]] = []  # (img_path, label_path, split)

    # ── Step 1: Add real product images with whole-image labels ───────────────
    print("Step 1: Adding real product images...")
    real_count = 0
    for cls, img_paths in product_images.items():
        if not img_paths:
            continue
        cls_idx = CLASS_TO_IDX[cls]
        for i, src_path in enumerate(img_paths):
            split = "val" if i == 0 and len(img_paths) > 1 else "train"
            dst_name = f"real_{cls}_{i:03d}.jpg"
            dst_img = output_dir / "images" / split / dst_name
            dst_lbl = output_dir / "labels" / split / dst_name.replace(".jpg", ".txt")

            try:
                with Image.open(src_path) as img:
                    img.convert("RGB").save(dst_img, "JPEG", quality=95)
                with open(dst_lbl, "w") as f:
                    f.write(whole_image_bbox_label(cls_idx) + "\n")
                real_count += 1
            except Exception as e:
                print(f"  ⚠ Skipping {src_path.name}: {e}")

    print(f"  ✓ Added {real_count} real product images")

    # ── Step 2: Generate synthetic shelf scenes ────────────────────────────────
    print(f"\nStep 2: Generating {augment_count} synthetic shelf scenes...")
    synth_count = 0
    val_threshold = int(augment_count * val_split)

    for i in tqdm(range(augment_count), desc="Synthetic scenes"):
        split = "val" if i < val_threshold else "train"
        scene, annotations = create_synthetic_scene(product_images)
        if not annotations:
            continue

        dst_name = f"synth_{i:05d}.jpg"
        dst_img = output_dir / "images" / split / dst_name
        dst_lbl = output_dir / "labels" / split / dst_name.replace(".jpg", ".txt")

        scene.save(dst_img, "JPEG", quality=90)
        write_yolo_label(dst_lbl, annotations)
        synth_count += 1

    print(f"  ✓ Generated {synth_count} synthetic scenes")

    # ── Step 3: GroundingDINO zero-shot labelling (optional) ──────────────────
    if use_grounding_dino:
        print("\nStep 3: GroundingDINO zero-shot labelling (this may take a while)...")
        try:
            from autodistill.detection import CaptionOntology
            from autodistill_grounding_dino import GroundingDINO

            ontology = CaptionOntology({
                "Indomie noodles pack": "indomie_pack",
                "Maggi seasoning cube": "maggi_cube",
                "Knorr seasoning cube": "knorr_cube",
                "Royco seasoning cube": "royco_cube",
                "Dano milk sachet": "dano_milk",
                "Peak milk sachet": "peak_milk",
                "Cowbell milk sachet": "cowbell_sachet",
                "Bigi Cola bottle": "bigi_cola",
                "Coca-Cola bottle": "coca_cola_bottle",
                "Coca-Cola can": "coca_cola_can",
                "Malta Guinness bottle": "malta_guinness",
                "Eva water bottle": "eva_water",
                "pure water sachet nylon bag": "pure_water_sachet",
                "Chivita juice pack": "chivita_juice",
                "Gino tomato paste sachet": "gino_tomato",
                "Tasty Tom tomato paste": "tasty_tom",
                "Mama Gold rice bag": "mama_gold_rice",
                "Caprice rice bag": "caprice_rice",
                "garri bag": "garri_bag",
                "Devon King's vegetable oil bottle": "devon_kings_oil",
                "Mamador vegetable oil bottle": "mamador_oil",
                "Omo detergent sachet": "omo_sachet",
                "Ariel detergent sachet": "ariel_sachet",
                "Key soap bar": "key_soap",
                "Dettol soap bar": "dettol_soap",
                "Vaseline petroleum jelly sachet": "vaseline_sachet",
                "Robb balm tin": "robb",
                "Cabin biscuit pack": "cabin_biscuit",
                "McVitie's digestive biscuit": "digestive_biscuit",
                "Dangote instant noodles": "dangote_noodles",
            })

            model = GroundingDINO(ontology=ontology)
            grounding_dir = output_dir / "grounding_dino_labels"
            grounding_dir.mkdir(exist_ok=True)

            for cls, img_paths in product_images.items():
                for src_path in img_paths:
                    try:
                        results = model.predict(str(src_path))
                        # Convert to YOLO format and save
                        lbl_path = grounding_dir / (src_path.stem + ".txt")
                        with open(lbl_path, "w") as f:
                            for box, cls_id in zip(results.xyxy, results.class_id):
                                with Image.open(src_path) as img:
                                    w, h = img.size
                                x1, y1, x2, y2 = box
                                cx = (x1 + x2) / 2 / w
                                cy = (y1 + y2) / 2 / h
                                bw = (x2 - x1) / w
                                bh = (y2 - y1) / h
                                f.write(f"{cls_id} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n")
                    except Exception as e:
                        print(f"  ⚠ GroundingDINO failed for {src_path.name}: {e}")

            print(f"  ✓ GroundingDINO labels saved to {grounding_dir}")
        except ImportError:
            print("  ⚠ autodistill not installed. Skipping GroundingDINO step.")
            print("    Install: pip install autodistill autodistill-grounding-dino")

    # ── Step 4: Write dataset.yaml ─────────────────────────────────────────────
    print("\nStep 4: Writing dataset.yaml...")
    train_count = len(list((output_dir / "images" / "train").glob("*.jpg")))
    val_count = len(list((output_dir / "images" / "val").glob("*.jpg")))

    dataset_yaml = {
        "path": str(output_dir.resolve()),
        "train": "images/train",
        "val": "images/val",
        "nc": len(CLASSES),
        "names": CLASSES,
        "# Nigerian FMCG Dataset": f"Generated by build_dataset.py | {train_count} train, {val_count} val",
    }

    yaml_path = output_dir / "dataset.yaml"
    with open(yaml_path, "w") as f:
        f.write(f"# Nigerian FMCG YOLO Dataset\n")
        f.write(f"# Generated by build_dataset.py\n")
        f.write(f"# {train_count} train images | {val_count} val images | {len(CLASSES)} classes\n\n")
        f.write(f"path: {output_dir.resolve()}\n")
        f.write(f"train: images/train\n")
        f.write(f"val: images/val\n\n")
        f.write(f"nc: {len(CLASSES)}\n")
        f.write(f"names:\n")
        for cls in CLASSES:
            f.write(f"  - {cls}\n")

    # ── Step 5: Write manifest ─────────────────────────────────────────────────
    manifest = {
        "total_images": train_count + val_count,
        "train_images": train_count,
        "val_images": val_count,
        "classes": len(CLASSES),
        "class_names": CLASSES,
        "real_images": real_count,
        "synthetic_images": synth_count,
        "dataset_yaml": str(yaml_path),
    }
    with open(output_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

    # ── Summary ────────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("DATASET READY")
    print("=" * 60)
    print(f"  Train images : {train_count}")
    print(f"  Val images   : {val_count}")
    print(f"  Total        : {train_count + val_count}")
    print(f"  Classes      : {len(CLASSES)}")
    print(f"  Dataset YAML : {yaml_path}")
    print()
    print("To train YOLO11 on this dataset:")
    print(f"  yolo train model=yolo11s.pt data={yaml_path} epochs=100 batch=16 imgsz=640")
    print()
    print("To train with GPU:")
    print(f"  yolo train model=yolo11s.pt data={yaml_path} epochs=100 batch=32 imgsz=640 device=0")
    print()
    print("To export to ONNX after training:")
    print("  yolo export model=runs/detect/train/weights/best.pt format=onnx")
    print("=" * 60)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build Nigerian FMCG YOLO dataset")
    parser.add_argument("--products-dir", type=Path, default=Path("./products"),
                        help="Directory with one subfolder per product class")
    parser.add_argument("--output-dir", type=Path, default=Path("./dataset"),
                        help="Output directory for the YOLO dataset")
    parser.add_argument("--augment-count", type=int, default=200,
                        help="Number of synthetic shelf scenes to generate (default: 200)")
    parser.add_argument("--val-split", type=float, default=0.2,
                        help="Fraction of synthetic images to use for validation (default: 0.2)")
    parser.add_argument("--use-grounding-dino", action="store_true",
                        help="Use GroundingDINO for zero-shot labelling (requires autodistill)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)

    build_dataset(
        products_dir=args.products_dir,
        output_dir=args.output_dir,
        augment_count=args.augment_count,
        val_split=args.val_split,
        use_grounding_dino=args.use_grounding_dino,
    )
