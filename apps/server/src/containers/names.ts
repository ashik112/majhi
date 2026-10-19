import { IdSchema, PRIVATE, TaskIdSchema } from "@majhi/shared";
import { UserError } from "../errors.ts";

/**
 * Every docker name and label majhi uses for the objects it makes for agents, in one place, keyed by the
 * unit each object belongs to (docs/briefs/workflow-reset.md, step 2):
 *
 * - the workspace (org): the BuildKit builder and the package store. Never shared with another workspace.
 * - the project: the network, holders, containers, volumes, the preview and the images a script built.
 *   A project belongs to one workspace, so nothing here crosses workspaces either.
 * - the task: only the `majhi.task` label, which says which task holds the project's environment now.
 *
 * Cleanup and disk hygiene select by these labels, never by re-reading names.
 */

/** The label keys. The values are what `labelsOf` and the selectors below build. */
export const LABEL = {
  container: "majhi.container",
  task: "majhi.task",
  org: "majhi.org",
  project: "majhi.project",
  compose: "majhi.compose",
} as const;

/** The project environment a task works in. */
export interface EnvRef {
  /** The workspace id, or `private`. */
  org: string;
  /** The project's id, or undefined for a task with no repo: it gets the workspace's own environment. */
  project: string | undefined;
  /** What names and the `majhi.project` label carry. Project ids hold no `.`, so a workspace's own key cannot be one. */
  key: string;
}

/** The environment of a project of `org`, or the workspace's own when there is no project. */
export function envRef(org: string | undefined, project: string | undefined): EnvRef {
  const workspace = IdSchema.parse(org ?? PRIVATE);
  if (project === undefined) return { org: workspace, project: undefined, key: `${workspace}.ws` };
  return { org: workspace, project: IdSchema.parse(project), key: IdSchema.parse(project) };
}

/** What every name is made from: the task that works now and the environment it works in. */
export interface NameScope {
  task: string;
  env: EnvRef;
}

/** The kinds of docker object a `majhi.container` label names. */
export type ObjectKind =
  | "preview"
  | "taskrun"
  | "dbcheck"
  | "hostfwd"
  | "previewhold"
  | "taskhold"
  | "builderguard"
  | "image"
  | "network"
  | "hostnetwork"
  | "volume";

/** The kinds that belong to the project's environment and carry no task: they outlive the task that holds it. An image names the task that built it. */
const ENV_KINDS: readonly ObjectKind[] = ["network", "hostnetwork", "volume"];

/** Every docker name majhi uses for the objects of one task in one project environment. */
export interface ContainerNames {
  /** The task key as it is, for the `majhi.task` label. */
  task: string;
  /** The environment key: the project's id, or `<org>.ws`. */
  key: string;
  org: string;
  /** The workspace's BuildKit builder, `majhi-build-<org>`. */
  builder: string;
  /** The container docker-container builds for it. */
  builderContainer: string;
  /** Its state volume, which `buildx rm` takes with the builder. */
  builderState: string;
  /** The one-shot guard that closes the builder's network, `majhi-build-<org>-bg-<id>`. */
  builderGuard(id: string): string;
  builderGuardPrefix: string;
  /** The preview image of the project, tag `latest`. */
  previewImage: string;
  /**
   * The preview's holder (SPEC 6): it owns the network, the published port and the name the server
   * reaches, and holds the netguard rules. The preview itself shares its network.
   */
  previewContainer: string;
  /** The preview app: the project's image, in the holder's network namespace. */
  previewApp: string;
  /** The internal network of the project's environment. */
  network: string;
  /** A container of the environment (a service, a script's or compose's), `majhi-<key>-c-<name>`. Its network alias is `name`. */
  service(name: string): string;
  /** Prefix of every such container. */
  containerPrefix: string;
  /** The holder of that container: it owns the network namespace and the guard, `majhi-<key>-h-<name>`. */
  holder(name: string): string;
  /** Prefix of every holder. */
  holderPrefix: string;
  /** Prefix of every image a script built. */
  imagePrefix: string;
  /** The forwarder container of a service on the owner's computer (SPEC 5.14), by connection id. */
  hostForward(id: string): string;
  hostForwardPrefix: string;
  /** The network that gives that forwarder its route to the computer: only forwarders join it, never a runner. */
  hostNetwork: string;
  /** A named volume majhi creates for the project. */
  volume(name: string): string;
  /** Prefix of every volume of the project. */
  volumePrefix: string;
  /** The `--label` flags of a created object: its kind, its workspace and project, and the task unless it belongs to the environment. */
  labelFlags(kind: ObjectKind): string[];
  /** The labels an object of this kind must carry, as `key=value` pairs. */
  expectedLabels(kind: ObjectKind): Map<string, string>;
}

/** The kinds of the workspace's browser: its container and the network only that container and its runners share. */
export type BrowserKind = "browser" | "browsernet" | "testbrowser";

/** Docker filters that find objects by label. */
export const select = {
  /** The container, network, volume or image kind. */
  kind: (kind: ObjectKind | BrowserKind): string => `label=${LABEL.container}=${kind}`,
  /** Anything labelled with a `majhi.container` at all. */
  anyKind: `label=${LABEL.container}`,
  /** What the task holds now (containers, and images it built). */
  task: (task: string): string => `label=${LABEL.task}=${task}`,
  project: (key: string): string => `label=${LABEL.project}=${key}`,
  org: (org: string): string => `label=${LABEL.org}=${org}`,
};

