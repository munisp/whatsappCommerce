FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod .
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o orchestrator ./cmd/server/

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/orchestrator .
EXPOSE 8080
CMD ["./orchestrator"]

