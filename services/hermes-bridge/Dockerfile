# Builder: Debian-based Go image. W45: the consumer uses segmentio/kafka-go
# (pure Go, no CGO/librdkafka) — CGO_ENABLED=0 would work, but the glibc
# runtime is kept to avoid churn in the base images.
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

# Runtime: glibc base matching the builder
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /hermes-bridge .
EXPOSE 8096
CMD ["./hermes-bridge"]
