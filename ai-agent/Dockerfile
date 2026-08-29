FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# === W34 otel-sidecars === env passthrough only (telemetry fail-open,
# disabled by default).
ENV OTEL_ENABLED=false
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
# === END W34 otel-sidecars ===
EXPOSE 8090
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "2"]

