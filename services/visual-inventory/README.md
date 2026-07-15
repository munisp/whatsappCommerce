# Visual Inventory — Polyglot AI Stack

> AI-powered inventory counting from mobile camera photos using Ollama VLMs + YOLO11.

## Architecture

```
Mobile Camera (browser/PWA)
         │  JPEG/PNG photo
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  TypeScript tRPC Backend (Node.js)                              │
│  • Receives upload, writes session to PostgreSQL                │
│  • Forwards to Go Orchestrator                                  │
│  • Receives result, updates inventory table                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ multipart/form-data
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Go Orchestrator  (port 8080)                                   │
│  Language: Go 1.23                                              │
│  • EXIF rotation correction                                     │
│  • Resize to max 1920px (nearest-neighbour, fast)               │
│  • Format validation (JPEG/PNG/GIF only)                        │
│  • Per-tenant rate limiting (token bucket, 10 req/min)          │
│  • Upload original to S3 (audit trail)                          │
│  • Forward preprocessed image to Python VLM                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                    ┌──────┴──────┐
                    │             │ (parallel)
                    ▼             ▼
┌───────────────────────┐  ┌─────────────────────────────────────┐
│  YOLO11 (Ultralytics) │  │  Ollama VLM                         │
│  Language: Python     │  │  Language: Python (client)          │
│  • Object detection   │  │  Models (priority order):           │
│  • Bounding boxes     │  │    1. qwen2.5vl:7b  (best)          │
│  • Class labels       │  │    2. qwen2.5vl:3b  (fast)          │
│  • Per-class counts   │  │    3. minicpm-v:8b  (multilingual)  │
└──────────┬────────────┘  │    4. gemma3:12b    (reasoning)     │
           │               │    5. gemma3:4b     (lightweight)   │
           │               │    6. llava:7b      (fallback)      │
           │               │  • Semantic product names           │
           │               │  • Contextual counts                │
           │               │  • Structured JSON output           │
           │               └──────────────┬──────────────────────┘
           │                              │
           ▼                              │
┌─────────────────────────────────────────────────────────────────┐
│  Rust BBox Post-Processor  (port 8082)                          │
│  Language: Rust 1.82                                            │
│  • Non-Maximum Suppression (NMS) — removes duplicate boxes      │
│  • Edge-proximity confidence re-scoring                         │
│  • Spatial clustering (shelf row grouping)                      │
│  • Zero-copy numerical processing, no GC pauses                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │ cleaned detections
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Python VLM Service  (port 8081)                                │
│  • Merges YOLO + VLM results                                    │
│  • Takes max(YOLO count, VLM count) per item                    │
│  • Boosts confidence when both systems agree                    │
│  • Returns unified InventoryAnalysisResponse                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
         TypeScript tRPC → PostgreSQL (visual_inventory_sessions)
                           │
                           ▼
         Operator reviews & applies to inventory table
```

## Quick Start

```bash
# 1. Start the stack
cd services/visual-inventory
docker compose up -d

# 2. Pull models (auto-pulled on first start, or manually)
docker exec visual-inventory-ollama ollama pull qwen2.5vl:3b
docker exec visual-inventory-ollama ollama pull minicpm-v:latest
docker exec visual-inventory-ollama ollama pull gemma3:4b

# 3. Test with a shelf photo
curl -X POST http://localhost:8080/analyse \
  -F "image=@shelf.jpg" \
  -F "session_id=test-001" \
  -F "product_hints=Coca-Cola,Pepsi,water bottles"
```

## Model Selection Guide

| Scenario | Recommended Model | Why |
|----------|------------------|-----|
| General retail shelf | `qwen2.5vl:7b` | Best structured JSON + counting |
| Low-end hardware | `qwen2.5vl:3b` or `gemma3:4b` | Fits in 4GB VRAM |
| African market products | `minicpm-v:8b` | Strong multilingual OCR |
| Complex scenes | `gemma3:12b` | Best reasoning |
| CPU-only | `gemma3:4b` | Reasonable speed on CPU |

## Environment Variables

| Service | Variable | Default | Description |
|---------|----------|---------|-------------|
| python-vlm | `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama server |
| python-vlm | `YOLO_MODEL` | `yolo11n.pt` | YOLO model size |
| python-vlm | `YOLO_CONF_THRESHOLD` | `0.35` | Detection threshold |
| python-vlm | `RUST_BBOX_URL` | `http://rust-bbox:8082` | Rust sidecar |
| go-orchestrator | `PYTHON_VLM_URL` | `http://python-vlm:8081` | VLM service |
| rust-bbox | `RUST_LOG` | `info` | Log level |

## Adding Custom Products (Product Hints)

Pass known product names as hints to improve VLM accuracy:
```json
{
  "product_hints": "Indomie noodles, Peak milk, Milo tin, Sprite bottle"
}
```
The VLM will attempt to match detected items to these names.

