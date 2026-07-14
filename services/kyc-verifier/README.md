# KYC/KYB Verification Service

A Python microservice providing document OCR, VLM analysis, liveness detection, and risk scoring for tenant onboarding.

## Tech Stack

| Component | Technology | Purpose |
|---|---|---|
| API | FastAPI | REST endpoints |
| OCR | PaddleOCR | Text extraction from ID documents |
| Document Parsing | Docling | Structured layout + table extraction |
| VLM Analysis | Ollama (llava) / GPT-4V | Authenticity, tampering, field extraction |
| Liveness | MediaPipe Face Mesh | Challenge-response anti-spoofing |
| Events | Kafka (aiokafka) | Publish verification events |
| Session Cache | Redis | Liveness session state |

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Service health |
| POST | `/verify/document` | Full document verification pipeline |
| POST | `/liveness/session` | Create liveness challenge session |
| POST | `/liveness/frame/{session_id}` | Submit a liveness frame |
| GET | `/liveness/session/{session_id}` | Get session status |

## Environment Variables

```env
KAFKA_BROKERS=localhost:9092
REDIS_URL=redis://localhost:6379/2
POSTGRES_URL=postgresql://...
KYC_INTERNAL_API_KEY=change-in-prod
OLLAMA_URL=http://localhost:11434
OLLAMA_VLM_MODEL=llava:13b
VLM_MOCK_MODE=true   # Set false in production with Ollama running
```

## Mock Mode

Set `VLM_MOCK_MODE=true` (default) to run without GPU/Ollama. All processors return realistic mock data for UI development and testing.

