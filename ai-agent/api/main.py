"""FastAPI server for the AI Agent layer.

Exposes:
  POST /intent      — Intent classification + response generation
  POST /recommend   — Product recommendations
  POST /handoff-summary — Generate handoff summary for human agents
  GET  /health      — Health check
"""
import asyncio
import structlog
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

# Import our modules
import sys
sys.path.insert(0, "/home/ubuntu/whatsapp-commerce-platform/ai-agent")

from config import get_config
from agents.orchestrator import AIOrchestrator, AgentInput
from tools.commerce_tools import CommerceTools
from memory.conversation_memory import ConversationMemory
from guardrails.guardrails import Guardrails

log = structlog.get_logger()

# ─── Request/Response Models ──────────────────────────────────────────────────

class IntentRequest(BaseModel):
    tenant_id: str = Field(..., description="Tenant UUID")
    conversation_id: str = Field(..., description="Conversation UUID")
    customer_id: str = Field(..., description="Customer UUID")
    message: str = Field(..., description="User message text")
    flow_step: str = Field("greeting", description="Current conversation flow step")


class IntentResponse(BaseModel):
    intent_type: str
    confidence: float
    reply: str
    next_action: str
    escalate: bool = False
    escalation_reason: Optional[str] = None
    entities: dict = {}
    flow_step: str = "greeting"


class RecommendRequest(BaseModel):
    tenant_id: str
    customer_id: str
    context: str = Field("", description="Conversation context for recommendations")
    limit: int = Field(5, ge=1, le=20)


class HandoffSummaryRequest(BaseModel):
    tenant_id: str
    conversation_id: str
    customer_id: str


# ─── App Lifecycle ────────────────────────────────────────────────────────────

_orchestrators: dict[str, AIOrchestrator] = {}
_memory: Optional[ConversationMemory] = None
_guardrails: Optional[Guardrails] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _memory, _guardrails
    cfg = get_config()
    _memory = ConversationMemory(cfg.redis_url, cfg.memory_ttl_seconds)
    _guardrails = Guardrails(cfg.sentiment_escalation_threshold)
    log.info("ai_agent_started", port=cfg.port, llm_provider=cfg.llm_provider, model=cfg.llm_model)
    yield
    log.info("ai_agent_shutdown")


def get_orchestrator(tenant_id: str) -> AIOrchestrator:
    """Get or create a tenant-scoped orchestrator."""
    if tenant_id not in _orchestrators:
        cfg = get_config()
        commerce = CommerceTools(cfg.commerce_engine_url, tenant_id)
        _orchestrators[tenant_id] = AIOrchestrator(cfg, commerce, _memory, _guardrails)
    return _orchestrators[tenant_id]


# ─── FastAPI App ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="WhatsApp Commerce AI Agent",
    description="LangGraph-powered conversational commerce AI agent",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "ai-agent", "version": "1.0.0"}


@app.post("/intent", response_model=IntentResponse)
async def classify_intent(req: IntentRequest):
    """Classify user intent and generate a conversational reply."""
    try:
        orch = get_orchestrator(req.tenant_id)
        inp = AgentInput(
            tenant_id=req.tenant_id,
            conversation_id=req.conversation_id,
            customer_id=req.customer_id,
            message=req.message,
            flow_step=req.flow_step,
        )
        result = await orch.process(inp)
        return IntentResponse(
            intent_type=result.intent_type,
            confidence=result.confidence,
            reply=result.reply,
            next_action=result.next_action,
            escalate=result.escalate,
            escalation_reason=result.escalation_reason,
            entities=result.entities,
            flow_step=result.flow_step,
        )
    except Exception as e:
        log.error("intent_endpoint_error", error=str(e), tenant_id=req.tenant_id)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/recommend")
async def recommend_products(req: RecommendRequest):
    """Generate product recommendations based on conversation context."""
    try:
        cfg = get_config()
        commerce = CommerceTools(cfg.commerce_engine_url, req.tenant_id)
        results = await commerce.search_products(req.context or "popular products", limit=req.limit)
        return {"tenant_id": req.tenant_id, "recommendations": results.get("products", []), "count": results.get("count", 0)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/handoff-summary")
async def generate_handoff_summary(req: HandoffSummaryRequest):
    """Generate a structured handoff summary for human agents."""
    try:
        ctx = await _memory.get_context(req.tenant_id, req.conversation_id, req.customer_id)
        recent_messages = ctx.messages[-10:]
        summary_lines = [f"Conversation ID: {req.conversation_id}", f"Customer ID: {req.customer_id}", ""]
        if recent_messages:
            summary_lines.append("Recent conversation:")
            for msg in recent_messages:
                role = "Customer" if msg.role == "user" else "Bot"
                summary_lines.append(f"  [{role}]: {msg.content[:100]}")
        if ctx.cart_id:
            summary_lines.append(f"\nActive cart: {ctx.cart_id}")
        if ctx.current_intent:
            summary_lines.append(f"Last intent: {ctx.current_intent}")
        return {
            "conversation_id": req.conversation_id,
            "summary": "\n".join(summary_lines),
            "cart_id": ctx.cart_id,
            "last_intent": ctx.current_intent,
            "flow_step": ctx.flow_step,
            "message_count": len(ctx.messages),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    cfg = get_config()
    uvicorn.run("main:app", host="0.0.0.0", port=cfg.port, reload=(cfg.env == "development"), log_level="info")

