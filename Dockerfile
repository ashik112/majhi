# No `# syntax=` line: it makes every build fetch the frontend from Docker Hub, and the
# built-in one supports everything here (RUN --mount included).

# Where the server and runner images start: the stages below (`runtime-build`, `runner-build`), built
# from this checkout, or a release image on ghcr.io, which docker-compose.yml names when .env sets
# MAJHI_VERSION. Either way the last stage, the owner's user, is built here (docker/owner.sh).
ARG SERVER_FROM
ARG RUNNER_FROM

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

# What the server and the runner share: Node, git, the agent CLIs and ACP adapters. The owner's
# passwd entry comes last (`runtime`, `runner`), so these layers are the same on every computer.
FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# The ACP adapters bring their own native CLIs as optional dependencies: never install with --omit=optional.
RUN npm install -g @agentclientprotocol/claude-agent-acp@0.84.0 @agentclientprotocol/codex-acp@2.0.0 \
  && npm cache clean --force
ENV GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=*

# kubectl for kubectl connections (SPEC 5.14): agent runs and each connection's Test run it in the runner.
# Pinned by version and by the SHA-256 per CPU. To update, change the version and take the sums from
# https://dl.k8s.io/release/<version>/bin/linux/<arch>/kubectl.sha256.
FROM debian:bookworm-slim AS kubectl
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  KUBECTL_VERSION=v1.37.1; \
  case "$TARGETARCH" in \
    amd64) KUBECTL_SHA=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8 ;; \
    arm64) KUBECTL_SHA=ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7 ;; \
    *) echo "kubectl is not pinned for $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl"; \
  echo "${KUBECTL_SHA}  /kubectl" | sha256sum -c -; \
  chmod 755 /kubectl; \
  /kubectl version --client

# OWASP Noir for the wiki's facts (docs/design/wiki.md, step 1): finds the HTTP routes of a repo's clean source
# export, in the sealed reader container, with no network and no model (`apps/server/src/wiki/facts/`). A static
# binary, pinned by version and by the SHA-256 of each release asset, per CPU. To update, change the version
# and take the sums from the release page (github.com/owasp-noir/noir/releases); raise `NOIR_VERSION` in
# `apps/server/src/reader/run.ts` with it.
FROM debian:bookworm-slim AS noir
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  NOIR_VERSION=v1.4.0; \
  case "$TARGETARCH" in \
    amd64) NOIR_ASSET=noir-${NOIR_VERSION}-linux-x86_64; NOIR_SHA=620e774f240be91b975ca0b2f04a5df568f0612ef1f74d182a43a25daf402001 ;; \
    arm64) NOIR_ASSET=noir-${NOIR_VERSION}-linux-arm64; NOIR_SHA=17d6dd5be002fe49bc23189a1ec6788ec420eca3254cf6cca50817c8ffd2436a ;; \
    *) echo "noir is not pinned for $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /noir "https://github.com/owasp-noir/noir/releases/download/${NOIR_VERSION}/${NOIR_ASSET}"; \
  echo "${NOIR_SHA}  /noir" | sha256sum -c -; \
  chmod 755 /noir; \
  /noir --version

# Where agents run (Phase 2c): one container per run, started by the server, that mounts only the
# task folder, its repos' .git and the account's home. It has the dev toolchain agents need for
# real projects: build tools for native modules, pnpm, and Playwright's Chromium with its system
# libraries. The browsers live outside any home, and PLAYWRIGHT_BROWSERS_PATH is one of the few
# variables passed to agent runs (see packages/acp BaseEnv).
# The GitHub and GitLab command line tools majhi uses to open and merge merge requests (5.5). Pinned
# by version and by the SHA-256 of each release archive, per CPU. To update, change the versions and
# take the sums from `gh_<version>_checksums.txt` (github.com/cli/cli releases) and `checksums.txt`
# (gitlab.com/gitlab-org/cli releases). The server runs them for merge requests; runs use them through `git` connections.
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

