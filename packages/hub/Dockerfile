# =============================================================================
# Shepherd Hub — multi-stage Docker build
# Build context: repo root (required for npm workspaces)
#
# Usage (from repo root):
#   docker build -f packages/hub/Dockerfile -t shepherd-hub .
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: builder
# ---------------------------------------------------------------------------
FROM node:20-slim AS builder

WORKDIR /build

# Copy workspace manifests needed for `npm ci`.
# We copy all four package.jsons so the workspace install resolves cleanly —
# including ui's devDeps (Vite, React) needed to build its self-host SPA below.
# mcp-server sources are NOT copied so it cannot be built (that's intentional).
COPY package.json package-lock.json ./
COPY packages/shared/package.json  ./packages/shared/package.json
COPY packages/hub/package.json     ./packages/hub/package.json
COPY packages/mcp-server/package.json ./packages/mcp-server/package.json
COPY packages/ui/package.json      ./packages/ui/package.json

# Install all workspace dependencies (production + dev needed for tsc).
RUN npm ci

# Copy TypeScript configuration files.
COPY tsconfig.json tsconfig.base.json ./

# Copy only the packages we need to build.
COPY packages/shared/ ./packages/shared/
COPY packages/hub/    ./packages/hub/

# Build only shared and hub (root tsc -b also pulls in mcp-server which we
# do not copy here; use explicit package references instead).
# --force compiles from clean source unconditionally: a stale incremental
# *.tsbuildinfo must never let tsc no-op (it would skip emitting dist/, and
# the runtime stage copies dist/ — a no-op silently ships an empty image).
RUN npx tsc -b packages/shared packages/hub --force

# Build the UI self-host SPA the hub serves. Copied AFTER the tsc -b so the
# Docker layer cache for the hub build is not busted by UI source churn. Only
# the self-host bundle (dist/selfhost) is built here — the dist/lib output is
# for Phase 5 Korso consumers, not the hub image. The UI's lib build bundles
# @shepherd/shared, already compiled above.
COPY packages/ui/ ./packages/ui/
RUN npm -w @korso/shepherd-ui run build:app

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime

# Run as non-root for security.
RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home appuser

WORKDIR /app

# Copy compiled output for shared and hub.
COPY --from=builder /build/packages/shared/dist  ./packages/shared/dist
COPY --from=builder /build/packages/hub/dist     ./packages/hub/dist

# Copy SQL migration files (migrate.ts resolves them relative to dist/).
COPY --from=builder /build/packages/hub/migrations ./packages/hub/migrations

# Copy the wallboard static page — the @korso/shepherd-ui self-host SPA.
# server.ts resolves ../../ui/dist/selfhost/ (relative to packages/hub/dist/
# server.js) at import time and serves it via @fastify/static, so the server
# fails to boot without it — this copy is required, not optional.
COPY --from=builder /build/packages/ui/dist/selfhost ./packages/ui/dist/selfhost

# Copy package manifests for runtime module resolution.
# The ui manifest is needed so the @korso/shepherd-ui workspace symlink in
# node_modules resolves to a real package dir (its dist/selfhost is above).
COPY --from=builder /build/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /build/packages/hub/package.json    ./packages/hub/package.json
COPY --from=builder /build/packages/ui/package.json     ./packages/ui/package.json
COPY --from=builder /build/package.json                 ./package.json

# The mcp-server manifest is how the hub knows which client version to
# advertise on join (clientVersion.ts resolves ../../mcp-server/package.json
# relative to packages/hub/dist/). Fail-open if absent — but keep it present.
COPY --from=builder /build/packages/mcp-server/package.json ./packages/mcp-server/package.json

# Copy production node_modules from the builder stage.
# The workspace symlinks inside node_modules point to packages/* which we
# copy above, so resolution works correctly.
COPY --from=builder /build/node_modules ./node_modules

USER appuser

EXPOSE 8080

# Cloud Run injects PORT at runtime; map it to HUB_PORT (which config.ts reads).
# If PORT is absent (local run without -e PORT), HUB_PORT falls back to 8080
# via the Zod default in config.ts.
# Migrations run automatically on boot via index.ts → runMigrations().
CMD ["sh", "-c", "HUB_PORT=${PORT:-8080} node packages/hub/dist/index.js"]
