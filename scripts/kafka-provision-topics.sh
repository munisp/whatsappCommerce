#!/usr/bin/env bash
# === W48 sidecars (PERF-SC-30) ===
# Pre-provisions every platform Kafka topic from docs/KAFKA_TOPICS.md and
# asserts the broker contract (auto.create.topics.enable=false). Run at
# deploy time or in CI against a fresh broker:
#   KAFKA_BROKERS=kafka:9092 ./scripts/kafka-provision-topics.sh
set -euo pipefail

KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}"
PARTITIONS="${KAFKA_TOPIC_PARTITIONS:-6}"
RF="${KAFKA_TOPIC_REPLICATION_FACTOR:-1}" # 3 in prod; 1 for single-broker dev
RETENTION_MS="${KAFKA_TOPIC_RETENTION_MS:-604800000}" # 7d

TOPICS=(
  wacommerce.orders
  wacommerce.payments
  wacommerce.conversations
  wacommerce.inventory
  wacommerce.hermes.po
  webhooks.inbound
  mp.dlq.events
  # W45/W48 consumers:
  wa.message.received
  wa.message.status
  kyc.events
  orders.created
  inventory.sync
  notifications.dispatch
  notifications.dlq
  hermes.events.inbound
  hermes.events.dlq
  chat.message.received.v1
  payment.mojaloop.callback.received.v1
  crm.twenty.event.received.v1
  erp.odoo.event.received.v1
)

echo "Provisioning ${#TOPICS[@]} topics on ${KAFKA_BROKERS} (partitions=${PARTITIONS}, rf=${RF})"
for t in "${TOPICS[@]}"; do
  kafka-topics.sh --bootstrap-server "$KAFKA_BROKERS" --create --if-not-exists \
    --topic "$t" --partitions "$PARTITIONS" --replication-factor "$RF" \
    --config "retention.ms=${RETENTION_MS}"
done

# Contract assertion: auto-creation must be disabled (PLT-24).
AUTO=$(kafka-configs.sh --bootstrap-server "$KAFKA_BROKERS" --entity-type brokers \
  --entity-default --describe 2>/dev/null | grep -o 'auto.create.topics.enable=[a-z]*' | head -1 || true)
echo "broker auto.create.topics: ${AUTO:-unknown}"
if [[ "$AUTO" == *"=true" ]]; then
  echo "ERROR: auto.create.topics.enable=true violates the PLT-24 contract" >&2
  exit 1
fi
echo "OK — topics provisioned, auto-creation disabled"
