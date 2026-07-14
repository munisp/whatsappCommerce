"""Redis-backed conversation memory with sliding window and summary compression."""
import json
import redis.asyncio as aioredis
import structlog
from typing import Any, Optional
from dataclasses import dataclass, field, asdict
from datetime import datetime

log = structlog.get_logger()


@dataclass
class Message:
    role: str  # "user" | "assistant" | "tool"
    content: str
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    metadata: dict = field(default_factory=dict)


@dataclass
class ConversationContext:
    conversation_id: str
    tenant_id: str
    customer_id: str
    messages: list[Message] = field(default_factory=list)
    cart_id: Optional[str] = None
    current_intent: Optional[str] = None
    flow_step: str = "greeting"
    session_data: dict = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())


class ConversationMemory:
    """Redis-backed sliding window memory for multi-turn conversations."""

    MAX_MESSAGES = 20  # Keep last 20 messages in context window

    def __init__(self, redis_url: str, ttl_seconds: int = 3600):
        self.redis_url = redis_url
        self.ttl = ttl_seconds
        self._redis: Optional[aioredis.Redis] = None

    async def _get_redis(self) -> aioredis.Redis:
        if self._redis is None:
            self._redis = await aioredis.from_url(self.redis_url, decode_responses=True)
        return self._redis

    def _key(self, tenant_id: str, conversation_id: str) -> str:
        return f"conv:{tenant_id}:{conversation_id}"

    async def get_context(self, tenant_id: str, conversation_id: str, customer_id: str) -> ConversationContext:
        """Load conversation context from Redis, creating if not exists."""
        r = await self._get_redis()
        key = self._key(tenant_id, conversation_id)
        raw = await r.get(key)
        if raw:
            try:
                data = json.loads(raw)
                ctx = ConversationContext(
                    conversation_id=data["conversation_id"],
                    tenant_id=data["tenant_id"],
                    customer_id=data["customer_id"],
                    messages=[Message(**m) for m in data.get("messages", [])],
                    cart_id=data.get("cart_id"),
                    current_intent=data.get("current_intent"),
                    flow_step=data.get("flow_step", "greeting"),
                    session_data=data.get("session_data", {}),
                    created_at=data.get("created_at", datetime.utcnow().isoformat()),
                    updated_at=data.get("updated_at", datetime.utcnow().isoformat()),
                )
                return ctx
            except Exception as e:
                log.warning("context_deserialize_failed", error=str(e))

        # Create new context
        return ConversationContext(
            conversation_id=conversation_id,
            tenant_id=tenant_id,
            customer_id=customer_id,
        )

    async def save_context(self, ctx: ConversationContext) -> None:
        """Persist conversation context to Redis with TTL."""
        r = await self._get_redis()
        key = self._key(ctx.tenant_id, ctx.conversation_id)
        ctx.updated_at = datetime.utcnow().isoformat()
        # Trim to sliding window
        ctx.messages = ctx.messages[-self.MAX_MESSAGES:]
        data = {
            "conversation_id": ctx.conversation_id,
            "tenant_id": ctx.tenant_id,
            "customer_id": ctx.customer_id,
            "messages": [asdict(m) for m in ctx.messages],
            "cart_id": ctx.cart_id,
            "current_intent": ctx.current_intent,
            "flow_step": ctx.flow_step,
            "session_data": ctx.session_data,
            "created_at": ctx.created_at,
            "updated_at": ctx.updated_at,
        }
        await r.setex(key, self.ttl, json.dumps(data))

    async def append_message(self, tenant_id: str, conversation_id: str, customer_id: str, role: str, content: str, metadata: dict = None) -> None:
        """Append a message to the conversation history."""
        ctx = await self.get_context(tenant_id, conversation_id, customer_id)
        ctx.messages.append(Message(role=role, content=content, metadata=metadata or {}))
        await self.save_context(ctx)

    async def clear_context(self, tenant_id: str, conversation_id: str) -> None:
        r = await self._get_redis()
        await r.delete(self._key(tenant_id, conversation_id))

