# Temporal worker for the WhatsApp Commerce platform.
# Lean on purpose: runtime deps only (the SDK + tsx), NOT the app's node_modules or build output.
#
#   docker build --platform linux/amd64 -f services/temporal-workflows/Dockerfile \
#     -t registry.digitalocean.com/talentgraph-auth/whatsapp-temporal-worker:<tag> .
#
# Versions are pinned to the repo's @temporalio/client so client and worker never drift.
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOME=/tmp
WORKDIR /app

# --ignore-scripts: @temporalio/core-bridge ships prebuilt binaries for every platform in the package.
RUN npm install --no-save --no-audit --no-fund --ignore-scripts \
      @temporalio/worker@1.22.0 \
      @temporalio/workflow@1.22.0 \
      @temporalio/activity@1.22.0 \
      @temporalio/common@1.22.0 \
      tsx@4.23.11 \
 && npm cache clean --force \
 && rm -rf /tmp/.npm /root/.npm \
 # This image is linux/amd64 only: drop the other platforms' prebuilt native bridges (~117 MB).
 && find node_modules/@temporalio/core-bridge/releases -mindepth 1 -maxdepth 1 ! -name x86_64-unknown-linux-gnu -exec rm -rf {} +

COPY services/temporal-workflows ./services/temporal-workflows

USER node
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "services/temporal-workflows/worker.ts"]
