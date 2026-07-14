"""Centralised configuration for the AI Agent layer."""
import os
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Config:
    # Server
    port: int = int(os.getenv("PORT", "8090"))
    env: str = os.getenv("ENV", "development")

    # LLM
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")
    llm_provider: str = os.getenv("LLM_PROVIDER", "openai")  # openai | anthropic | ollama
    llm_model: str = os.getenv("LLM_MODEL", "gpt-4o-mini")
    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

    # Redis (conversation memory)
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379")
    memory_ttl_seconds: int = int(os.getenv("MEMORY_TTL_SECONDS", "3600"))

    # Downstream services
    commerce_engine_url: str = os.getenv("COMMERCE_ENGINE_URL", "http://localhost:8083")
    payment_orchestrator_url: str = os.getenv("PAYMENT_ORCHESTRATOR_URL", "http://localhost:8084")
    conversation_orchestrator_url: str = os.getenv("CONVERSATION_ORCHESTRATOR_URL", "http://localhost:8082")

    # Guardrails
    max_tokens_per_turn: int = int(os.getenv("MAX_TOKENS_PER_TURN", "1500"))
    confidence_threshold: float = float(os.getenv("CONFIDENCE_THRESHOLD", "0.4"))
    sentiment_escalation_threshold: float = float(os.getenv("SENTIMENT_ESCALATION_THRESHOLD", "0.2"))
    max_tool_calls_per_turn: int = int(os.getenv("MAX_TOOL_CALLS_PER_TURN", "5"))


_config: Optional[Config] = None


def get_config() -> Config:
    global _config
    if _config is None:
        _config = Config()
    return _config

