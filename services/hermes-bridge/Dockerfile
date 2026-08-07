# Builder: Debian-based Go image — confluent-kafka-go/v2 requires cgo (librdkafka),
# so CGO must stay enabled and musl/alpine cannot be used for the build.
FROM golang:1.23-bookworm AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-w -s" -o hermes-bridge .

# Runtime: glibc base matching the builder (confluent-kafka-go links librdkafka via cgo)
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/hermes-bridge .
EXPOSE 8096
CMD ["./hermes-bridge"]
