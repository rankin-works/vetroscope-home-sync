# SPDX-License-Identifier: Apache-2.0
#
# Vetroscope Home Sync image. Multi-stage: a build stage compiles TypeScript
# and prepares a pruned production node_modules (including the compiled
# better-sqlite3 native binding for the target arch), then a small runtime
# stage copies only what's needed. Built via buildx for linux/amd64 and
# linux/arm64.

# ── build stage ───────────────────────────────────────────────────────────
FROM node:20-alpine AS build

# Native deps for better-sqlite3. python3 + make + g++ build the binding;
# sqlite-dev is used by node-gyp's probe. These never land in the runtime
# image.
RUN apk add --no-cache --virtual .build-deps \
    python3 make g++ sqlite-dev

WORKDIR /app

# Install deps in a layer the lockfile invalidates, not the source. Keep
# scripts enabled so better-sqlite3 compiles against this image's Node.
# `scripts/` is copied alongside package.json because npm's `prepare`
# lifecycle invokes scripts/install-git-hooks.mjs during `npm ci` — the
# script itself no-ops in a non-git context (Docker build has no .git),
# but the file needs to exist for `node` to load it.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

# Copy only what tsc + copy-assets need.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Strip dev deps for the runtime copy. `npm prune --omit=dev` keeps the
# better-sqlite3 prebuild/native artifact in node_modules.
RUN npm prune --omit=dev

# ── runtime stage ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# A predictable uid/gid matters on NAS setups (Synology, TrueNAS) where
# the user owns the bind-mounted dataset and the container needs to write
# into it without a host-side `chown -R`.
ARG UID=10001
ARG GID=10001
RUN addgroup -S -g ${GID} vetroscope \
 && adduser  -S -u ${UID} -G vetroscope -s /sbin/nologin vetroscope

# `curl` is the HEALTHCHECK probe; `sqlite` is the admin/backup CLI the
# setup-guide already points users at (e.g. `docker exec … sqlite3
# /data/sync.db ".backup …"`); `tini` is the init that reaps zombies and
# forwards signals. ~3 MB total, worth the budget for first-class admin
# ergonomics on a self-hosted box.
RUN apk add --no-cache curl tini sqlite

WORKDIR /app
ENV NODE_ENV=production \
    VS_DATA_DIR=/data \
    VS_PORT=4437 \
    VS_HOST=0.0.0.0

COPY --from=build --chown=vetroscope:vetroscope /app/dist ./dist
COPY --from=build --chown=vetroscope:vetroscope /app/node_modules ./node_modules
COPY --from=build --chown=vetroscope:vetroscope /app/package.json ./package.json

# `vhs-cli` is the in-container admin surface; see src/cli/index.ts. The
# tiny shim keeps `docker exec <container> vhs-cli <subcommand>` short.
RUN printf '#!/bin/sh\nexec node /app/dist/cli/index.js "$@"\n' > /usr/local/bin/vhs-cli \
 && chmod +x /usr/local/bin/vhs-cli

RUN mkdir -p /data && chown -R vetroscope:vetroscope /data
VOLUME ["/data"]

EXPOSE 4437

USER vetroscope

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${VS_PORT}/health" || exit 1

# tini reaps zombies and forwards SIGTERM/SIGINT to node so graceful
# shutdown actually fires.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
