# Fake docker

A stand-in for the `docker` CLI, so the containers feature (PRV-53) can be tried, and the Hub and the
Processes card checked in a browser, without Docker. It keeps networks, volumes, builders, images and
containers in `FAKE_DOCKER_STATE` (default `/tmp/majhi-fake-docker.json`). A `docker run` stays up as a
process until it is removed, and a preview (a run with `--publish`) serves a small page on a free
127.0.0.1 port, so the owner link opens. No agent runs: previews and services start through the API.

## Start majhi with it

From the repo root. `MAJHI_RUNNER=container` switches the containers on, and the fake `docker` must come
first on `PATH`. This starts the e2e server (a temp home with sample repos) on `MAJHI_E2E_PORT`:

```sh
rm -f /tmp/majhi-fake-docker.json
PATH="$PWD/apps/server/src/testing/fake-docker:$PATH" MAJHI_RUNNER=container MAJHI_E2E_PORT=7094 \
  pnpm exec tsx e2e/start-server.ts
```

Run the browser script in the same process as the server (import `e2e/start-server.ts` first): the
server only answers its own process tree.

## Get a preview and a service running

Every call is `POST /api/cmd/<name>` with a JSON body, as in `e2e/*.spec.ts`.

1. `workspaces.set` with `{ "workspaces": ["~/Work"] }`.
2. `tasks.create` with `{ "text": "try containers", "start": false }`. It answers the task, say `LOCAL-1`.
3. `containers.images.allow` with `{ "image": "postgres:16-alpine" }`.
4. `containers.services.start` with `{ "task": "LOCAL-1", "name": "db", "image": "postgres:16-alpine", "port": 5432, "volumes": [{ "name": "pgdata", "path": "/var/lib/postgresql/data" }] }`.
5. A preview needs an image. A real build needs a task with a repo, so for a quick look write
   `"majhi-preview-local-1"` (the task key lowercased) into the `images` array of
   `/tmp/majhi-fake-docker.json`, after the task exists (majhi removes the preview images of tasks it
   does not know when it starts). Then `containers.preview.run` with `{ "task": "LOCAL-1", "port": 7070 }`.
   It answers `hostUrl`, a live page served by the fake.
6. `containers.list` with `{}` lists them. `containers.stop` with `{ "task": "LOCAL-1", "name": "db" }`
   (or `"preview"`) stops one. `tasks.stop` removes the containers and the network and keeps the volumes;
   `tasks.close` also removes the volumes.

A task with nobody on it runs the containers as `@majhi`. For the Processes card of a task with a team,
create an org, account and agent first, as `e2e/phase1.spec.ts` does.
