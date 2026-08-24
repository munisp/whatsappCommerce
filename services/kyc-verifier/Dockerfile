FROM python:3.14-slim

# System deps for PaddleOCR, OpenCV, MediaPipe
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libsm6 libxext6 libxrender-dev libgomp1 \
    libgl1-mesa-glx poppler-utils libpoppler-cpp-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# W30 (V3#2): the image must NOT bake in mock mode — real document vision is
# the default. Dev/test enables the mock via an explicit compose override
# (VLM_MOCK_MODE=true on the kyc-verifier service in docker-compose.yml).
ENV VLM_MOCK_MODE=false
ENV PORT=8001

EXPOSE 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "2"]

