FROM python:3.12-slim

WORKDIR /service

# System deps for OpenCV + PIL
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libsm6 libxext6 libxrender-dev libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download YOLO model weights
RUN python -c "from ultralytics import YOLO; YOLO('yolo11n.pt')" || true

COPY app/ ./app/

EXPOSE 8081

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8081", "--workers", "2"]
*** Add File: /home/ubuntu/whatsapp-commerce/services/visual-inventory/python-vlm/README.md
# Visual Inventory — Python VLM Service

## Overview
FastAPI microservice combining **YOLO11** (object detection) with **Ollama VLM** (semantic counting) for AI-powered visual inventory from mobile camera photos.

## Supported VLM Models (via Ollama)
| Model | Size | Best For |
|-------|------|----------|
| `qwen2.5vl:7b` | 7B | Best accuracy, structured JSON output |
| `qwen2.5vl:3b` | 3B | Fast, good accuracy |
| `minicpm-v:8b` | 8B | Strong vision, multilingual |
| `gemma3:12b` | 12B | Best reasoning, slower |
| `gemma3:4b` | 4B | Balanced speed/accuracy |
| `llava:7b` | 7B | Fallback |

## Architecture
```
Mobile Camera Photo
       │
       ▼
Go Orchestrator (auth, resize, S3 upload)
       │
       ▼
Python VLM Service
  ├── YOLO11 (bounding boxes, fast counts)
  ├── Ollama VLM (semantic labels, contextual counts)
  └── Rust BBox Post-Processor (NMS, dedup)
       │
       ▼
Merged Inventory Report → TypeScript tRPC → PostgreSQL
```

## Ollama Setup
```bash
# Pull preferred models
ollama pull qwen2.5vl:7b    # Best choice
ollama pull minicpm-v:8b    # Alternative
ollama pull gemma3:4b       # Lightweight

# Run Ollama server
ollama serve
```

## Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama server URL |
| `YOLO_MODEL` | `yolo11n.pt` | YOLO model (n=nano, s=small, m=medium) |
| `YOLO_CONF_THRESHOLD` | `0.35` | Detection confidence threshold |
| `RUST_BBOX_URL` | `http://rust-bbox:8082` | Rust post-processor URL |
| `MAX_IMAGE_DIMENSION` | `1024` | Max image size for VLM |

## API Endpoints
- `POST /analyse` — Single image analysis
- `POST /analyse/batch` — Multi-image aggregation
- `GET /models` — List available Ollama models
- `GET /health` — Health check

