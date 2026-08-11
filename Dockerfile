# ─── whatsappCommerce TypeScript platform (Express + tRPC) ───────────────────
# Multi-stage: full toolchain builds the Vite client + esbuild server bundle,
# then a slim non-root runtime image runs it with a 2GB V8 old-space cap.

# ─── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install deps first for layer caching (patched packages ship in ./patches).
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm install -g npm@latest && npm config set allow-remote all && npm ci --legacy-peer-deps --ignore-scripts

COPY . .

# Vite bakes VITE_* vars into the static bundle at build time — must be
# supplied as build args, not runtime env (kubectl set env can't reach these).
ARG VITE_KEYCLOAK_URL
ARG VITE_KEYCLOAK_REALM
ARG VITE_KEYCLOAK_CLIENT_ID
ENV VITE_KEYCLOAK_URL=${VITE_KEYCLOAK_URL} \
    VITE_KEYCLOAK_REALM=${VITE_KEYCLOAK_REALM} \
    VITE_KEYCLOAK_CLIENT_ID=${VITE_KEYCLOAK_CLIENT_ID}

RUN npm run build

# Prune to production deps for the runtime image.
RUN npm prune --omit=dev --legacy-peer-deps

# ─── Stage 2: slim runtime ───────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=2048"

WORKDIR /app

# Run as the pre-created non-root `node` user.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
