import { type CiFiles, type CiSource, readCiFiles } from "../../ci/read.ts";

/**
 * The CI files of `acme-shop`, a sample project that deploys one image tag per client environment: a build that makes
 * an immutable backend image for a commit, a release that deploys a built tag to one target (`acme`, `globex` or
 * `initech`), and a rollback that puts an earlier tag back. Generic names only; used by the discovery and deploy tests.
 */

/** The build takes the version it makes as an input (`X.Y.Z`, not built yet), and shows it in its title. */
const BUILD = `name: Build backend
run-name: Build backend \${{ inputs.version || 'next version' }} from \${{ inputs.source_ref || 'main' }}
on:
  workflow_dispatch:
    inputs:
      version:
        description: Image tag, X.Y.Z. Must not exist yet. Empty takes the next patch
        required: false
      source_ref:
        description: Branch, tag or SHA to build
        required: false
        default: main
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.source_ref }}
      - uses: docker/build-push-action@v6
        with:
          context: backend
          push: true
          tags: registry.acme.example/acme-shop/backend:\${{ inputs.version }}
`;

/** A build that names its image by the commit alone: the version is known without asking. */
export const BUILD_BY_COMMIT = `name: Build image
on:
  workflow_dispatch:
    inputs:
      source_ref:
        required: false
        default: main
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/acme/acme-shop-backend
          tags: |
            type=sha,format=long
`;

const RELEASE = `name: Release
run-name: Deploy \${{ inputs.target }} \${{ inputs.components }} from \${{ inputs.source_ref }}
on:
  workflow_dispatch:
    inputs:
      target:
        description: Client environment
        type: choice
        required: true
        options:
          - acme
          - globex
          - initech
      source_ref:
        description: Branch, tag or SHA to release
        required: false
        default: main
      components:
        description: What to deploy
        type: choice
        default: both
        options:
          - both
          - backend
          - frontend
      backend_version:
        description: An existing immutable tag from Build. Required for backend and both
        required: false
jobs:
  deploy:
    uses: ./.github/workflows/deploy-prod.yml
    with:
      target: \${{ inputs.target }}
      source_ref: \${{ inputs.source_ref }}
      components: \${{ inputs.components }}
      backend_version: \${{ inputs.backend_version }}
`;

const ROLLBACK = `name: Rollback
on:
  workflow_dispatch:
    inputs:
      target:
        type: choice
        required: true
        options:
          - acme
          - globex
          - initech
      components:
        type: choice
        default: both
        options:
          - both
          - backend
          - frontend
      backend_version:
        description: An existing tag to put back
        required: false
      source_ref:
        description: The commit the frontend is built from
        required: false
        default: main
jobs:
  rollback:
    uses: ./.github/workflows/deploy-prod.yml
    with:
      target: \${{ inputs.target }}
`;

const DEPLOY_PROD = `name: Deploy prod
on:
  workflow_call:
    inputs:
      target:
        type: string
        required: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;

/** A GitLab pipeline of the same project, left from before it moved: a manual production job. */
const GITLAB = `stages: [build, deploy]
build-backend:
  stage: build
  script: [make image]
deploy-production:
  stage: deploy
  script: [make deploy]
  environment:
    name: production
    url: https://shop.acme.example
  when: manual
deploy-staging:
  stage: deploy
  script: [make deploy]
  environment: staging
  only: [stg]
`;

export const ACME_SHOP_FILES: Readonly<Record<string, string>> = {
  ".github/workflows/build-image.yml": BUILD,
  ".github/workflows/release.yml": RELEASE,
  ".github/workflows/rollback.yml": ROLLBACK,
  ".github/workflows/deploy-prod.yml": DEPLOY_PROD,
  ".gitlab-ci.yml": GITLAB,
};

/**
 * `acme-shop` as it deploys from GitLab: its GitHub remote builds and tests, and production deploys are manual jobs of
 * the GitLab pipeline. Two registries (`production` for acme and initech, `globex` for globex), one build job each; a
 * deploy job per target takes the parts, the version and a confirmation that must equal the target; a status job reads
 * each target. A target's settings file says its registry, the registry's file says the image.
 */
const GITLAB_ROOT = `stages: [build, deploy]
include:
  - local: .gitlab/ci/deploy.yml
