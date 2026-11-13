# paddlepaddle 2.6.x publishes no Python 3.14 wheels; bookworm still ships libgl1-mesa-glx.
FROM python:3.12-slim-bookworm

# System deps for PaddleOCR, OpenCV, MediaPipe
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libsm6 libxext6 libxrender-dev libgomp1 \
    libgl1-mesa-glx poppler-utils libpoppler-cpp-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# PaddleOCR's models (detection, recognition, angle) are baked in: fetched at runtime they came slowly from a CDN
# abroad, again after every restart, and a check waited on them. HOME points here at runtime too.
ENV HOME=/opt/verifier
RUN mkdir -p /opt/verifier && python -c "import cv2; from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=True, lang='en', use_gpu=False, show_log=False, enable_mkldnn=False)" \
    && ls /opt/verifier/.paddleocr/whl/*/en* >/dev/null && chmod -R a+rX /opt/verifier

# W30 (V3#2): the image must NOT bake in mock mode — real document vision is
# the default. Dev/test enables the mock via an explicit compose override
# (VLM_MOCK_MODE=true on the kyc-verifier service in docker-compose.yml).
ENV VLM_MOCK_MODE=false
ENV PORT=8001
# === W34 otel-sidecars === env passthrough only (telemetry fail-open,
# disabled by default).
ENV OTEL_ENABLED=false
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
# === END W34 otel-sidecars ===

EXPOSE 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "2"]

