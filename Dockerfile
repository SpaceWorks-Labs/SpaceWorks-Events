# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# (The skipped check flags the NEXT_SERVER_ACTIONS_ENCRYPTION_KEY build-arg
# fallback in the builder stage; see the comment there for the tradeoff.)

# Stage 1: Install dependencies
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY frontend/package.json ./frontend/package.json
# `npm ci` runs the Prisma postinstall hook, which needs the schema available.
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci

# A small migration-only target, used by the staging Compose file. Releases
# migrate with the backend image's `migrate` role instead.
# scripts/prisma.mjs defaults DIRECT_URL to DATABASE_URL when it is unset.
FROM deps AS migrator
WORKDIR /app
COPY prisma ./prisma
COPY scripts/prisma.mjs ./scripts/prisma.mjs
CMD ["node", "scripts/prisma.mjs", "migrate", "deploy"]

# Prisma CLI only, so the runner can apply migrations on start
# (MIGRATE_ON_START=1) on platforms without a release job, such as the Render
# free plan. Kept apart from the app's node_modules and installed with `npm ci`
# from its own committed lockfile, so every transitive dependency is pinned
# too. tests/unit/docker-deps.test.ts keeps its version equal to the root
# lockfile's.
FROM node:22-alpine AS prisma-cli
WORKDIR /opt/prisma-cli
COPY docker/deps/prisma-cli/package.json docker/deps/prisma-cli/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Clients the VPS operator tools (docker/vps/*.mjs) import, installed with
# `npm ci` from their own committed lockfile (same direct versions as the root
# lockfile, checked by tests/unit/docker-deps.test.ts). The application
# bundles its own copies into its build.
FROM node:22-alpine AS ops-modules
WORKDIR /opt/ops
COPY docker/deps/ops/package.json docker/deps/ops/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Stage 2: Rebuild the source code
FROM node:22-alpine AS builder
WORKDIR /app
ARG NEXT_PUBLIC_BASE_URL
ENV NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL
# Fallback for builders without BuildKit secrets wired up. Render passes every
# service environment variable to `docker build` as a build arg of the same
# name, so the runtime key is reused for the build without extra setup. The
# value then exists in this builder stage's metadata and build cache, but not
# in the final runner image (a separate stage). Prefer the secret mount below
# wherever the builder supports it (local Docker, GitHub Actions, Compose).
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# This stage starts fresh; avoid writing a compiler cache that the runner never uses.
ENV SWE_DISABLE_BUILD_CACHE=1

RUN npx prisma generate
# The key is consumed by Next.js while compiling Server Actions. Every image
# replica must be built with one stable key and receive that same key at runtime.
# A BuildKit secret (`--secret id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,...`, or a
# Render secret file with that name) takes precedence over the build arg.
RUN --mount=type=secret,id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
    if [ -s /run/secrets/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY ]; then \
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)"; \
    fi; \
    if [ -z "$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY" ]; then \
      echo "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is required: pass it as a BuildKit secret or build arg." >&2; \
      exit 1; \
    fi; \
    export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY; \
    npm run build

# The separately deployable rendering frontend (the frontend/ workspace),
# published as spaceworks-events-frontend. It holds no database, mail, Redis or
# storage client and reaches the backend only through the authenticated gateway.
FROM node:22-alpine AS frontend-builder
WORKDIR /app
ARG NEXT_PUBLIC_BASE_URL
ARG NEXT_PUBLIC_BACKEND_ORIGIN
ENV NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL
ENV NEXT_PUBLIC_BACKEND_ORIGIN=$NEXT_PUBLIC_BACKEND_ORIGIN
ENV BACKEND_ORIGIN=$NEXT_PUBLIC_BACKEND_ORIGIN
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
COPY --from=deps /app ./
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV SWE_DISABLE_BUILD_CACHE=1
ENV SWE_FRONTEND_STANDALONE=1
RUN npx prisma generate
RUN --mount=type=secret,id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
    if [ -s /run/secrets/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY ]; then \
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)"; \
    fi; \
    if [ -z "$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY" ]; then \
      echo "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is required: pass it as a BuildKit secret or build arg." >&2; \
      exit 1; \
    fi; \
    export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY; \
    npm run build:frontend

FROM node:22-alpine AS frontend
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
# Standalone output for a workspace keeps its path below the repository root.
COPY --from=frontend-builder --chown=nextjs:nodejs /app/frontend/.next/standalone ./
COPY --from=frontend-builder --chown=nextjs:nodejs /app/frontend/.next/static ./frontend/.next/static
COPY --from=frontend-builder --chown=nextjs:nodejs /app/frontend/public ./frontend/public
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN rm -f frontend/.env frontend/.env.local frontend/.env.production .env
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Where docker-entrypoint.sh finds the build to apply the public origins to.
ENV SWE_NEXT_DIR=/app/frontend/.next
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/sw.js').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "frontend/server.js"]

# Stage 3: Production runner, published as spaceworks-events-backend (keep this
# the LAST stage: Render builds the final stage because a Blueprint cannot
# select a build target). The same image applies migrations (`migrate`) and
# runs the VPS operator tools (scripts/, docker/vps/) as root.
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Sharp renders ticket and certificate SVGs on the server. Alpine has no
# system fonts by default, which otherwise turns every text glyph into a box.
# OpenSSL creates the VPS's private CA and service certificates (ops role).
RUN apk add --no-cache font-dejavu openssl && fc-cache -f

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

RUN mkdir .next
RUN chown nextjs:nodejs .next

# Leverage Next.js standalone tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Prisma CLI for the optional MIGRATE_ON_START=1 path (root-owned, read-only).
COPY --from=prisma-cli /opt/prisma-cli/node_modules /opt/prisma-cli/node_modules
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Operator tools (setup, preflight, schema checks, smoke tests), root-owned.
COPY scripts/*.mjs ./scripts/
COPY docker/vps ./docker/vps
COPY --from=ops-modules /opt/ops/node_modules ./docker/vps/node_modules

# Next's standalone trace may include dotenv files when a build is performed
# from a developer checkout. Secrets belong only in the runtime environment.
RUN rm -f .env .env.local .env.production .env.development

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
