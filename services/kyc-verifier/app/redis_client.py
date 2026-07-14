"""Async Redis client for liveness session state."""
import json
import structlog
from typing import Any, Optional

log = structlog.get_logger()

class RedisSessionClient:
    def __init__(self, url: str):
        self.url = url
        self._client = None
        self._mock_store: dict = {}
        self._mock = False

    async def connect(self):
        try:
            import redis.asyncio as aioredis
            self._client = aioredis.from_url(self.url, decode_responses=True)
            await self._client.ping()
            log.info("redis.connected", url=self.url)
        except Exception as e:
            log.warning("redis.unavailable", error=str(e), fallback="mock_mode")
            self._mock = True

    async def disconnect(self):
        if self._client:
            await self._client.aclose()

    async def set(self, key: str, value: dict, ttl: int = 300):
        if self._mock:
            self._mock_store[key] = value
            return
        await self._client.setex(key, ttl, json.dumps(value))

    async def get(self, key: str) -> Optional[dict]:
        if self._mock:
            return self._mock_store.get(key)
        raw = await self._client.get(key)
        return json.loads(raw) if raw else None

