"""Redis-backed conversation memory with sliding window and summary compression.

=== W48 sidecars (PERF-SC-24) === storage layout changed from one JSON blob
per conversation (append = full GET + SETEX of the whole history — 5+ RTTs per
turn and a lost-update race for concurrent messages) to Redis-native
structures:
  conv:{tenant}:{conv}:msgs — LIST of message JSON docs (RPUSH + LTRIM keeps
                              the sliding window; EXPIRE applies the TTL)
  conv:{tenant}:{conv}:meta — HASH of context fields
append_message is now ONE pipelined RTT and is race-free (RPUSH is atomic);
get_context is one pipelined RTT.
"""
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

    def _msgs_key(self, tenant_id: str, conversation_id: str) -> str:
        return f"conv:{tenant_id}:{conversation_id}:msgs"

    def _meta_key(self, tenant_id: str, conversation_id: str) -> str:
        return f"conv:{tenant_id}:{conversation_id}:meta"

    async def get_context(self, tenant_id: str, conversation_id: str, customer_id: str) -> ConversationContext:
        """Load conversation context from Redis (one pipelined RTT)."""
        r = await self._get_redis()
        msgs_key, meta_key = self._msgs_key(tenant_id, conversation_id), self._meta_key(tenant_id, conversation_id)
        pipe = r.pipeline()
        pipe.lrange(msgs_key, -self.MAX_MESSAGES, -1)
        pipe.hgetall(meta_key)
        raw_msgs, meta = await pipe.execute()

        messages: list[Message] = []
        for raw in raw_msgs or []:
            try:
                messages.append(Message(**json.loads(raw)))
            except Exception as e:
                log.warning("message_deserialize_failed", error=str(e))

        ctx = ConversationContext(
            conversation_id=conversation_id,
            tenant_id=tenant_id,
            customer_id=customer_id,
            messages=messages,
        )
        if meta:
            ctx.cart_id = meta.get("cart_id") or None
            ctx.current_intent = meta.get("current_intent") or None
            ctx.flow_step = meta.get("flow_step", "greeting")
            ctx.created_at = meta.get("created_at", ctx.created_at)
            ctx.updated_at = meta.get("updated_at", ctx.updated_at)
            try:
                ctx.session_data = json.loads(meta.get("session_data", "{}"))
            except Exception:
                ctx.session_data = {}
        return ctx

    async def save_context(self, ctx: ConversationContext) -> None:
        """Persist conversation metadata (hash) with TTL — one pipelined RTT.

        Note: messages are NOT written here; they are appended atomically by
        append_message. ctx.messages mutations via this method are dropped by
        design (callers append via append_message).
        """
        r = await self._get_redis()
        meta_key = self._meta_key(ctx.tenant_id, ctx.conversation_id)
        ctx.updated_at = datetime.utcnow().isoformat()
        mapping = {
            "conversation_id": ctx.conversation_id,
            "tenant_id": ctx.tenant_id,
            "customer_id": ctx.customer_id,
            "cart_id": ctx.cart_id or "",
            "current_intent": ctx.current_intent or "",
            "flow_step": ctx.flow_step,
            "session_data": json.dumps(ctx.session_data),
            "created_at": ctx.created_at,
            "updated_at": ctx.updated_at,
        }
        pipe = r.pipeline()
        pipe.hset(meta_key, mapping=mapping)
        pipe.expire(meta_key, self.ttl)
        await pipe.execute()

    async def append_message(self, tenant_id: str, conversation_id: str, customer_id: str, role: str, content: str, metadata: dict = None) -> None:
        """Append a message — ONE pipelined RTT, atomic, race-free (PERF-SC-24)."""
        r = await self._get_redis()
        msgs_key = self._msgs_key(tenant_id, conversation_id)
        doc = json.dumps(asdict(Message(role=role, content=content, metadata=metadata or {})))
        pipe = r.pipeline()
        pipe.rpush(msgs_key, doc)
        pipe.ltrim(msgs_key, -self.MAX_MESSAGES, -1)
        pipe.expire(msgs_key, self.ttl)
        await pipe.execute()

    async def clear_context(self, tenant_id: str, conversation_id: str) -> None:
        r = await self._get_redis()
        await r.delete(self._msgs_key(tenant_id, conversation_id),
                       self._meta_key(tenant_id, conversation_id))