# doctl for DigitalOcean connections: scripts of majhi_secrets_saveFromScript and script watches run it
# in the runner (`doctl databases connection`, `doctl databases user get`). Pinned by version and by the
# SHA-256 of each release archive, per CPU. To update, change the version and take the sums from
# `doctl-<version>-checksums.sha256` (github.com/digitalocean/doctl releases).
FROM debian:bookworm-slim AS doctl
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  DOCTL_VERSION=1.177.0; \
  case "$TARGETARCH" in \
    amd64) DOCTL_SHA="34d3954721bfb8cdb42032e78d98274f157426fa6332511ae356edcce59dade3" ;; \
    arm64) DOCTL_SHA="3adfe5bb667c2cdee15eb3501d53b57d8f04dfa945ddd4584f6f760834506992" ;; \
    *) echo "doctl is not pinned for $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  mkdir /out /dl; cd /dl; \
  curl -fsSL -o doctl.tgz "https://github.com/digitalocean/doctl/releases/download/v${DOCTL_VERSION}/doctl-${DOCTL_VERSION}-linux-${TARGETARCH}.tar.gz"; \
  echo "${DOCTL_SHA}  doctl.tgz" | sha256sum -c -; \
  tar -xzf doctl.tgz -C /out doctl; \
  /out/doctl version

FROM base AS runner-build
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ curl \
  && npm install -g pnpm@11.21.0 \
  && npx -y playwright@1.63.0 install --with-deps chromium \
  && chmod -R a+rX /opt/ms-playwright \
  && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache
# Browser connections (SPEC 5.14): the agent CLI starts one of these MCP servers in the runner, with
# the connection's own profile. Pinned: raise them here and in apps/server/src/connections/browser.ts
# together. Playwright MCP brings its own Playwright, whose Chromium is installed next to the one
# above; Chrome DevTools MCP uses that Chromium through /usr/local/bin/chromium.
RUN npm install -g @playwright/mcp@0.0.83 chrome-devtools-mcp@1.10.1 \
  && node /usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install chromium \
  && ln -sf "$(find /opt/ms-playwright -path '*/chrome-linux*/chrome' -type f | sort | tail -n 1)" /usr/local/bin/chromium \
  && test -x /usr/local/bin/chromium \
  && chmod -R a+rX /opt/ms-playwright \
  && npm cache clean --force \
  && rm -rf /root/.npm /root/.cache
# Vercel `skills` CLI (SPEC 5.2, Phase 6): majhi installs skills by running `skills add <source> -y --copy
# --agent claude-code codex` here, in a throwaway folder, and moves the result into its own store.
# Pinned: raise it here and SKILLS_CLI_VERSION in apps/server/src/skills/cli.ts together.
RUN npm install -g skills@1.7.0 \
  && skills --help > /dev/null \
  && npm cache clean --force \
  && rm -rf /root/.npm /root/.cache
# Serena (SPEC 5.9 item 6): symbol-level code tools, started over stdio by the agent CLI inside its
# runner, one per task worktree (`apps/server/src/runs/serena.ts`). Installed with uv, which is
# mounted for this step only and not left in the image. Python 3.13 and the package live under
# /opt/serena, readable by the owner's uid. Pinned: raise `serena-agent` here and SERENA_VERSION in
# `runs/serena.ts` together. Serena downloads the language server of each language on first use,
# into the account's home, so the first use of a language needs network.
RUN --mount=from=ghcr.io/astral-sh/uv:0.12.21,source=/uv,target=/usr/local/bin/uv \
  UV_TOOL_DIR=/opt/serena/tools UV_TOOL_BIN_DIR=/opt/serena/bin UV_PYTHON_INSTALL_DIR=/opt/serena/python \
  UV_COMPILE_BYTECODE=1 uv tool install -p 3.13 serena-agent==1.7.0 \
  && chmod -R a+rX /opt/serena \
  && /opt/serena/bin/serena --version
