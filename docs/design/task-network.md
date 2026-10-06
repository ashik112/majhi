# One network for everything a task starts

Status: built on `fix/task-docker-stack`. Replaces the "services are internal and cannot see scripts' containers" arrangement.

## Problem

A task could start containers four ways (`service_start`, a script's `docker run` through the shim, a `majhi-processes` process, and nothing for compose). They had different names (`majhi-<key>-<name>` and `majhi-<key>-c-<name>`), different guards (services had none, so on OrbStack a service could reach another network by address) and no internet (the task network is `--internal`). Compose was refused outright.

## Shape

Every container a task starts is a **pair**. The shape is typed once, as `RunSpec` (`containers/task-docker.ts`), and `buildRunPlan` builds and checks its calls. `taskHoldRunArgs` (`containers/args.ts`) builds the holder.

- The **holder** `majhi-<key>-h-<name>` runs the runner image's netguard (`--hold`), as the preview's holder does. It joins the runner network (the only route out) and the task network under the aliases `<name>` and `majhi-<key>-c-<name>`. netguard closes every private range, link-local, the host and the gateways, and opens only the task network's own subnet and the public internet.
- The **app** `majhi-<key>-c-<name>` is the user's container. It runs in the holder's network namespace (`--network container:<holder>`), drops all capabilities but five and has no `NET_ADMIN`, so it cannot change the rules the holder set. Same limits, labels and mounts rules as before.

The task network stays `--internal`. That is the reason nothing private is reachable: it has no gateway, so no route leaves it. The only route out is the holder's second interface, and netguard filters it. Services, scripts' containers, compose services and the agent's own runner all get the same rule from the same script.

## Who uses it

| Caller | Before | Now |
|---|---|---|
| `service_start` | `majhi-<key>-<name>`, internal only, no guard | pair, label `taskrun`, managed process as before |
| script `docker run` | `majhi-<key>-c-<name>`, internal only | pair, label `taskrun` |
| `docker compose up` | refused | translated to the same pairs, label `taskrun`, plus `majhi.compose=<service>` |
| `majhi-processes` process | runner container, joined the task network without a name | runner container, alias = the process name on the task network |

The agent's runner is on the task network already (it joins when the network exists, `ensureNetwork` refreshes its guard), so it resolves every name above and nothing else.

## Lifecycle

- A holder is created before its app and removed with it. `reapHolders` removes a holder whose app does not exist, under the task's lock, skipping names that are starting. It runs after every shim call and at cleanup.
- Everything is found by `majhi.task=<id>` and `majhi.container`: `taskStopped`, `taskEnded` and the startup sweep remove holders, apps, networks and volumes by label, so a crash leaves nothing that the next start does not remove.
- A compose stack that came up is remembered in memory and comes up again when the task runs again (`taskRunning`), like a service.
- A `majhi-processes` process asks for the task network before it starts and runs with the alias `processHost(name)`.

## Compose

`containers/compose-cli.ts` reads what the script typed, `containers/compose.ts` reads the repo's compose files (YAML, inside the task folder only), checks them with zod against an allow list of keys, and returns a typed plan: services in dependency order, each a `RunSpec` and maybe a build. `containers/compose-run.ts` runs the plan with the same code as `docker run` (`ComposeHost` is what the service lends it). The project name is the task. Published ports are not published: the service is reachable as `<service>:<container port>` from the task. Volumes are task folder binds or per-task named volumes. A key outside the allow list is refused with a code (`compose_privileged`, `compose_host_network`, `compose_device`, `compose_socket_mount`, `compose_mount_outside`, `compose_env_file_outside`, `compose_unsupported_key`, `compose_unsupported_flag`) that the shim prints as `docker: [code] message` and returns in `error.code`.

## Rejected

- Guard inside each container (a wrapper entrypoint): images have their own entrypoints, and the guard needs `NET_ADMIN`, which the app must not hold.
- A per-task gateway container with routes: a container needs `NET_ADMIN` to set a default route, and `--internal` has none.
- Host `iptables` (DOCKER-USER): majhi has no host namespace on Docker Desktop and OrbStack.
- A second network manager for services: one network per task already exists, and its subnet is what netguard allows.