`;

const GITLAB_DEPLOY = `.image:build:
  stage: build
  when: manual
  script:
    - ./deploy/ci/build-image.sh
  variables:
    VERSION:
      value: ""
      description: Image tag, X.Y.Z. Empty takes the next one

.app:deploy:
  stage: deploy
  when: manual
  script:
    - ./deploy/ci/deploy.sh
  variables:
    COMPONENTS:
      value: backend
      description: What to deploy
      options: [backend, frontend, both]
    VERSION:
      value: ""
      description: Image tag, X.Y.Z. Needed unless the target deploys only the frontend
    CONFIRM_TARGET:
      value: ""
      description: Type the target again to confirm

.app:status:
  stage: deploy
  when: manual
  script:
    - ./deploy/ci/status.sh

image:build:production:
  extends: .image:build
  resource_group: image-production
  variables:
    REGISTRY_TARGET: production

image:build:globex:
  extends: .image:build
  resource_group: image-globex
  variables:
    REGISTRY_TARGET: globex

app:deploy:acme:
  extends: .app:deploy
  environment:
    name: app/acme
  variables:
    TARGET: acme

app:deploy:globex:
  extends: .app:deploy
  environment:
    name: app/globex
  variables:
    TARGET: globex

app:deploy:initech:
  extends: .app:deploy
  environment:
    name: app/initech
  variables:
    TARGET: initech

app:status:acme:
  extends: .app:status
  environment:
    name: app/acme
    action: access
  variables:
    TARGET: acme

app:status:globex:
  extends: .app:status
  variables:
    TARGET: globex

app:status:initech:
  extends: .app:status
  variables:
    TARGET: initech
`;

const DEPLOY_SCRIPT = `#!/bin/sh
set -eu
. "deploy/ci/targets/\${TARGET}.env"
[ "$CONFIRM_TARGET" = "$TARGET" ] || { echo "CONFIRM_TARGET must equal TARGET"; exit 1; }
./deploy/ci/rollout.sh "$COMPONENTS" "$VERSION"
`;

const BUILD_SCRIPT = `#!/bin/sh
set -eu
. "deploy/ci/registries/\${REGISTRY_TARGET}.env"
docker build -t "$IMAGE_NAME:$VERSION" backend
`;

const VERSION_PATTERN = "VERSION_PATTERN='^[0-9]+\\.[0-9]+\\.[0-9]+$'";
const PREFIXED_PATTERN = "VERSION_PATTERN='^globex-[0-9]+\\.[0-9]+\\.[0-9]+$'";

/** The GitLab layout of `acme-shop`: the pipeline, the scripts of its jobs and the settings of its targets and registries. */
export const ACME_SHOP_GITLAB_FILES: Readonly<Record<string, string>> = {
  ".gitlab-ci.yml": GITLAB_ROOT,
  ".gitlab/ci/deploy.yml": GITLAB_DEPLOY,
  "deploy/ci/deploy.sh": DEPLOY_SCRIPT,
  "deploy/ci/build-image.sh": BUILD_SCRIPT,
  "deploy/ci/targets/acme.env": `REGISTRY_TARGET=production\n${VERSION_PATTERN}\n`,
  "deploy/ci/targets/globex.env": `REGISTRY_TARGET=globex\n${PREFIXED_PATTERN}\n`,
  "deploy/ci/targets/initech.env": `REGISTRY_TARGET=production\n${VERSION_PATTERN}\n`,
  "deploy/ci/registries/production.env": "IMAGE_NAME=registry.acme.example/acme-shop/backend\n",
  "deploy/ci/registries/globex.env": "IMAGE_NAME=registry.globex.example/acme-shop/backend\n",
};

/**
 * `acme-shop` as a monorepo with two products in it, shaped like a real one: the shop (`apps/acme-api`, `apps/acme-web`)
 * deploys to three targets through one release, a second product (`apps/media-service`) deploys to its own node through
 * jobs of its own. Beside the release GitHub has workflows that take a target and do something else (a data backfill, a
 * status read, the media node's deploy). Nothing names its registry in the YAML: the scripts do, one `case` arm per
 * target, and the allowed parts are the values a script accepts.
 */
const MONO_WORKFLOWS = {
  ".github/workflows/backfill.yml": `name: Backfill
