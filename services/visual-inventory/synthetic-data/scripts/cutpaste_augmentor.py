"""
Cut-Paste Augmentor for Nigerian FMCG Products
===============================================
Generates synthetic training images by cutting product images from clean backgrounds
and pasting them onto realistic shelf/market backgrounds.

This is the FASTEST way to build a large labelled dataset without manual annotation:
1. Collect ~10 clean product images per class (white background or transparent PNG)
2. Collect ~20 background images (Nigerian market shelves, kiosks, supermarkets)
3. Run this script to generate thousands of synthetic training images with YOLO labels

Usage:
  python cutpaste_augmentor.py \
    --products-dir ./products \
    --backgrounds-dir ./backgrounds \
    --output-dir ./synthetic_dataset \
    --images-per-class 200 \
    --max-objects 8
"""

import argparse
import json
import os
import random
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter
from tqdm import tqdm
import yaml


def load_product_images(products_dir: str) -> dict:
    """
    Load product images from directory structure:
    products/
      indomie_pack/  ← class name
        img1.png
        img2.jpg
      maggi_cube/
        ...
    Returns {class_name: [PIL.Image, ...]}
    """
    products = {}
    products_path = Path(products_dir)
    for class_dir in products_path.iterdir():
        if not class_dir.is_dir():
            continue
        class_name = class_dir.name
        images = []
        for img_file in class_dir.glob("*.{png,jpg,jpeg,webp}"):
            try:
                img = Image.open(img_file).convert("RGBA")
                images.append(img)
            except Exception:
                pass
        # Also try glob with uppercase
        for ext in ["*.PNG", "*.JPG", "*.JPEG", "*.WEBP"]:
            for img_file in class_dir.glob(ext):
                try:
                    img = Image.open(img_file).convert("RGBA")
                    images.append(img)
                except Exception:
                    pass
        if images:
            products[class_name] = images
            print(f"  Loaded {len(images)} images for class '{class_name}'")
    return products


def remove_background_simple(img: Image.Image) -> Image.Image:
    """
    Simple background removal using flood-fill from corners.
    Works well for products on white/light backgrounds.
    For better results, use rembg: pip install rembg
    """
    try:
        from rembg import remove
        return remove(img)
    except ImportError:
        pass

    # Fallback: threshold-based removal for white backgrounds
    img_rgb = img.convert("RGB")
    arr = np.array(img_rgb)
    # Create mask: pixels close to white (>240,>240,>240) become transparent
    mask = np.all(arr > 240, axis=2)
    rgba = np.array(img.convert("RGBA"))
    rgba[mask, 3] = 0
    return Image.fromarray(rgba)


def augment_product(img: Image.Image, target_size: tuple) -> Image.Image:
    """Apply random augmentations to a product image."""
    # Random scale
    scale = random.uniform(0.5, 1.2)
    new_w = int(target_size[0] * scale)
    new_h = int(target_size[1] * scale)
    img = img.resize((max(20, new_w), max(20, new_h)), Image.LANCZOS)

    # Random rotation (-15 to +15 degrees)
    angle = random.uniform(-15, 15)
    img = img.rotate(angle, expand=True)

    # Random brightness/contrast
    enhancer = ImageEnhance.Brightness(img)
    img = enhancer.enhance(random.uniform(0.7, 1.3))
    enhancer = ImageEnhance.Contrast(img)
    img = enhancer.enhance(random.uniform(0.8, 1.2))

    # Occasional blur (simulates camera focus)
    if random.random() < 0.2:
        img = img.filter(ImageFilter.GaussianBlur(radius=random.uniform(0.5, 1.5)))

    return img


