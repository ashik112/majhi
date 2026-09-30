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
# esbuild cannot bundle a .node file, so the server build leaves node-pty, better-sqlite3, sqlite-vec and
# @huggingface/transformers (onnxruntime-node) external.
# Keep the compiled node-pty for the runtime image. better-sqlite3 ships Linux prebuilds, so only its
# JavaScript and the prebuilds for this image are needed: not the SQLite sources.
RUN mkdir /pty && cp -rL apps/server/node_modules/node-pty /pty/node-pty
RUN mkdir /sqlite \
  && cp -rL apps/server/node_modules/better-sqlite3 /sqlite/better-sqlite3 \
  && rm -rf /sqlite/better-sqlite3/deps /sqlite/better-sqlite3/src /sqlite/better-sqlite3/prebuilds/darwin-* /sqlite/better-sqlite3/prebuilds/win32-*

# What the server and the runner share: Node, git, the agent CLIs and ACP adapters, and a passwd
# entry for the owner's uid (OpenSSH and some CLIs refuse to run without one).
FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# The container runs as the owner's uid so files it writes belong to the owner. The passwd entry is
# created here, at build time, with the owner's real home (where ~/.ssh/config is mounted).
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG HOST_HOME=/home/majhi
RUN if ! getent group "$HOST_GID" >/dev/null; then groupadd -g "$HOST_GID" majhi; fi \
  && if getent passwd "$HOST_UID" >/dev/null; then \
       usermod -d "$HOST_HOME" "$(getent passwd "$HOST_UID" | cut -d: -f1)"; \
     else \
       useradd -u "$HOST_UID" -g "$HOST_GID" -d "$HOST_HOME" -M -s /bin/sh majhi; \
     fi
# The ACP adapters bring their own native CLIs as optional dependencies: never install with --omit=optional.
RUN npm install -g @agentclientprotocol/claude-agent-acp@0.84.0 @agentclientprotocol/codex-acp@2.0.0 \
  && npm cache clean --force
ENV GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=*

# Where agents run (Phase 2c): one container per run, started by the server, that mounts only the
# task folder, its repos' .git and the account's home. It has the dev toolchain agents need for
# real projects: build tools for native modules, pnpm, and Playwright's Chromium with its system
# libraries. The browsers live outside any home, and PLAYWRIGHT_BROWSERS_PATH is one of the few
# variables passed to agent runs (see packages/acp BaseEnv).
FROM base AS runner
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ curl \
  && npm install -g pnpm@11.21.0 \
  && npx -y playwright@1.63.0 install --with-deps chromium \
  && chmod -R a+rX /opt/ms-playwright \
  && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache
# /etc/passwd stays read-only, and setuid/setgid bits are stripped from every binary, so an agent
# process has no path to root.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +
WORKDIR /tmp
CMD ["sh", "-c", "echo 'The runner image is started by majhi, one container per agent run.'"]

# The GitHub and GitLab command line tools majhi uses to open and merge merge requests (5.5). Pinned
# by version and by the SHA-256 of each release archive, per CPU. To update, change the versions and
# take the sums from `gh_<version>_checksums.txt` (github.com/cli/cli releases) and `checksums.txt`
# (gitlab.com/gitlab-org/cli releases). Only the server runs them; the runner image does not have them.
FROM debian:bookworm-slim AS host-clis
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  GH_VERSION=2.102.0; GLAB_VERSION=1.120.0; \
  case "$TARGETARCH" in \
    amd64) GH_SHA=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386; \
           GLAB_SHA=4e6c59de9f7ed2f304bf93aad01ea8f8a69584f0450ce90ad696ef81f69c69aa ;; \
    arm64) GH_SHA=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484; \
           GLAB_SHA=c60ebb4cb36f276714847a118845b9b4e69f46a8080c68b21ca63f158722cdea ;; \
    *) echo "gh and glab are not pinned for $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  mkdir /out /dl; cd /dl; \
  curl -fsSL -o gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
  echo "${GH_SHA}  gh.tgz" | sha256sum -c -; \
  tar -xzf gh.tgz -C /out --strip-components=2 "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh"; \
  curl -fsSL -o glab.tgz "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${TARGETARCH}.tar.gz"; \
  echo "${GLAB_SHA}  glab.tgz" | sha256sum -c -; \
  tar -xzf glab.tgz -C /out --strip-components=1 bin/glab; \
  /out/gh --version; /out/glab --version

FROM base AS runtime
# The server starts runner containers through the Docker socket. Only the CLI, a static binary.
COPY --from=docker:29.8.1-cli /usr/local/bin/docker /usr/local/bin/docker
# The buildx plugin builds agents' previews, each on its own builder (PRV-53).
COPY --from=docker:29.8.1-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=host-clis /out/gh /out/glab /usr/local/bin/
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +
WORKDIR /app
# Memory (5.6): sqlite-vec (a prebuilt vec0 library per CPU, from its sqlite-vec-linux-<arch> package) and
# transformers.js with onnxruntime-node. npm installs the build for this image's CPU, so amd64 and arm64
# both work. Keep the versions in step with apps/server/package.json. onnxruntime-node ships every
# platform's binary: keep only this CPU's. The model itself is downloaded on first use into
# ~/.majhi/cache/models, so the image stays small.
RUN npm install --prefix /app --no-save --no-package-lock --omit=dev --no-audit --no-fund \
      sqlite-vec@0.1.9 @huggingface/transformers@4.3.0 \
  && ARCH="$(node -p process.arch)" \
  && for d in /app/node_modules/onnxruntime-node/bin/napi-v*; do \
       rm -rf "$d/darwin" "$d/win32"; \
       for a in "$d"/linux/*; do [ "$(basename "$a")" = "$ARCH" ] || rm -rf "$a"; done; \
     done \
  && npm cache clean --force
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /pty/node-pty ./node_modules/node-pty
COPY --from=build /sqlite/better-sqlite3 ./node_modules/better-sqlite3
# The memory store needs both native libraries to load in this image.
RUN node -e "const D=require('/app/node_modules/better-sqlite3'),v=require('/app/node_modules/sqlite-vec');const db=new D(':memory:');v.load(db);console.log('sqlite-vec',db.prepare('select vec_version() v').get().v)"
COPY --from=build /src/apps/web/dist ./web
# The host helper runs on the owner's machine, not here. `make up` copies it out of the image.
COPY --from=build /src/apps/host/dist/majhi-host.mjs ./host/majhi-host.mjs
# The git commit this image was built from, so majhi can tell when newer code is on disk. It comes last
# so a new commit does not invalidate the layers above. `dev` means the build did not say.
ARG MAJHI_COMMIT=dev
ENV MAJHI_COMMIT=$MAJHI_COMMIT \
    NODE_ENV=production \
    MAJHI_HOST=0.0.0.0 \
    MAJHI_PORT=7070 \
    MAJHI_WEB_DIST=/app/web \
    HOME=/tmp/majhi
EXPOSE 7070
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7070/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
