# Builder: Debian-based Go image — confluent-kafka-go/v2 requires cgo (librdkafka),
# so CGO must stay enabled and musl/alpine cannot be used for the build.
FROM golang:1.23-bookworm AS builder
WORKDIR /app
# Root build context (docker-compose.yml's W35 comment): the go.mod
# `replace github.com/whatsapp-commerce/otelx => ../../shared/go/otelx`
# escapes a self-contained per-service context, so shared/go/otelx must be
# present in the build alongside this service's own source.
COPY shared/go/otelx ./shared/go/otelx
COPY services/hermes-bridge/go.mod services/hermes-bridge/go.sum ./services/hermes-bridge/
WORKDIR /app/services/hermes-bridge
RUN go mod download
COPY services/hermes-bridge/. .
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-w -s" -o /hermes-bridge .

# Runtime: glibc base matching the builder (confluent-kafka-go links librdkafka via cgo)
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /hermes-bridge .
EXPOSE 8096
CMD ["./hermes-bridge"]
