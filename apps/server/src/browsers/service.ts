import { NETGUARD, NETGUARD_CAPS, type RunnerConfig, runMounts } from "@majhi/acp";
import { browserNames } from "../containers/names.ts";
import { errorMessage } from "../errors.ts";
import { inSubnet } from "../runner/network.ts";
import { dockerOf, waitForLine } from "./docker.ts";

/** Where `docker/browserd.mjs` lives in the browser image. */
const BROWSERD = "/usr/local/lib/majhi/browserd.mjs";
/** What browserd prints when its ports are open. */
const READY_LINE = "majhi-browserd ready";
/** The first port of a workspace's browser: its profiles take the next ones in order of their ids. */
export const BROWSER_FIRST_PORT = 9300;
/** The private range each workspace's browser network is taken from: one /24 each, `10.211.<n>.0/24`. */
const NET_PREFIX = "10.211";
/** The browser is the second address of its network (the gateway is the first). */
const BROWSER_HOST = 2;

/** One browser connection of a workspace and the folder of its profile. */
export interface BrowserProfile {
  id: string;
  dir: string;
}

export interface BrowserDeps {
  /** The image with Chromium (`majhi-browser:dev`). */
  image: string;
  /** How runners start: docker, its environment, the user, the mount rules and the limits. Read at each start. */
  runner: () => Pick<
    RunnerConfig,
    "docker" | "cliEnv" | "user" | "memory" | "cpus" | "pidsLimit" | "majhiHome" | "protectedPaths"
  >;
  /** The browser connections of a workspace, with their profile folders. Only that workspace's own. */
  profiles: (org: string) => Promise<BrowserProfile[]>;
  /** Makes a profile folder, private to the owner, before it is mounted (docker would make it root's). */
  prepareDir: (dir: string) => Promise<void>;
  /** Runs `docker args` and returns what it printed. Replaced in tests. */
  docker?: (args: string[]) => Promise<string>;
  /** How long to wait for the container's ports. Default 30 s. */
  readyMs?: number;
}

/** What one workspace's browser is, once it runs. */
interface Ready {
  network: string;
  ip: string;
  /** The port of each connection's profile. */
  ports: Map<string, number>;
}

/**
 * Chromium for the browser connections (SPEC 5.14), apart from the runners: one container per workspace,
 * started when a run first needs it and ended by its own idle timer (`docker/browserd.mjs`). It sits on a
 * network of its own that only it and the runners holding a browser connection of that workspace join; a
 * runner is let through to that one address and nothing else on the network. The container mounts only
 * the profile folders of that workspace's browser connections, so one workspace's logins are never in
 * another workspace's browser, and nothing of the computer is mounted.
 */
