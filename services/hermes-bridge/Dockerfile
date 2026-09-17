# Builder: Debian-based Go image. W45: the consumer uses segmentio/kafka-go
# (pure Go, no CGO/librdkafka) — CGO_ENABLED=0 would work, but the glibc
# runtime is kept to avoid churn in the base images.
FROM golang:1.23-bookworm AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-w -s" -o hermes-bridge .

# Runtime: glibc base matching the builder
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/hermes-bridge .
EXPOSE 8096
CMD ["./hermes-bridge"]
