FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
# sentence-transformers pulls in torch; without a CPU wheel index pip
# installs the default CUDA-bundled build (~6GB) on a CPU-only service -
# same fix as services/ml-stack/Dockerfile. Installed in its own layer
# (ahead of the rest of requirements.txt) so the resulting image layer
# stays small enough to push reliably - one combined layer here was
# ~1.7GB and consistently failed mid-upload through the local registry
# proxy; splitting keeps each layer well under that.
RUN pip install --no-cache-dir torch --extra-index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -r requirements.txt \
        --extra-index-url https://download.pytorch.org/whl/cpu
COPY . .
# === W34 otel-sidecars === env passthrough only (telemetry fail-open,
# disabled by default).
ENV OTEL_ENABLED=false
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
# === END W34 otel-sidecars ===
EXPOSE 8090
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "2"]
# CI pipeline test 2026-09-16: confirms build-and-push -> DO registry -> Flux image automation end to end

