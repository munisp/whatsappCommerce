"""
SDXL Background Generator for Nigerian Market Scenes
=====================================================
Generates realistic Nigerian market/shop background images using:
  - Ollama with SDXL (if available via ollama pull sdxl)
  - AUTOMATIC1111 API (if running locally)
  - Fallback: downloads free CC0 shelf images from Unsplash API

Usage:
  python sdxl_background_gen.py \
    --output-dir ./backgrounds \
    --count 50 \
    --style nigerian_market
"""

import argparse
import os
import json
import random
import time
from pathlib import Path
import requests
import base64
from io import BytesIO
from PIL import Image

# Nigerian market scene prompts for SDXL
NIGERIAN_MARKET_PROMPTS = [
    "Nigerian supermarket shelf with products, realistic photo, well-lit, 4k",
    "Lagos corner shop kiosk interior with shelves of products, realistic photo",
    "Nigerian provision store shelves with FMCG products, overhead fluorescent lighting",
    "West African market stall with packaged goods on wooden shelves, natural light",
    "Nigerian mini-mart interior, shelves stocked with beverages and food items",
    "Abuja supermarket aisle with consumer goods, clean bright lighting, photo",
    "Nigerian roadside kiosk with noodles, beverages, and seasoning on shelves",
    "African convenience store interior, shelves with packaged foods, realistic",
    "Nigerian open market provision section, colourful product packaging on display",
    "Lagos supermarket cold drinks section, refrigerator shelves, realistic photo",
    "Nigerian pharmacy/chemist shop shelves with personal care products",
    "West African grocery store interior, wooden shelves, mixed product packaging",
]

NEGATIVE_PROMPT = (
    "blurry, low quality, cartoon, illustration, drawing, text overlay, "
    "watermark, western supermarket, european products, american brands only"
)


def generate_via_automatic1111(prompt: str, output_path: str, width=640, height=640) -> bool:
    """Generate image via AUTOMATIC1111 WebUI API."""
    a1111_url = os.environ.get("A1111_URL", "http://localhost:7860")
    try:
        resp = requests.post(
            f"{a1111_url}/sdapi/v1/txt2img",
            json={
                "prompt": prompt,
                "negative_prompt": NEGATIVE_PROMPT,
                "width": width,
                "height": height,
                "steps": 25,
                "cfg_scale": 7,
                "sampler_name": "DPM++ 2M Karras",
            },
            timeout=120,
        )
        if resp.status_code == 200:
            img_b64 = resp.json()["images"][0]
            img = Image.open(BytesIO(base64.b64decode(img_b64)))
            img.save(output_path)
            return True
    except Exception as e:
        print(f"  [WARN] A1111 failed: {e}")
    return False


def generate_via_ollama_sdxl(prompt: str, output_path: str) -> bool:
    """Generate image via Ollama SDXL (if sdxl model is pulled)."""
    ollama_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
    try:
        resp = requests.post(
            f"{ollama_url}/api/generate",
            json={"model": "sdxl", "prompt": prompt, "stream": False},
            timeout=120,
        )
        if resp.status_code == 200:
            data = resp.json()
            if "images" in data and data["images"]:
                img = Image.open(BytesIO(base64.b64decode(data["images"][0])))
                img.save(output_path)
                return True
    except Exception as e:
        print(f"  [WARN] Ollama SDXL failed: {e}")
    return False


def download_unsplash_background(output_path: str, query: str = "supermarket shelf") -> bool:
    """
    Download a free CC0 background from Unsplash (no API key needed for small counts).
    Falls back to a solid grey image if download fails.
    """
    unsplash_url = f"https://source.unsplash.com/640x640/?{query.replace(' ', ',')}"
    try:
        resp = requests.get(unsplash_url, timeout=15, allow_redirects=True)
        if resp.status_code == 200 and resp.headers.get("content-type", "").startswith("image"):
            img = Image.open(BytesIO(resp.content)).convert("RGB")
            img = img.resize((640, 640), Image.LANCZOS)
            img.save(output_path)
            return True
    except Exception as e:
        print(f"  [WARN] Unsplash download failed: {e}")
    return False


def generate_solid_background(output_path: str):
    """Generate a simple solid-colour background as last resort."""
    colours = [
        (220, 220, 220),  # light grey
        (200, 210, 220),  # light blue-grey
        (230, 220, 210),  # warm grey
        (210, 230, 210),  # light green-grey
    ]
    colour = random.choice(colours)
    img = Image.new("RGB", (640, 640), colour)
    img.save(output_path)


def main():
    parser = argparse.ArgumentParser(description="SDXL Background Generator for Nigerian market scenes")
    parser.add_argument("--output-dir", default="./backgrounds", help="Output directory for background images")
    parser.add_argument("--count", type=int, default=50, help="Number of background images to generate")
    parser.add_argument("--style", default="nigerian_market",
                        choices=["nigerian_market", "supermarket", "kiosk", "open_market"],
                        help="Scene style")
    parser.add_argument("--method", default="auto",
                        choices=["auto", "a1111", "ollama", "unsplash", "solid"],
                        help="Generation method")
    args = parser.parse_args()

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    print(f"[INFO] Generating {args.count} background images → {out}")
    print(f"[INFO] Method: {args.method}")

    for i in range(args.count):
        prompt = random.choice(NIGERIAN_MARKET_PROMPTS)
        output_path = str(out / f"bg_{i:04d}.jpg")
        success = False

        if args.method in ("auto", "a1111"):
            success = generate_via_automatic1111(prompt, output_path)

        if not success and args.method in ("auto", "ollama"):
            success = generate_via_ollama_sdxl(prompt, output_path)

        if not success and args.method in ("auto", "unsplash"):
            query = "supermarket shelf products" if args.style == "supermarket" else "market store shelf"
            success = download_unsplash_background(output_path, query)
            if success:
                time.sleep(0.5)  # Rate limit Unsplash

        if not success:
            generate_solid_background(output_path)
            success = True

        if (i + 1) % 10 == 0:
            print(f"  Generated {i+1}/{args.count} backgrounds")

    print(f"[DONE] {args.count} backgrounds saved to {out}")
    print(f"Next step: python cutpaste_augmentor.py --backgrounds-dir {out}")


if __name__ == "__main__":
    main()
