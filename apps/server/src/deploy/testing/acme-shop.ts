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
