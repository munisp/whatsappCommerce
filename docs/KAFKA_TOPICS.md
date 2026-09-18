# Kafka Topics — Pre-Provisioning List (W46 PLT-24)

Auto-topic-creation is **disabled** on BOTH producers as of W46
(`server/kafka.ts` KafkaJS producer: `allowAutoTopicCreation: false,
idempotent: true`; `services/webhook-ingestor` kafka-go writer:
`AllowAutoTopicCreation: false`). Brokers with
`auto.create.topics.enable=true` would previously materialize stray topics
with `replication.factor=1` on any typo — every topic below must be
**pre-provisioned** before deploy.

## Platform topics (KafkaJS producer — `server/kafka.ts`)

| Topic                    | Purpose                          | Producer            | Consumer(s)                          |
|--------------------------|----------------------------------|---------------------|--------------------------------------|
| `wacommerce.orders`      | new order events                 | server (KafkaJS)    | webhook-ingestor / message-processor |
| `wacommerce.payments`    | payment state transitions        | server (KafkaJS)    | message-processor                    |
| `wacommerce.conversations` | conversation lifecycle events  | server (KafkaJS)    | message-processor                    |
| `wacommerce.inventory`   | stock change events              | server (KafkaJS)    | message-processor                    |
| `wacommerce.hermes.po`   | Hermes PO draft events           | server (KafkaJS)    | hermes-bridge                        |

## Ingestor / processor topics

| Topic                    | Purpose                          | Producer            | Consumer(s)         |
|--------------------------|----------------------------------|---------------------|---------------------|
| `webhooks.inbound`       | raw inbound payment/ERP webhooks | webhook-ingestor (kafka-go) | message-processor |
| `mp.dlq.events`          | message-processor dead letters   | message-processor (rdkafka) | ops replay tooling  |

(The W45 message-processor consumer reads the env-driven `MP_KAFKA_TOPICS`
list and dead-letters to `MP_DLQ_TOPIC`, default `mp.dlq.events` — those
topics must exist before the consumer starts.)

## Provisioning (example)

```bash
for t in wacommerce.orders wacommerce.payments wacommerce.conversations \
         wacommerce.inventory wacommerce.hermes.po webhooks.inbound mp.dlq.events; do
  kafka-topics.sh --bootstrap-server "$KAFKA_BROKERS" --create --if-not-exists \
    --topic "$t" --partitions 6 --replication-factor 3 \
    --config retention.ms=604800000   # 7d
done
```

## Producer settings (both producers)

- `acks=all` / `RequiredAcks: RequireAll` (W42 PLT-6) — durable commits.
- Idempotence: KafkaJS `idempotent: true` (enable.idempotence semantics).
  kafka-go has no idempotent-producer knob — exactly-once there is
  RequireAll + sync writes + bounded `MaxAttempts` + the downstream
  `processed_webhook_events` dedupe ledger (documented in producer.go).
- `allowAutoTopicCreation: false` / `AllowAutoTopicCreation: false` (W46).
