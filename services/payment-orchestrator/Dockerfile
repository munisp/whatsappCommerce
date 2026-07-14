FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /payment-orchestrator ./cmd/main.go

FROM gcr.io/distroless/static-debian12
COPY --from=builder /payment-orchestrator /payment-orchestrator
EXPOSE 8084
ENTRYPOINT ["/payment-orchestrator"]

