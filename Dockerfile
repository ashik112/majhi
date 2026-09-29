# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
# node-pty has no Linux prebuilds, so it compiles from source.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/fix-node-pty.mjs scripts/
COPY apps/host/package.json apps/host/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/acp/package.json packages/acp/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @majhi/web build && pnpm --filter @majhi/server build && pnpm --filter @majhi/host build
# esbuild cannot bundle a .node file, so the server build leaves node-pty and better-sqlite3 external.
# Keep the compiled node-pty for the runtime image. better-sqlite3 ships Linux prebuilds, so only its
# JavaScript and the prebuilds for this image are needed: not the SQLite sources.
RUN mkdir /pty && cp -rL apps/server/node_modules/node-pty /pty/node-pty
RUN mkdir /sqlite \
  && cp -rL apps/server/node_modules/better-sqlite3 /sqlite/better-sqlite3 \
  && rm -rf /sqlite/better-sqlite3/deps /sqlite/better-sqlite3/src /sqlite/better-sqlite3/prebuilds/darwin-* /sqlite/better-sqlite3/prebuilds/win32-*

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# The container runs as the owner's uid so files it writes belong to the owner. OpenSSH refuses to
# start for a uid with no passwd entry, so the entry is created here, at build time, with the owner's
# real home (where ~/.ssh/config is mounted). /etc/passwd stays read-only, and setuid/setgid bits are
# stripped from every binary, so an agent process in this container has no path to root.
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG HOST_HOME=/home/majhi
RUN if ! getent group "$HOST_GID" >/dev/null; then groupadd -g "$HOST_GID" majhi; fi \
  && if getent passwd "$HOST_UID" >/dev/null; then \
       usermod -d "$HOST_HOME" "$(getent passwd "$HOST_UID" | cut -d: -f1)"; \
     else \
       useradd -u "$HOST_UID" -g "$HOST_GID" -d "$HOST_HOME" -M -s /bin/sh majhi; \
     fi \
  && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
# The ACP adapters bring their own native CLIs as optional dependencies: never install with --omit=optional.
RUN npm install -g @agentclientprotocol/claude-agent-acp@0.84.0 @agentclientprotocol/codex-acp@2.0.0 \
  && npm cache clean --force
WORKDIR /app
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /pty/node-pty ./node_modules/node-pty
COPY --from=build /sqlite/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=build /src/apps/web/dist ./web
# The host helper runs on the owner's machine, not here. `make up` copies it out of the image.
COPY --from=build /src/apps/host/dist/majhi-host.mjs ./host/majhi-host.mjs
ENV NODE_ENV=production \
    MAJHI_HOST=0.0.0.0 \
    MAJHI_PORT=7070 \
    MAJHI_WEB_DIST=/app/web \
    HOME=/tmp/majhi \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=*
EXPOSE 7070
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7070/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
