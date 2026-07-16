module github.com/whatsapp-commerce/event-gateway

go 1.23

// Production dependencies (add with: go get)
// github.com/segmentio/kafka-go v0.4.47
// github.com/redis/go-redis/v9 v9.7.0
// go.temporal.io/sdk v1.30.0

require github.com/segmentio/kafka-go v0.4.47

require (
	github.com/klauspost/compress v1.15.9 // indirect
	github.com/pierrec/lz4/v4 v4.1.15 // indirect
)
