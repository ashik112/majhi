# No `# syntax=` line: it makes every build fetch the frontend from Docker Hub, and the
# built-in one supports everything here (RUN --mount included).

# Where the server and runner images start: the stages below (`runtime-build`, `runner-build`), built
# from this checkout, or a release image on ghcr.io, which docker-compose.yml names when .env sets
# MAJHI_VERSION. Either way the last stage, the owner's user, is built here (docker/owner.sh).
ARG SERVER_FROM
ARG RUNNER_FROM
ARG BROWSER_FROM
ARG TEST_BROWSER_FROM

# Pins used by more than one stage live here, once; a stage that uses one says `ARG NAME`. A pin used by
# one stage sits in that stage, with how to raise it.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=11.21.0
ARG UV_VERSION=0.12.21
ARG DOCKER_CLI_VERSION=29.8.1
ARG PLAYWRIGHT_MCP_VERSION=0.0.83

# Images that only hand over a static binary.
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv
FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli

# Image size (docs/DECISIONS.md, "Lean images"): build tools, caches and downloads live only in the
# stages below that are not the last of a chain. The two images (`runtime-build`, `runner-build`) are
# assembled from COPY --from of those stages and from one apt layer. What the two share (Node, git,
# gh, glab and the agent adapters) is the `base` stage, so those layers are stored once.

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
# node-pty has no Linux prebuilds, so it compiles from source.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
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
# node-pty: only what Linux loads (its JavaScript and the binary compiled above), not the macOS and
# Windows prebuilds, the C++ sources or the build files.
RUN P=apps/server/node_modules/node-pty; mkdir -p /pty/node-pty/build/Release \
  && cp -L $P/package.json /pty/node-pty/ \
  && cp -rL $P/lib /pty/node-pty/lib \
  && cp -L $P/build/Release/pty.node /pty/node-pty/build/Release/ \
  && find /pty -name '*.test.*' -delete
# better-sqlite3 ships Linux prebuilds, so only its JavaScript and the prebuilds for this image are needed:
# not the SQLite sources.
RUN mkdir /sqlite \
  && cp -rL apps/server/node_modules/better-sqlite3 /sqlite/better-sqlite3 \
  && rm -rf /sqlite/better-sqlite3/deps /sqlite/better-sqlite3/src /sqlite/better-sqlite3/prebuilds/darwin-* /sqlite/better-sqlite3/prebuilds/win32-*
# The fonts an exported document embeds (apps/server/src/export/fonts.ts): three Latin files, about 60 KB,
# and the package.json and LICENSE that resolve them. Not the whole packages, which hold every cut.
RUN F=apps/server/node_modules/@fontsource; \
  for p in ibm-plex-sans ibm-plex-mono; do mkdir -p /fonts/$p/files && cp -L $F/$p/package.json $F/$p/LICENSE /fonts/$p/; done \
  && cp -L $F/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2 $F/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2 /fonts/ibm-plex-sans/files/ \
  && cp -L $F/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2 /fonts/ibm-plex-mono/files/