run-name: Backfill \${{ inputs.command }} on \${{ inputs.target }} (\${{ inputs.mode }})
on:
  workflow_dispatch:
    inputs:
      target:
        description: Environment to run against
        required: true
        type: choice
        options: [acme, globex]
        default: acme
      command:
        required: true
        type: choice
        options: [backfill_orders, seed_defaults]
      mode:
        required: true
        type: choice
        options: [dry-run, apply]
        default: dry-run
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo backfill
`,
  ".github/workflows/deployment-status.yml": `name: Deployment status
on:
  workflow_dispatch:
    inputs:
      target:
        required: true
        type: choice
        options: [acme, globex, initech]
jobs:
  read:
    runs-on: ubuntu-latest
    steps:
      - run: echo status
`,
  ".github/workflows/deploy-media-node.yml": `name: Deploy Media Node
on:
  workflow_dispatch:
    inputs:
      target_node:
        required: true
        type: choice
        options: [eu-1]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`,
  ".github/workflows/build.yml": `name: Build
run-name: Build \${{ inputs.registry }} from \${{ inputs.source_ref }}
on:
  workflow_dispatch:
    inputs:
      registry:
        description: Artifact to build
        required: true
        type: choice
        options: [production, globex, media-service]
        default: production
      source_ref:
        required: true
        default: main
      backend_version:
        description: Image tag, X.Y.Z. Empty takes the next one
        required: false
        default: ""
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`,
  ".github/workflows/release.yml": `name: Deploy
run-name: Deploy \${{ inputs.target }} \${{ inputs.components }} from \${{ inputs.source_ref }}
on:
  workflow_dispatch:
    inputs:
      target:
        description: Environment to deploy
        required: true
        type: choice
        options: [acme, globex, initech]
        default: acme
      source_ref:
        required: true
        default: main
      components:
        description: Components to deploy
        type: choice
        options: [both, backend, frontend]
        default: both
      backend_version:
        description: Existing immutable backend tag from Build
        required: false
        default: ""
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`,
};

const MONO_GITLAB = `.runner:
  image: debian:bookworm-slim

.image_build:
  extends: .runner
  stage: build
  needs: []
  variables:
    VERSION: ""
  script:
    - bash deploy/ci/build-image.sh
  rules:
    - when: manual
      allow_failure: true

image:build:production:
  extends: .image_build
  variables:
    REGISTRY_TARGET: production

image:build:globex:
  extends: .image_build
  variables:
    REGISTRY_TARGET: globex

.app_deploy:
  extends: .runner
  stage: deploy
  needs:
    - job: spa:build
      artifacts: true
      optional: true
  variables:
    COMPONENTS: backend
    VERSION: ""
    CONFIRM_TARGET: ""
  script:
    - bash deploy/ci/app-deploy.sh
  rules:
    - when: manual
      allow_failure: false

app:deploy:acme:
  extends: .app_deploy
  environment:
    name: app/acme
  variables:
    TARGET: acme

app:deploy:globex:
  extends: .app_deploy
  environment:
    name: app/globex
  variables:
    TARGET: globex

app:deploy:initech:
  extends: .app_deploy
  environment:
    name: app/initech
  variables:
    TARGET: initech