def paste_products_on_background(
    background: Image.Image,
    products: dict,
    class_index: dict,
    max_objects: int,
    min_objects: int = 2,
) -> tuple:
    """
    Paste random products onto a background image.
    Returns (composite_image, yolo_labels_list)
    """
    bg = background.copy().convert("RGB")
    bg_w, bg_h = bg.size
    labels = []
    placed = 0
    n_objects = random.randint(min_objects, max_objects)

    # Shuffle classes for variety
    available_classes = list(products.keys())
    random.shuffle(available_classes)

    for _ in range(n_objects):
        if not available_classes:
            break
        class_name = random.choice(available_classes)
        product_img = random.choice(products[class_name])

        # Target size: 5-25% of background width
        target_w = int(bg_w * random.uniform(0.05, 0.25))
        target_h = int(target_w * (product_img.height / max(product_img.width, 1)))
        product_aug = augment_product(product_img, (target_w, target_h))

        # Random position (ensure product fits within background)
        prod_w, prod_h = product_aug.size
        if prod_w >= bg_w or prod_h >= bg_h:
            continue
        x = random.randint(0, bg_w - prod_w)
        y = random.randint(0, bg_h - prod_h)

        # Paste with alpha channel
        if product_aug.mode == "RGBA":
            bg.paste(product_aug.convert("RGB"), (x, y),
                     mask=product_aug.split()[3])
        else:
            bg.paste(product_aug.convert("RGB"), (x, y))

        # YOLO label (cx, cy, w, h) normalised
        cx = (x + prod_w / 2) / bg_w
        cy = (y + prod_h / 2) / bg_h
        w = prod_w / bg_w
        h = prod_h / bg_h
        cls_id = class_index.get(class_name, 0)
        labels.append(f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
        placed += 1

    return bg, labels


def generate_synthetic_dataset(
    products_dir: str,
    backgrounds_dir: str,
    output_dir: str,
    images_per_class: int,
    max_objects: int,
    val_split: float = 0.15,
):
    print("[INFO] Loading product images...")
    products = load_product_images(products_dir)
    if not products:
        print(f"[ERROR] No product images found in {products_dir}")
        print("  Create subdirectories named after each product class, e.g.:")
        print("  products/indomie_pack/img1.png")
        return

    print(f"[INFO] Loading background images from {backgrounds_dir}...")
    bg_images = []
    for ext in ["*.jpg", "*.jpeg", "*.png", "*.webp", "*.JPG", "*.JPEG", "*.PNG"]:
        for bg_file in Path(backgrounds_dir).glob(ext):
            try:
                bg_images.append(Image.open(bg_file).convert("RGB"))
            except Exception:
                pass

    if not bg_images:
        print(f"[WARN] No background images in {backgrounds_dir}. Using solid grey backgrounds.")
        bg_images = [Image.new("RGB", (640, 640), color=(180, 180, 180))]

    class_names = sorted(products.keys())
    class_index = {name: i for i, name in enumerate(class_names)}
    total_images = images_per_class * len(class_names)
    n_val = int(total_images * val_split)

    out = Path(output_dir)
    for split in ["train", "val"]:
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)

    print(f"[INFO] Generating {total_images} synthetic images ({len(class_names)} classes × {images_per_class})...")

    for i in tqdm(range(total_images), desc="Generating"):
        split = "val" if i < n_val else "train"
        bg = random.choice(bg_images).copy()
        # Resize background to 640×640
        bg = bg.resize((640, 640), Image.LANCZOS)

        composite, labels = paste_products_on_background(
            bg, products, class_index, max_objects
        )

        img_path = out / "images" / split / f"synthetic_{i:06d}.jpg"
        lbl_path = out / "labels" / split / f"synthetic_{i:06d}.txt"

        composite.save(str(img_path), quality=90)
        with open(lbl_path, "w") as f:
            f.write("\n".join(labels))

    # Write dataset YAML
    yaml_path = out / "dataset.yaml"
    with open(yaml_path, "w") as f:
        yaml.dump({
            "path": str(out.resolve()),
            "train": "images/train",
            "val": "images/val",
            "nc": len(class_names),
            "names": class_names,
        }, f, default_flow_style=False)

    print(f"\n[DONE] Synthetic dataset generated:")
    print(f"  Images: {total_images} ({int(total_images*(1-val_split))} train, {n_val} val)")
    print(f"  Classes: {len(class_names)}")
    print(f"  YAML: {yaml_path}")
    print(f"\nNext step: python finetune.py --dataset-yaml {yaml_path}")


def main():
    parser = argparse.ArgumentParser(description="Cut-Paste Augmentor for Nigerian FMCG products")
    parser.add_argument("--products-dir", default="./products",
                        help="Directory with product images (subdirs = class names)")
    parser.add_argument("--backgrounds-dir", default="./backgrounds",
                        help="Directory with background shelf/market images")
    parser.add_argument("--output-dir", default="./synthetic_dataset",
                        help="Output directory for synthetic YOLO dataset")
    parser.add_argument("--images-per-class", type=int, default=200,
                        help="Number of synthetic images to generate per class")
    parser.add_argument("--max-objects", type=int, default=8,
                        help="Maximum number of products per synthetic image")
    parser.add_argument("--val-split", type=float, default=0.15,
                        help="Fraction of images for validation set")
    args = parser.parse_args()

    generate_synthetic_dataset(
        products_dir=args.products_dir,
        backgrounds_dir=args.backgrounds_dir,
        output_dir=args.output_dir,
        images_per_class=args.images_per_class,
        max_objects=args.max_objects,
        val_split=args.val_split,
    )


if __name__ == "__main__":
    main()