# The two native libraries of the memory store (SPEC 5.6): sqlite-vec (a prebuilt vec0 library per CPU, from its
# sqlite-vec-linux-<arch> package) and transformers.js with onnxruntime-node. npm installs the build for this
# image's CPU, so amd64 and arm64 both work. The versions come from apps/server/package.json, so there is one pin.
# onnxruntime-node ships every platform's binary: keep only this CPU's. onnxruntime-web (the WebAssembly build,
# 143 MB, a dependency of transformers.js for browsers) is never loaded by the Node build: removed. The model
# itself is downloaded on first use into ~/.majhi/cache/models, so the image stays small.
FROM ${NODE_IMAGE} AS server-deps
COPY apps/server/package.json /tmp/server-package.json
RUN npm install --prefix /app --no-save --no-package-lock --omit=dev --no-audit --no-fund \
      $(node -e "const d=require('/tmp/server-package.json').dependencies;console.log(['sqlite-vec','@huggingface/transformers'].map((n)=>n+'@'+d[n]).join(' '))") \
  && ARCH="$(node -p process.arch)" \
  && for d in /app/node_modules/onnxruntime-node/bin/napi-v*; do \
       rm -rf "$d/darwin" "$d/win32"; \
       for a in "$d"/linux/*; do [ "$(basename "$a")" = "$ARCH" ] || rm -rf "$a"; done; \
     done \
  && rm -rf /app/node_modules/onnxruntime-web \
  && npm cache clean --force \
  && rm -rf /root/.npm

# One download stage for the pinned static tools below: curl once, not in each.
FROM debian:bookworm-slim AS fetch
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# kubectl for kubectl connections (SPEC 5.14): agent runs and each connection's Test run it in the runner.
# Pinned by version and by the SHA-256 per CPU. To update, change the version and take the sums from
# https://dl.k8s.io/release/<version>/bin/linux/<arch>/kubectl.sha256.
FROM fetch AS kubectl
ARG TARGETARCH
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
FROM fetch AS noir
ARG TARGETARCH
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

# The GitHub and GitLab command line tools majhi uses to open and merge merge requests (5.5). Pinned
# by version and by the SHA-256 of each release archive, per CPU. To update, change the versions and
# take the sums from `gh_<version>_checksums.txt` (github.com/cli/cli releases) and `checksums.txt`
# (gitlab.com/gitlab-org/cli releases). The server runs them for merge requests; runs use them through `git` connections.
FROM fetch AS host-clis
ARG TARGETARCH
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
FROM fetch AS doctl
ARG TARGETARCH
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

# Playwright's Chromium for the browser image, downloaded here so the download, npm and its caches never reach it.
# The revision is the one Playwright MCP wants (it brings its own Playwright). Only the full `chromium` is kept:
# the browser container starts it headless itself (`docker/browserd.mjs`), so Playwright's separate headless shell
# (280 MB) is deleted here. The chmod (the browser's `extensions` folder is owner-only, and the browser runs as the
# owner's uid) is in the same layer as the install: a later `chmod -R` over the tree copies every file into a new layer.
FROM ${NODE_IMAGE} AS browsers
ARG PLAYWRIGHT_MCP_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
  && node /usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install chromium \
  && rm -rf /opt/ms-playwright/chromium_headless_shell-* /opt/ms-playwright/ffmpeg-* \
  && ln -s "$(find /opt/ms-playwright -path '*/chrome-linux*/chrome' -type f | sort | tail -n 1)" /opt/ms-playwright/chromium \
  && npm cache clean --force \
  && rm -rf /root/.npm /root/.cache \
  && chmod -R a+rX /opt/ms-playwright \
  && test "$(ls -d /opt/ms-playwright/chromium-* | wc -l)" = 1 \
  && test -z "$(find /opt/ms-playwright ! -perm -o+r -print -quit)"

# Serena (SPEC 5.9 item 6): symbol-level code tools, started over stdio by the agent CLI inside its
# runner, one per task worktree (`apps/server/src/runs/serena.ts`). Installed with uv, which is
# mounted for these steps only and not left in the image, and with no uv cache (it was 270 MB of the layer).
# Python 3.13 and the package live under /opt/serena, readable by the owner's uid. Pinned: raise
# `serena-agent` here and SERENA_VERSION in `runs/serena.ts` together. Serena downloads the language
# server of each language on first use, into the account's home, so the first use of a language needs
# network.
# graphify: reads a project's code into a graph for `code_graph` and the wiki, with no model and no network, in a
# throwaway runner container that sees the project's source export read-only (`apps/server/src/reader/`). Installed with uv
# into its own venv under /opt/graphify, on the Python that Serena installed. Pinned: raise
# `graphifyy` here and GRAPHIFY_VERSION in `apps/server/src/reader/run.ts` together. GRAPHIFY_NO_AUTO_REFRESH
# stops its CLI from rewriting the agent skill folders of the home it runs in.
FROM ${NODE_IMAGE} AS python-tools
ENV UV_NO_CACHE=1 UV_COMPILE_BYTECODE=1 UV_PYTHON_INSTALL_DIR=/opt/serena/python
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
  UV_TOOL_DIR=/opt/serena/tools UV_TOOL_BIN_DIR=/opt/serena/bin uv tool install -p 3.13 serena-agent==1.7.0 \
  && uv venv -p 3.13 /opt/graphify \
  && uv pip install --python /opt/graphify/bin/python graphifyy==0.9.77 \
  && chmod -R a+rX /opt/serena /opt/graphify \
  && /opt/serena/bin/serena --version \
  && GRAPHIFY_NO_AUTO_REFRESH=1 /opt/graphify/bin/graphify --help > /dev/null

# What the server and the runner share: Node, git, the GitHub and GitLab tools and the agent adapters. The
# owner's passwd entry comes last (`runtime`, `runner`), so these layers are the same on every computer.
# Both images start from here, so these layers are on disk once.
FROM ${NODE_IMAGE} AS base
# No documentation, man pages or translations from any package installed in this image or the ones above it
# (the copyright files stay, as in Debian's own images).
RUN printf '%s\n' 'path-exclude=/usr/share/doc/*' 'path-include=/usr/share/doc/*/copyright' \
      'path-exclude=/usr/share/man/*' 'path-exclude=/usr/share/info/*' 'path-exclude=/usr/share/locale/*' \
      > /etc/dpkg/dpkg.cfg.d/majhi-lean \
  && apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=host-clis /out/gh /out/glab /usr/local/bin/
