# ML Inference Stack — CPU-only FastAPI service
# Serves fraud/credit/NLP models (PyTorch CPU / ONNX Runtime) on port 8099.
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MODEL_DIR=/app/models \
    DATA_DIR=/app/data \
    PORT=8099

WORKDIR /app

# ─── Dependencies ────────────────────────────────────────────────────────────
COPY requirements.txt ./
# CPU wheels for torch come from the PyTorch CPU index (no CUDA packages).
RUN pip install --no-cache-dir -r requirements.txt \
        --extra-index-url https://download.pytorch.org/whl/cpu

# ─── Application code ────────────────────────────────────────────────────────
# inference/  — FastAPI server (inference.server:app) + CLI predictor
# lakehouse/  — lakehouse pipeline triggered via /lakehouse/trigger
# models/     — model architectures + weights (training model-loading support)
COPY inference/ ./inference/
COPY lakehouse/ ./lakehouse/
COPY models/ ./models/

# Runtime dirs for model weights and pipeline artifacts
RUN mkdir -p /app/models/weights /app/data

EXPOSE 8099

# Number of uvicorn worker processes (CPU-bound torch inference benefits from
# one worker per core up to the container CPU limit). Default: 1.
ENV UVICORN_WORKERS=1

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://localhost:8099/health').status==200 else 1)"

# Shell form so UVICORN_WORKERS expands at container start.
CMD ["sh", "-c", "exec uvicorn inference.server:app --host 0.0.0.0 --port 8099 --workers ${UVICORN_WORKERS:-1}"]