export class BrowserService {
  private readonly ready = new Map<string, Ready>();
  private readonly used = new Map<string, Set<string>>();
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: BrowserDeps) {}

  /**
   * Makes sure the workspace's browser runs and says where connection `id` is reached, and remembers that
   * `task` needs the network (its runner joins it when it starts). Resolves a plain problem when it cannot.
   */
  async endpoint(task: string, org: string, id: string): Promise<{ endpoint: string } | { problem: string }> {
    try {
      const ready = await this.serialized(org, () => this.ensure(org));
      const port = ready.ports.get(id);
      if (port === undefined) return { problem: `${id} has no browser here.` };
      const held = this.used.get(task) ?? new Set<string>();
      held.add(org);
      this.used.set(task, held);
      return { endpoint: `http://${browserNames(org).container}:${port}` };
    } catch (err) {
      return { problem: `The browser of ${org} did not start: ${errorMessage(err).split("\n", 1)[0]}` };
    }
  }

  /** The browser networks a run of this task joins when it starts. */
  networksOf(task: string): string[] {
    return this.readyOf(task).map((r) => r.network);
  }

  /** The one address of each such browser a run of this task may reach (netguard `--allow`). */
  subnetsOf(task: string): string[] {
    return this.readyOf(task).map((r) => `${r.ip}/32`);
  }

  /** The task is done: it needs no browser network. The container ends by its own timer. */
  forget(task: string): void {
    this.used.delete(task);
  }

  /** At start: browser containers and networks a previous majhi left go. */
  async reset(): Promise<void> {
    this.ready.clear();
    this.used.clear();
    const docker = this.docker();
    const listed = async (args: string[]): Promise<string[]> =>
      (await docker(args).catch(() => "")).split("\n").filter((l) => l !== "");
    const containers = await listed(["ps", "-aq", "--filter", "label=majhi.container=browser"]);
    if (containers.length > 0) await docker(["rm", "-f", ...containers]).catch(() => "");
    for (const net of await listed([
      "network",
      "ls",
      "--filter",
      "label=majhi.container=browsernet",
      "--format",
      "{{.Name}}",
    ])) {
      await docker(["network", "rm", net]).catch(() => "");
    }
  }

  private readyOf(task: string): Ready[] {
    return [...(this.used.get(task) ?? [])].flatMap((org) => this.ready.get(org) ?? []);
  }

  private docker(): (args: string[]) => Promise<string> {
    return this.deps.docker ?? dockerOf(this.deps.runner());
  }

  /** One start or check at a time per workspace. */
  private serialized<T>(org: string, step: () => Promise<T>): Promise<T> {
    const next = (this.queue.get(org) ?? Promise.resolve()).catch(() => undefined).then(step);
    this.queue.set(org, next);
    return next;
  }

  private async ensure(org: string): Promise<Ready> {
    const names = browserNames(org);
    const docker = this.docker();
    const cfg = this.deps.runner();
    const profiles = [...(await this.deps.profiles(org))].sort((a, b) => a.id.localeCompare(b.id));
    if (profiles.length === 0) throw new Error("it has no browser connection");
    // Only this workspace's profile folders, checked by the rules every run's mounts pass.
    const mounts = runMounts(
      {
        command: { command: "browser", args: [] },
        env: {},
        cwd: "/tmp",
        scratch: true,
        mounts: profiles.map((p) => ({ path: p.dir })),
      },
      { ...cfg, image: this.deps.image, network: names.network },
    );
    for (const p of profiles) await this.deps.prepareDir(p.dir);
    const ports = new Map(profiles.map((p, i) => [p.id, BROWSER_FIRST_PORT + i]));
    const wanted = JSON.stringify(profiles.map((p) => [p.id, p.dir]));

    // Ranges are taken one workspace at a time, so two workspaces never pick the same one.
    const subnet = await this.serialized("network", () => this.network(docker, names));
    const ip = hostOf(subnet, BROWSER_HOST);
    const state = await docker([
      "inspect",
      "--format",
      '{{.State.Running}} {{index .Config.Labels "majhi.browser.profiles"}}',
      names.container,
    ]).catch(() => "");
    const [running = "", ...rest] = state.trim().split(" ");
    if (running === "true" && rest.join(" ") === wanted) {
      // Already running with these profiles (its ports follow from their order): use it.
      const ready: Ready = { network: names.network, ip, ports };
      this.ready.set(org, ready);
      return ready;
    }
    await docker(["rm", "-f", names.container]).catch(() => "");

    const args = [
      "run",
      "-d",
      "--rm",
      "--init",
      "--name",
      names.container,
      ...names.labelFlags("browser"),
      "--label",
      `majhi.browser.profiles=${wanted}`,
      "--network",
      names.network,
      "--ip",
      ip,
      "--cap-drop",
      "ALL",
      ...NETGUARD_CAPS.flatMap((c) => ["--cap-add", c]),
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(cfg.pidsLimit ?? 2048),
      "--memory",
      cfg.memory ?? "4g",
      "--cpus",
      cfg.cpus ?? "1",
      ...mounts.flatMap((m) => ["--mount", `type=bind,source=${m.path},target=${m.path}`]),
      "--env",
      `MAJHI_BROWSER_PROFILES=${JSON.stringify(
        profiles.map((p) => ({ id: p.id, port: ports.get(p.id), dir: p.dir })),
      )}`,
      this.deps.image,
      NETGUARD,
      cfg.user ?? "0:0",
      "--",
      "node",
      BROWSERD,
    ];
    await docker(args);
    await this.waitReady(docker, names.container);
    const ready: Ready = { network: names.network, ip, ports };
    this.ready.set(org, ready);
    return ready;
  }

  /** The workspace's browser network: made once, from a free range, with the labels that find it again. Returns its subnet. */
  private async network(
    docker: (args: string[]) => Promise<string>,
    names: ReturnType<typeof browserNames>,
  ): Promise<string> {
    const read = async (name: string): Promise<string[]> =>
      (await docker(["network", "inspect", name, "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}"]))
        .trim()
        .split(" ")
        .filter((s) => s !== "");
    const own = await read(names.network).catch((): string[] => []);
    if (own[0] !== undefined) return own[0];
    const taken: string[] = [];
    const ids = (await docker(["network", "ls", "-q"])).split("\n").filter((l) => l !== "");
    for (const id of ids) taken.push(...(await read(id).catch((): string[] => [])));
    for (let n = 0; n < 256; n++) {
      const subnet = `${NET_PREFIX}.${n}.0/24`;
      if (taken.some((t) => overlaps(t, subnet))) continue;
      await docker([
        "network",
        "create",
        "--subnet",
        subnet,
        "--gateway",
        hostOf(subnet, 1),
        ...names.labelFlags("browsernet"),
        names.network,
      ]);
      return subnet;
    }
    throw new Error("no free address range for its network");
  }

  private waitReady(docker: (args: string[]) => Promise<string>, container: string): Promise<void> {
    return waitForLine(docker, container, READY_LINE, this.deps.readyMs ?? 30_000);
  }
}

/** The `n`th address of an IPv4 subnet `a.b.c.0/24`: its base with the last number set. */
function hostOf(cidr: string, n: number): string {
  const [base = ""] = cidr.split("/");
  const parts = base.split(".");
  parts[3] = String(n);
  return parts.join(".");
}

/** True when two IPv4 subnets share an address: one holds the other's first address. */
function overlaps(a: string, b: string): boolean {
  return inSubnet(a.split("/")[0] ?? "", b) || inSubnet(b.split("/")[0] ?? "", a);
}
