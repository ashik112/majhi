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

/** The GitLab layout of `acme-shop`: the pipeline, the scripts of its jobs and the settings of its targets and registries. */
export const ACME_SHOP_GITLAB_FILES: Readonly<Record<string, string>> = {
  ".gitlab-ci.yml": GITLAB_ROOT,
  ".gitlab/ci/deploy.yml": GITLAB_DEPLOY,
  "deploy/ci/deploy.sh": DEPLOY_SCRIPT,
  "deploy/ci/build-image.sh": BUILD_SCRIPT,
  "deploy/ci/targets/acme.env": `REGISTRY_TARGET=production\n${VERSION_PATTERN}\n`,
  "deploy/ci/targets/globex.env": `REGISTRY_TARGET=globex\n${VERSION_PATTERN}\n`,
  "deploy/ci/targets/initech.env": `REGISTRY_TARGET=production\n${VERSION_PATTERN}\n`,
  "deploy/ci/registries/production.env": "IMAGE_NAME=registry.acme.example/acme-shop/backend\n",
  "deploy/ci/registries/globex.env": "IMAGE_NAME=registry.globex.example/acme-shop/backend\n",
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
