# Platform server image for the E2E stack (build context = repo root).
#
# Runs the TypeScript server directly with tsx (a repo devDependency — no new
# runtime deps) in NODE_ENV=test: the client bundle is not built and API-only
# tests don't need it. On boot the container applies drizzle migrations to the
# fresh test database before accepting traffic — this is also the regression
# harness for fresh-DB migration bugs (e.g. drizzle/0022 missing USING casts).

FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

WORKDIR /app

# The repo has no root .dockerignore, so a stray host node_modules/ could leak
# into the context — remove it before installing to guarantee the image's
# dependency tree comes from the lockfile alone.
COPY . .
RUN rm -rf node_modules && pnpm install --frozen-lockfile

ENV NODE_ENV=test \
    PORT=3000

EXPOSE 3000

# Migrate, then serve. drizzle.config.ts reads POSTGRES_URL || DATABASE_URL.
CMD ["sh", "-c", "pnpm exec drizzle-kit migrate && pnpm exec tsx server/_core/index.ts"]