ENV GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=*
# /etc/passwd stays read-only, and setuid/setgid bits are stripped from every binary, so an agent
# process has no path to root.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +

# Where agents run (Phase 2c): one container per run, started by the server, that mounts only the
# task folder, its repos' .git and the account's home. It has the dev toolchain agents need for real
# projects: build tools for native modules and pnpm. It has no browser: browser connections reach the
# workspace's browser container (the `browser-build` stage), and a run that needs another browser fetches it
# into its package store.
FROM base AS runner-build
ENV GRAPHIFY_NO_AUTO_REFRESH=1
# The ACP adapters bring their own native CLIs as optional dependencies: never install with --omit=optional.
# They are here and not in the server: sign-in, the CLI version, the probe and the usage read run in a runner
# container too (packages/acp tool-process.ts). Codex ships a voice host (67 MB) for its realtime voice feature,
# which an ACP session never starts: removed in this layer (a later `rm` would not shrink the image). Its coding
# CLI and code-mode host stay. When the Codex version moves, read apps/server/src/runs/codex-hook.ts again: its list of
# Codex's own tools, and how the hook names an MCP tool, come from this version's source.
RUN npm install -g @agentclientprotocol/claude-agent-acp@0.84.0 @agentclientprotocol/codex-acp@2.0.0 \
  && find /usr/local/lib/node_modules/@agentclientprotocol -name codex-voice-host -type f -delete \
  && npm cache clean --force \
  && rm -rf /root/.npm
# Codex's own sandbox (bubblewrap) needs user namespaces, which Docker's default seccomp profile refuses and Ubuntu's
# AppArmor refuses again, so no Codex command runs in a runner until the sandbox is off (openai/codex#15678). majhi
# starts Codex in full access here (packages/acp/src/tools/codex.ts) and the container is the sandbox. What the sandbox
# would have asked, majhi asks through this managed PreToolUse hook (docker/codex/): `requirements.toml` pins it, so
# nothing in the agent's own CODEX_HOME turns it off. The folders and files are root's and nobody else can write
# them: the agent runs as the owner's uid with no capabilities (docker/majhi-netguard). The modes are set by hand,
# because `COPY --chmod` would give the folders the file's mode too, and a folder Codex cannot enter means no hook,
# which Codex does not report. The last step runs the script as an unprivileged user, with no session: Codex lets a
# call run when its hook cannot start, so a hook that cannot run must stop the build.
COPY docker/codex/requirements.toml /etc/codex/requirements.toml
COPY docker/codex/hook.mjs /etc/codex/hooks/majhi-pretool.mjs
RUN chown -R root:root /etc/codex \
  && chmod 0755 /etc/codex /etc/codex/hooks /etc/codex/hooks/majhi-pretool.mjs \
  && chmod 0644 /etc/codex/requirements.toml \
  && echo '{}' | setpriv --reuid 65534 --regid 65534 --clear-groups /usr/local/bin/node /etc/codex/hooks/majhi-pretool.mjs \
     | grep -q '"permissionDecision":"deny"' \
  && setpriv --reuid 65534 --regid 65534 --clear-groups grep -q 'allow_managed_hooks_only = true' /etc/codex/requirements.toml
