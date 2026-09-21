# TigerBeetle HTTP adapter (sidecar for rust/ledger-bridge). Build context: services/tb-adapter.
# tigerbeetle-node ships a prebuilt native addon for linux x86_64/aarch64 (glibc + musl); no toolchain needed.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs translate.mjs ./
USER node
EXPOSE 3000
# The image is a sidecar: HOST defaults to 127.0.0.1 inside server.mjs. Set HOST=0.0.0.0 only for compose.
CMD ["node", "server.mjs"]
