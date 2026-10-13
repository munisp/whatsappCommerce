FROM rust:1.90-slim AS builder
# cmake/g++/make/zlib1g-dev: rdkafka's "cmake-build" feature vendors and
# compiles librdkafka from source at build time (same approach as
# services/message-processor) instead of depending on whatever
# librdkafka-dev version this base image's apt repo happens to carry.
RUN apt-get update && apt-get install -y libssl-dev pkg-config cmake g++ make zlib1g-dev libcurl4-openssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:trixie-slim
# Must match the builder's Debian release (rust:1.90-slim is Debian 13/trixie)
# -- bookworm-slim (Debian 12) shipped an older glibc than this binary was
# linked against, so the previous runtime stage failed at startup with
# "GLIBC_2.38' not found", every time, for any image built from this file.
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/event-processor /event-processor
ENTRYPOINT ["/event-processor"]