.app_status:
  extends: .runner
  stage: verify
  needs: []
  script:
    - bash deploy/ci/status.sh
  rules:
    - when: manual
      allow_failure: true

app:status:acme:
  extends: .app_status
  variables:
    TARGET: acme

app:status:globex:
  extends: .app_status
  variables:
    TARGET: globex

app:status:initech:
  extends: .app_status
  variables:
    TARGET: initech

media:artifact:
  extends: .runner
  stage: build
  needs: []
  script:
    - cd apps/media-service && go test ./...
    - bash deploy/ci/build-media.sh
  cache:
    key:
      files:
        - apps/media-service/go.sum
  rules:
    - when: manual
      allow_failure: true

media:deploy:
  extends: .runner
  stage: deploy
  needs:
    - job: media:artifact
      artifacts: true
  variables:
    TARGET_NODE: eu-1
    CONFIRM_TARGET: ""
  script:
    - bash deploy/ci/media-deploy.sh
  environment:
    name: media/eu-1
  rules:
    - when: manual
      allow_failure: false
`;

const MONO_APP_DEPLOY = `#!/usr/bin/env bash
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib.sh"
: "\${TARGET:?TARGET is required}"
components="\${COMPONENTS:-backend}"
[ "$CONFIRM_TARGET" = "$TARGET" ] || exit 1
case "$components" in
  backend | frontend | both) ;;
  *) echo "unsupported COMPONENTS value" >&2; exit 1 ;;
esac
resolve_target "$TARGET"
`;

const MONO_LIB = `#!/usr/bin/env bash
resolve_target() {
  local target="\${1:?target is required}"
  case "$target" in
    acme | initech)
      BACKEND_IMAGE=registry.acme.example/main/acme-backend
      VERSION_PATTERN='^[0-9]+\\.[0-9]+\\.[0-9]+$'
      ;;
    globex)
      BACKEND_IMAGE=registry.globex.example/own/acme-backend
      VERSION_PATTERN='^globex-[0-9]+\\.[0-9]+\\.[0-9]+$'
      ;;
    *)
      echo "unsupported target" >&2
      exit 1
      ;;
  esac
}
`;

const MONO_BUILD = `#!/usr/bin/env bash
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib.sh"
case "$REGISTRY_TARGET" in
  production)
    registry=registry.acme.example/main
    ;;
  globex)
    registry=registry.globex.example/own
    ;;
  *) echo "unsupported REGISTRY_TARGET" >&2; exit 1 ;;
esac
`;

/** The folders of the monorepo `acme-shop`. */
export const ACME_SHOP_MONO_FOLDERS = [
  "apps",
  "apps/acme-api",
  "apps/acme-web",
  "apps/media-service",
  "deploy",
  "docs",
];

export const ACME_SHOP_MONO_FILES: Readonly<Record<string, string>> = {
  ...MONO_WORKFLOWS,
  ".gitlab-ci.yml": GITLAB_ROOT,
  ".gitlab/ci/deploy.yml": MONO_GITLAB,
  "deploy/ci/app-deploy.sh": MONO_APP_DEPLOY,
  "deploy/ci/lib.sh": MONO_LIB,
  "deploy/ci/build-image.sh": MONO_BUILD,
};

/** An in-memory repo: its files by path, and the folders their paths make. */
export function memoryCi(files: Readonly<Record<string, string>>): CiSource {
  return {
    read: async (rel) => files[rel],
    list: async (rel) => {
      const prefix = rel === "" ? "" : `${rel}/`;
      const seen = new Map<string, boolean>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const [first, ...rest] = path.slice(prefix.length).split("/");
        if (first !== undefined) seen.set(first, rest.length > 0);
      }
      return [...seen].map(([name, dir]) => ({ name, dir }));
    },
  };
}

export function acmeShopCi(files: Readonly<Record<string, string>> = ACME_SHOP_FILES): Promise<CiFiles> {
  return readCiFiles(memoryCi(files));
}