# One apt layer, no recommends, lists removed.
#  - python3, make, g++, curl: native modules and scripts of the projects agents work on. A non-root run cannot
#    apt install, so these stay baked in.
#  - iptables: majhi-netguard (below). psql and redis-cli (clients only) are for the services a task starts:
#    the agent's shell checks a database or a cache it reaches by name.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 make g++ curl iptables postgresql-client redis-tools \
  && rm -rf /var/lib/apt/lists/*
# pnpm, and the three npm tools. Browser connections (SPEC 5.14): the agent CLI starts one of these MCP servers in the
# runner and it attaches to the workspace's browser container over CDP. Pinned: raise them here and in
# apps/server/src/connections/browser.ts together.
# Vercel `skills` CLI (SPEC 5.2, Phase 6): majhi installs skills by running `skills add <source> -y --copy
# --agent claude-code codex` here, in a throwaway folder, and moves the result into its own store.
# Pinned: raise it here and SKILLS_CLI_VERSION in apps/server/src/skills/cli.ts together.
ARG PNPM_VERSION
ARG PLAYWRIGHT_MCP_VERSION
RUN npm install -g pnpm@${PNPM_VERSION} @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} chrome-devtools-mcp@1.10.1 skills@1.7.0 \
  && skills --help > /dev/null \
  && npm cache clean --force \
  && rm -rf /root/.npm /root/.cache \
  && printf 'int main(void){return 0;}' | g++ -x c++ - -o /tmp/g++-check && rm /tmp/g++-check
# Serena and graphify (the python-tools stage above).
COPY --from=python-tools /opt/serena /opt/serena
COPY --from=python-tools /opt/graphify /opt/graphify
RUN /opt/serena/bin/serena --version && /opt/graphify/bin/graphify --help > /dev/null
COPY --chmod=0755 docker/wiki_facts.py /usr/local/lib/majhi/wiki_facts.py
COPY --chmod=0644 docker/wiki_calls.py /usr/local/lib/majhi/wiki_calls.py
COPY --chmod=0644 docker/map_inside.py /usr/local/lib/majhi/map_inside.py
COPY --from=kubectl /kubectl /usr/local/bin/kubectl
# Noir, for the wiki's facts (see its stage above).
COPY --from=noir /noir /usr/local/bin/noir
# doctl for `digitalocean` connections: the run, and majhi's script fetches and watches, get DIGITALOCEAN_ACCESS_TOKEN.
COPY --from=doctl /out/doctl /usr/local/bin/doctl
# gh and glab for `git` connections (SPEC 5.14) come from `base`: the run gets the workspace's own sign-in as GITLAB_TOKEN or GH_TOKEN.
# setuid and setgid bits again, for what the packages above brought (`base` did the rest).
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +
# `docker` for scripts in a run (a repo's hand-off check, tests): a shim that sends the call to majhi,
# which runs the task's own containers (apps/server/src/containers/task-docker.ts). No Docker, no socket.
COPY --chmod=0755 docker/docker-shim.mjs /usr/local/bin/docker
# Every run starts through majhi-netguard (SPEC 6): as root with a few capabilities it closes the
# container's route to services on the owner's own computer (iptables), then drops to the owner's
# uid with no capabilities. See docker/netguard.mjs.
COPY --chmod=0755 docker/netguard.mjs /usr/local/lib/majhi/netguard.mjs
COPY --chmod=0755 docker/majhi-netguard /usr/local/bin/majhi-netguard
# A service on the owner's computer (SPEC 5.14) reaches a task through a forwarder that runs this
# script from the same image, on the task's network. See docker/portforward.mjs.
COPY --chmod=0755 docker/portforward.mjs /usr/local/lib/majhi/portforward.mjs
WORKDIR /tmp
CMD ["sh", "-c", "echo 'The runner image is started by majhi, one container per agent run.'"]

# The system libraries headless Chromium needs, and netguard's iptables: the shared base of the browser images below.
# The list is `npx playwright install-deps --dry-run chromium` without `xvfb`. Headless Chromium draws with its own
# SwiftShader, so Mesa and LLVM are not installed (155 MB).
FROM ${NODE_IMAGE} AS chromium-libs
RUN printf '%s\n' 'path-exclude=/usr/share/doc/*' 'path-include=/usr/share/doc/*/copyright' \
      'path-exclude=/usr/share/man/*' 'path-exclude=/usr/share/info/*' 'path-exclude=/usr/share/locale/*' \
      > /etc/dpkg/dpkg.cfg.d/majhi-lean \
  && apt-get update \
  && apt-get install -y --no-install-recommends iptables \
       libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 \
       libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 \
       libxext6 libxfixes3 libxkbcommon0 libxrandr2 libfontconfig1 libfreetype6 \
       fonts-noto-color-emoji fonts-unifont fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei \
       fonts-tlwg-loma-otf fonts-freefont-ttf \
  && rm -rf /var/lib/apt/lists/*

# A workspace's browser (SPEC 4.5, "Browser container"): Chromium for the browser connections, started by the server
# when a run first needs one and ended by its own idle timer. `docker/browserd.mjs` is its only process; `majhi-netguard`
# starts it with the runner's guard (private networks closed, owner's uid, no capabilities). The `ldd` and launch test
# below fails the build on a missing library.
FROM chromium-libs AS browser-build
COPY --from=browsers /opt/ms-playwright /opt/ms-playwright
RUN ln -s /opt/ms-playwright/chromium /usr/local/bin/chromium \
  && if ldd "$(readlink -f /usr/local/bin/chromium)" | grep -q "not found"; then ldd "$(readlink -f /usr/local/bin/chromium)" >&2; exit 1; fi \
  && /usr/local/bin/chromium --headless --no-sandbox --disable-gpu --dump-dom about:blank | grep -q "<html>"
COPY --chmod=0755 docker/netguard.mjs /usr/local/lib/majhi/netguard.mjs
COPY --chmod=0755 docker/majhi-netguard /usr/local/bin/majhi-netguard
COPY --chmod=0755 docker/browserd.mjs /usr/local/lib/majhi/browserd.mjs
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +
WORKDIR /tmp
CMD ["node", "/usr/local/lib/majhi/browserd.mjs"]

# A workspace's test browser (SPEC 4.5, "Test browser"): a Playwright server for a repo's own `playwright test`, which
# connects to it through majhi's proxy with PW_TEST_CONNECT_WS_ENDPOINT. `docker/testbrowserd.mjs` starts the server of
# the client's exact version on its first connection. The version installed here is majhi's own pin (the root
# package.json), with Chromium and its headless shell; any other version is fetched when a repo asks for it.
FROM chromium-libs AS test-browser-build
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
COPY package.json /tmp/root-package.json
RUN V="$(node -p "require('/tmp/root-package.json').devDependencies['@playwright/test']")" \
  && npm install -g playwright-core@"$V" \
  && node /usr/local/lib/node_modules/playwright-core/cli.js install chromium \
  && npm cache clean --force \
  && rm -rf /root/.npm /root/.cache /tmp/root-package.json \
  && chmod -R a+rX /opt/pw-browsers \
  && test -z "$(find /opt/pw-browsers ! -perm -o+r -print -quit)"
COPY --chmod=0755 docker/netguard.mjs /usr/local/lib/majhi/netguard.mjs
COPY --chmod=0755 docker/majhi-netguard /usr/local/bin/majhi-netguard
COPY --chmod=0755 docker/testbrowserd.mjs /usr/local/lib/majhi/testbrowserd.mjs
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +
WORKDIR /tmp
CMD ["node", "/usr/local/lib/majhi/testbrowserd.mjs"]

FROM base AS runtime-build
# The server starts runner containers through the Docker socket. Only the CLI, a static binary.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
# The buildx plugin builds agents' previews, each on its own builder (PRV-53).
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
WORKDIR /app
# Memory (5.6): the native libraries from the `server-deps` stage, and the two compiled in `build`.
COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=build /pty/node-pty ./node_modules/node-pty
COPY --from=build /sqlite/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=build /fonts ./node_modules/@fontsource
# The memory store needs both native libraries and the model runtime to load in this image.
RUN node -e "const D=require('/app/node_modules/better-sqlite3'),v=require('/app/node_modules/sqlite-vec');const db=new D(':memory:');v.load(db);console.log('sqlite-vec',db.prepare('select vec_version() v').get().v)" \
  && node -e "require('/app/node_modules/onnxruntime-node');import('@huggingface/transformers').then(()=>console.log('transformers ok'))"
# What changes with every commit comes last, so an update adds only these layers.
COPY --from=build /src/apps/server/dist ./dist
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
    MALLOC_ARENA_MAX=2 \
    MALLOC_MMAP_THRESHOLD_=65536 \
    MALLOC_TRIM_THRESHOLD_=131072
EXPOSE 7070
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7070/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# A 2 MB young generation (V8 grows it to 16 MB by default) and two malloc arenas keep the server's
# resident memory under the 200 MB target of SPEC 5.17; see docs/PROGRESS.md. glibc's mmap threshold is
# fixed at 64 KB (it otherwise rises to 32 MB after the first big free, so a backup's buffers land in the
# heap and stay resident) and the heap top is given back past 128 KB: 25 MB less after a daily backup.
CMD ["node", "--max-semi-space-size=2", "dist/main.js"]

# The images compose runs: the stages above, or the release images, with a passwd entry for the
# owner's uid. The containers run as that uid, so files they write belong to the owner.
FROM ${RUNNER_FROM:-runner-build} AS runner
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG HOST_HOME=/home/majhi
RUN --mount=type=bind,source=docker/owner.sh,target=/tmp/owner.sh sh /tmp/owner.sh

# The browser image has no owner's user: it runs by uid, with HOME set (docker/browserd.mjs).
FROM ${BROWSER_FROM:-browser-build} AS browser

FROM ${TEST_BROWSER_FROM:-test-browser-build} AS test-browser

FROM ${SERVER_FROM:-runtime-build} AS runtime
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG HOST_HOME=/home/majhi
RUN --mount=type=bind,source=docker/owner.sh,target=/tmp/owner.sh sh /tmp/owner.sh