# graphify: reads a project's code into a graph for `code_graph` and the wiki, with no model and no network, in a
# throwaway runner container that sees the project's source export read-only (`apps/server/src/reader/`). Installed with uv
# into its own venv under /opt/graphify, on the Python that Serena installed above. Pinned: raise
# `graphifyy` here and GRAPHIFY_VERSION in `apps/server/src/reader/run.ts` together. GRAPHIFY_NO_AUTO_REFRESH
# stops its CLI from rewriting the agent skill folders of the home it runs in.
RUN --mount=from=ghcr.io/astral-sh/uv:0.12.21,source=/uv,target=/usr/local/bin/uv \
  UV_PYTHON_INSTALL_DIR=/opt/serena/python UV_COMPILE_BYTECODE=1 uv venv -p 3.13 /opt/graphify \
  && UV_PYTHON_INSTALL_DIR=/opt/serena/python UV_COMPILE_BYTECODE=1 uv pip install --python /opt/graphify/bin/python graphifyy==0.9.77 \
  && chmod -R a+rX /opt/graphify \
  && GRAPHIFY_NO_AUTO_REFRESH=1 /opt/graphify/bin/graphify --help > /dev/null
ENV GRAPHIFY_NO_AUTO_REFRESH=1
COPY --chmod=0755 docker/wiki_facts.py /usr/local/lib/majhi/wiki_facts.py
COPY --chmod=0644 docker/wiki_calls.py /usr/local/lib/majhi/wiki_calls.py
COPY --chmod=0644 docker/map_inside.py /usr/local/lib/majhi/map_inside.py
COPY --from=kubectl /kubectl /usr/local/bin/kubectl
# Noir, for the wiki's facts (see its stage above).
COPY --from=noir /noir /usr/local/bin/noir
# glab and gh for `git` connections (SPEC 5.14): the run gets the workspace's own sign-in as GITLAB_TOKEN or GH_TOKEN.
COPY --from=host-clis /out/gh /out/glab /usr/local/bin/
# doctl for `digitalocean` connections: the run, and majhi's script fetches and watches, get DIGITALOCEAN_ACCESS_TOKEN.
COPY --from=doctl /out/doctl /usr/local/bin/doctl
# `docker` for scripts in a run (a repo's hand-off check, tests): a shim that sends the call to majhi,
# which runs the task's own containers (apps/server/src/containers/task-docker.ts). No Docker, no socket.
COPY --chmod=0755 docker/docker-shim.mjs /usr/local/bin/docker
# Every run starts through majhi-netguard (SPEC 6): as root with a few capabilities it closes the
# container's route to services on the owner's own computer (iptables), then drops to the owner's
# uid with no capabilities. See docker/netguard.mjs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 docker/netguard.mjs /usr/local/lib/majhi/netguard.mjs
COPY --chmod=0755 docker/majhi-netguard /usr/local/bin/majhi-netguard
# A service on the owner's computer (SPEC 5.14) reaches a task through a forwarder that runs this
# script from the same image, on the task's network. See docker/portforward.mjs.
COPY --chmod=0755 docker/portforward.mjs /usr/local/lib/majhi/portforward.mjs
# /etc/passwd stays read-only, and setuid/setgid bits are stripped from every binary, so an agent
# process has no path to root.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +
WORKDIR /tmp
CMD ["sh", "-c", "echo 'The runner image is started by majhi, one container per agent run.'"]

FROM base AS runtime-build
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
    HOME=/tmp/majhi \
    MALLOC_ARENA_MAX=2
EXPOSE 7070
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7070/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# A 2 MB young generation (V8 grows it to 16 MB by default) and two malloc arenas keep the server's
# resident memory under the 200 MB target of SPEC 5.17; see docs/PROGRESS.md.
CMD ["node", "--max-semi-space-size=2", "dist/main.js"]

# The images compose runs: the stages above, or the release images, with a passwd entry for the
# owner's uid. The containers run as that uid, so files they write belong to the owner.
FROM ${RUNNER_FROM:-runner-build} AS runner
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG HOST_HOME=/home/majhi
RUN --mount=type=bind,source=docker/owner.sh,target=/tmp/owner.sh sh /tmp/owner.sh

FROM ${SERVER_FROM:-runtime-build} AS runtime
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG HOST_HOME=/home/majhi
RUN --mount=type=bind,source=docker/owner.sh,target=/tmp/owner.sh sh /tmp/owner.sh