/** What belongs to a workspace alone: its BuildKit builder, `majhi-build-<org>`, and the guard that closes its network. */
export function orgNames(org: string) {
  const builder = `majhi-build-${IdSchema.parse(org)}`;
  return {
    org,
    builder,
    /** The container docker-container builds for it. */
    builderContainer: `buildx_buildkit_${builder}0`,
    /** Its state volume, which `buildx rm` takes with the builder. */
    builderState: `buildx_buildkit_${builder}0_state`,
    /** The one-shot guard that closes the builder's network, `majhi-build-<org>-bg-<id>`. */
    builderGuard: (id: string): string => `${builder}-bg-${id}`,
    builderGuardPrefix: `${builder}-bg-`,
  };
}

/**
 * What belongs to a workspace's browser (Chromium, in its own image): one container and one network per
 * workspace, named and labelled from the workspace alone, so a browser container can never be found,
 * joined or mounted by another workspace. The profiles it mounts are that workspace's connections' own.
 */
export function browserNames(org: string) {
  const id = IdSchema.parse(org);
  return {
    org: id,
    container: `majhi-browser-${id}`,
    network: `majhi-browser-${id}`,
    /** The name runners of the workspace reach it by on the network. */
    alias: "browser",
    labelFlags: (kind: BrowserKind): string[] => [
      "--label",
      `${LABEL.container}=${kind}`,
      "--label",
      `${LABEL.org}=${id}`,
    ],
  };
}

/**
 * What belongs to a workspace's test browser: the Playwright server a repo's own `playwright test` connects to.
 * One container per workspace on the runner network, reached only through majhi's authenticated proxy (never by
 * a runner directly), named and labelled from the workspace alone.
 */
export function testBrowserNames(org: string) {
  const id = IdSchema.parse(org);
  return {
    org: id,
    container: `majhi-testbrowser-${id}`,
    labelFlags: (): string[] => [
      "--label",
      `${LABEL.container}=testbrowser`,
      "--label",
      `${LABEL.org}=${id}`,
    ],
  };
}

/** The names inside one project environment, from its key alone: what a label read back from docker needs. */
export function envNames(key: string) {
  return {
    service: (name: string): string => `majhi-${key}-c-${name}`,
    holder: (name: string): string => `majhi-${key}-h-${name}`,
    containerPrefix: `majhi-${key}-c-`,
    holderPrefix: `majhi-${key}-h-`,
    volume: (name: string): string => `majhi-${key}-data-${name}`,
  };
}

/** The names of the task's containers, networks, volumes, builder and image. One place, so cleanup finds what start made. */
export function containerNames(scope: NameScope): ContainerNames {
  const { task, env } = scope;
  if (!TaskIdSchema.safeParse(task).success) throw new UserError(`${task} is not a task key.`);
  const key = env.key;
  const workspace = orgNames(env.org);
  const labelValues = (kind: ObjectKind): Map<string, string> => {
    const labels = new Map<string, string>([
      [LABEL.container, kind],
      [LABEL.org, env.org],
      [LABEL.project, key],
    ]);
    if (!ENV_KINDS.includes(kind)) labels.set(LABEL.task, task);
    return labels;
  };
  return {
    task,
    key,
    ...workspace,
    previewImage: `majhi-${key}-preview`,
    previewContainer: `majhi-${key}-preview`,
    previewApp: `majhi-${key}-preview-app`,
    network: `majhi-${key}`,
    ...envNames(key),
    imagePrefix: `majhi-${key}-img-`,
    hostForward: (id) => `majhi-${key}-host-${id}`,
    hostForwardPrefix: `majhi-${key}-host-`,
    hostNetwork: `majhi-${key}-host`,
    volume: (name) => `majhi-${key}-data-${name}`,
    volumePrefix: `majhi-${key}-data-`,
    labelFlags: (kind) => [...labelValues(kind)].flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    expectedLabels: labelValues,
  };
}

const LEGACY_PREFIX = "majhi-preview-";
const LEGACY_STATE_PREFIX = `buildx_buildkit_${LEGACY_PREFIX}`;
const LEGACY_STATE_SUFFIX = "0_state";

/**
 * What each task had before the environment belonged to the project: a builder and a preview image named
 * `majhi-preview-<task key>`, and the builder's state volume. That name space is majhi's own, so the task
 * an old object belonged to is read from its name: the part after the prefix must be a task key
 * (`TaskIdSchema`). Any other name, even one that starts the same way, belongs to someone else or to the
 * new model and answers undefined.
 */
export function legacyOwner(name: string, kind: "builder" | "image" | "state"): string | undefined {
  let rest: string;
  if (kind === "state") {
    if (!name.startsWith(LEGACY_STATE_PREFIX) || !name.endsWith(LEGACY_STATE_SUFFIX)) return undefined;
    rest = name.slice(LEGACY_STATE_PREFIX.length, name.length - LEGACY_STATE_SUFFIX.length);
  } else {
    if (!name.startsWith(LEGACY_PREFIX)) return undefined;
    rest = name.slice(LEGACY_PREFIX.length);
  }
  const key = rest.toUpperCase();
  return TaskIdSchema.safeParse(key).success ? key : undefined;
}
