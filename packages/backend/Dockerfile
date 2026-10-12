# Backend image for GoWay. Two-stage build on oven/bun (linux/arm64 for
# AWS Graviton). Only the backend + contracts workspaces are built; the
# heavy Expo frontend tree is excluded via .dockerignore.
#
# Both stages pin oven/bun by its multi-arch index digest after the tag
# (`tag@sha256:...`). A tag is mutable: a re-pushed `oven/bun:1.4.3-alpine`
# would change what this file builds without changing one byte of it, and
# this file's bytes, with .dockerignore, are what
# .github/scripts/reviewed-images.json pins (reviewed-image.py). The
# tag stays for readers and for scripts/check-dockerfile-workspaces.mjs; the
# digest is what the build uses. Bumping bun means a new tag AND its index
# digest (`docker buildx imagetools inspect oven/bun:<tag>`), and a re-review.

# Stage 1: build (tsc → dist)
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS builder
WORKDIR /app

# Root files first. bunfig.toml pins the hoisted linker; the root tsconfig is
# the solution base each package extends.
COPY package.json bun.lock bunfig.toml tsconfig.json ./

# Every workspace member's package.json is required for a frozen-lockfile install
# to reconcile, even the ones we do not build here.
COPY packages/contracts/package.json packages/contracts/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
# The SDK is not a backend dependency and none of its code ships in this
# image — but `bun install --frozen-lockfile` resolves the whole workspace
# graph, and bun.lock records that @goway/frontend depends on
# @goway.to/sdk. A member named in the lockfile and absent from the build
# context is a hard error: "listed in bun.lock but not on disk".
COPY packages/sdk/package.json packages/sdk/

# --ignore-scripts skips the root postinstall (it builds the contracts before the
# source is copied); contracts + backend are built explicitly below.
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/contracts/ packages/contracts/
COPY packages/backend/ packages/backend/

RUN cd packages/contracts && bun run build
RUN cd packages/backend && bun run build

# Stage 2: runtime
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

COPY --from=builder /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=builder /app/packages/contracts/package.json packages/contracts/
COPY --from=builder /app/packages/backend/package.json packages/backend/
COPY --from=builder /app/packages/frontend/package.json packages/frontend/
COPY --from=builder /app/packages/sdk/package.json packages/sdk/

# Production dependencies, from the manifests and lockfile alone. It runs
# BEFORE the build output is copied, so a source-only change reuses this layer
# from the build cache.
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY --from=builder /app/packages/contracts/dist/ packages/contracts/dist/
COPY --from=builder /app/packages/backend/dist/ packages/backend/dist/

# The SQL migrations, beside packages/backend/package.json — which is how
# src/db/migrationsFolder.ts resolves them. Needed by the one-shot migration
# task AND by every serving task, because readiness reads this journal to
# decide whether the database is current with the image (GET /ready).
COPY --from=builder /app/packages/backend/drizzle/ packages/backend/drizzle/

USER appuser
EXPOSE 3000

# Probe on 127.0.0.1 (musl resolves "localhost" to ::1 first, which would fail
# even though the server binds IPv4).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ready || exit 1

CMD ["bun", "packages/backend/dist/server.js"]
