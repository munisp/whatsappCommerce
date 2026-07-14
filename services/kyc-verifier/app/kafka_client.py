"""Async Kafka producer for KYC events."""
import json
import structlog
from typing import Any

log = structlog.get_logger()

class KafkaEventClient:
    def __init__(self, brokers: str, topic: str):
        self.brokers = brokers
        self.topic = topic
        self._producer = None
        self._mock = False

    async def start(self):
        try:
            from aiokafka import AIOKafkaProducer
            self._producer = AIOKafkaProducer(
                bootstrap_servers=self.brokers,
                value_serializer=lambda v: json.dumps(v).encode(),
            )
            await self._producer.start()
            log.info("kafka.producer.started", brokers=self.brokers)
        except Exception as e:
            log.warning("kafka.unavailable", error=str(e), fallback="mock_mode")
            self._mock = True

    async def stop(self):
        if self._producer:
            await self._producer.stop()

    async def publish(self, event_type: str, payload: dict[str, Any]):
        message = {"event_type": event_type, "payload": payload}
        if self._mock:
            log.info("kafka.mock.publish", event_type=event_type)
            return
        try:
            await self._producer.send_and_wait(self.topic, message)
        except Exception as e:
            log.error("kafka.publish_error", error=str(e), event_type=event_type)

