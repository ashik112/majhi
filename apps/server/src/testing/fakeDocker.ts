import { type ChildProcess, spawn } from "node:child_process";
import { killTree, type Spawned } from "@majhi/acp";
import { assertSafe, type DockerParts, dockerArgv, type Safety } from "../containers/args.ts";
import type { ContainerDocker } from "../containers/service.ts";
import { assertTaskArgv } from "../containers/task-docker.ts";

export interface FakeContainer {
  name: string;
  /** The image it runs, as docker shows it. */
  image?: string;
  /** `Up` unless a test sets another, like `Exited (0)`. */
  status?: string;
  /** What `docker inspect` of its state shows: `running 0 none`. */
  state?: string;
  /** What `docker logs` prints. */
  logs?: string;
  /** What `docker run -d` printed, and `inspect` takes. */
  id?: string;
  labels: Record<string, string>;
  child: ChildProcess | undefined;
}

/** `{{.Names}}`, `{{.Image}}`, `{{.Status}}` and `{{.Label "key"}}` of docker's `--format`, filled from the fake. */
function render(format: string, c: FakeContainer): string {
  let out = "";
  let i = 0;
  while (i < format.length) {
    const open = format.indexOf("{{", i);
    if (open === -1) return out + format.slice(i);
    const close = format.indexOf("}}", open);
    out += format.slice(i, open);
    const expr = format.slice(open + 2, close).trim();
    if (expr === ".Names") out += c.name;
    else if (expr === ".Image") out += c.image ?? "";
    else if (expr === ".Status") out += c.status ?? "Up 2 seconds";
    else if (expr.startsWith(".Label "))
      out += c.labels[expr.slice(".Label ".length).replaceAll('"', "")] ?? "";
    i = close + 2;
  }
  return out;
}

/** Plays docker: keeps networks, volumes, builders, images and containers in memory, and runs `assertSafe` like the real CLI wrapper. */
export class FakeDocker implements ContainerDocker {
  calls: string[] = [];
  networks = new Map<string, Set<string>>();
  volumes = new Map<string, { labels: Record<string, string>; options: Record<string, string> }>();
  builders = new Set<string>();
  images = new Set<string>();
  containers = new Map<string, FakeContainer>();
  runners = ["majhi-run-aaa"];
  connected: string[] = [];
  stoppedBuilders: string[] = [];
  prunedBuilders: string[] = [];
  /** Every call a task's script made, as docker got it. */
  taskCalls: string[][] = [];
  /** `docker wait` returns when this resolves, to play a container that runs on. */
  waitGate: Promise<void> | undefined;
  /** Runs that fail before a container exists, by container name. */
  runFails = new Set<string>();
  /** Makes `ps` answer late, to play a slow daemon. */
  psDelayMs = 0;

  private labelsOf(parts: DockerParts): Record<string, string> {
    const labels: Record<string, string> = {};
    parts.flags.forEach((flag, i) => {
      if (parts.flags[i - 1] !== "--label") return;
      const at = flag.indexOf("=");
      labels[flag.slice(0, at)] = flag.slice(at + 1);
    });
    return labels;
  }

  async create(parts: DockerParts, safety: Safety): Promise<{ stdout: string; stderr: string }> {
    assertSafe(parts, safety);
    this.calls.push(dockerArgv(parts).slice(0, 2).join(" "));
    const verb = parts.verb.join(" ");
    const name = parts.image ?? parts.flags[parts.flags.indexOf("--name") + 1] ?? "";
    if (verb === "buildx create") this.builders.add(name);
    if (verb === "network create") this.networks.set(name, new Set());
    if (verb === "volume create") this.volumes.set(name, { labels: this.labelsOf(parts), options: {} });
    return { stdout: "", stderr: "" };
  }

  /** Holders that did not come up, by name, for a test of the failure. */
  failHolds = new Set<string>();
  /** The holders started, with the arguments of their `docker run`. */
  holds: string[][] = [];

  async hold(parts: DockerParts, safety: Safety): Promise<void> {
    assertSafe(parts, safety);
    this.holds.push(dockerArgv(parts));
    const name = parts.flags[parts.flags.indexOf("--name") + 1] ?? "";
    if (this.failHolds.has(name)) throw new Error(`The network guard of ${name} did not start.`);
    this.containers.set(name, {
      name,
      labels: this.labelsOf(parts),
      child: undefined,
      image: parts.image ?? "",
    });
  }

  async attached(parts: DockerParts, safety: Safety): Promise<Spawned> {
    assertSafe(parts, safety);
    const verb = parts.verb.join(" ");
    this.calls.push(verb);
    // A preview's holder says its guard is set, like netguard --hold.
    const holder = parts.flags.includes("majhi.container=previewhold");
    const child = holder
      ? spawn("sh", ["-c", "echo majhi-netguard ready; sleep 30"], {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn("sleep", ["30"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    if (verb === "buildx build") {
      this.images.add(parts.flags[parts.flags.indexOf("--tag") + 1] ?? "");
      setTimeout(() => killTree(child), 20);
      return { child, cwd: "/", kill: () => killTree(child) };
    }
    const name = parts.flags[parts.flags.indexOf("--name") + 1] ?? "";
    this.containers.set(name, { name, labels: this.labelsOf(parts), child, image: parts.image ?? "" });
    return {
      child,
      cwd: "/",
      kill: () => {
        killTree(child);
        this.containers.delete(name);
      },
    };
  }

  /** A task's own call: checked like the real wrapper, then played in memory. */
  async task(
    args: readonly string[],
    safety: Safety,
    allowedImages: readonly string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    assertTaskArgv(args, safety, allowedImages);
    this.taskCalls.push([...args]);
    if (args[0] === "wait" && this.waitGate !== undefined) await this.waitGate;
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    const at = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    switch (args[0]) {
      case "run": {
        const name = at("--name");
        const labels: Record<string, string> = {};
        args.forEach((a, i) => {
          if (args[i - 1] !== "--label") return;
          const eq = a.indexOf("=");
          labels[a.slice(0, eq)] = a.slice(eq + 1);
        });
        const id = Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64);
        const image =
          args.find((a, i) => i > 0 && !a.startsWith("-") && !args[i - 1]?.startsWith("--")) ?? "";
        if (this.runFails.has(name)) return { code: 125, stdout: "", stderr: "Unable to find image\n" };
        if (args.includes("--detach")) {
          this.containers.set(name, { name, id, labels, child: undefined, image });
          return ok(`${id}\n`);
        }
        if (!args.includes("--rm")) this.containers.set(name, { name, id, labels, child: undefined, image });
        return ok(
          `ran ${args.find((a, i) => i > 0 && !a.startsWith("-") && !args[i - 1]?.startsWith("--")) ?? ""}\n`,
        );
      }
      case "buildx":
        this.images.add(at("--tag"));
        return ok("built\n");
      case "rm":
        for (const name of args.slice(1).filter((a) => !a.startsWith("-"))) this.containers.delete(name);
        return ok("");
      case "ps":
        return ok(
          `${[...this.containers.values()]
            .filter((c) => c.labels["majhi.task"] === safety.task)
            .map((c) => c.name)
            .join("\n")}\n`,
        );
      default:
        return ok("");
    }
  }

  /** Guards set again with `guard`, as `container: subnets`. */
  guards: string[] = [];

  async guard(
    container: string,
    subnets: readonly string[],
    server: { host: string; port: number } | undefined,
  ): Promise<{ stdout: string; stderr: string }> {
    const where = server === undefined ? "" : ` ${server.host}:${server.port}`;
    this.guards.push(`${container}: ${subnets.join(",")}${where}`);
    return { stdout: "", stderr: "" };
  }

  async connect(network: string, container: string): Promise<{ stdout: string; stderr: string }> {
    this.calls.push(`network connect ${network} ${container}`);
    if (container === "majhi-preview-acm-1" && !this.containers.has(container))
      throw new Error("No such container");
    this.networks.get(network)?.add(container);
    this.connected.push(`${network} ${container}`);
    return { stdout: "", stderr: "" };
  }

  async exec(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push(args.slice(0, 2).join(" "));
    const out = (stdout: string) => ({ stdout, stderr: "" });
    const last = args.at(-1) ?? "";
    const filter = (key: string) =>
      args.flatMap((a, i) => (args[i - 1] === "--filter" && a.startsWith(`${key}=`) ? [a] : []));
    const verb =
      args[0] === "ps" || args[0] === "port" || args[0] === "rm" || args[0] === "inspect"
        ? args[0]
        : `${args[0]} ${args[1]}`;
    switch (verb) {
      case "image inspect":
        if (!this.images.has(last)) throw new Error("No such image");
        return out("[]");
      case "image rm":
        this.images.delete(last);
        return out("");
      case "image ls":
        return out([...this.images].join("\n"));
      case "port":
        return out("0.0.0.0:49153\n[::]:49153\n");
      case "buildx inspect":
        if (!this.builders.has(last)) throw new Error("no builder");
        return out("");
      case "buildx stop":
        this.stoppedBuilders.push(last);
        return out("");
      case "buildx prune":
        this.prunedBuilders.push(args[3] ?? "");
        return out("");
      case "buildx rm":
        this.builders.delete(last);
        return out("");
      case "buildx ls":
        return out([...this.builders].join("\n"));
      case "network inspect":
        if (!this.networks.has(last)) throw new Error("No such network");
        if (args.some((a) => a.includes(".IPAM"))) return out("192.168.171.0/24 ");
        return out(args.includes("--format") ? [...(this.networks.get(last) ?? [])].join(" ") : "[]");
      case "network disconnect":
        this.networks.get(args.at(-2) ?? "")?.delete(last);
        return out("");
      case "network rm":
        if ((this.networks.get(last)?.size ?? 0) > 0) throw new Error("has active endpoints");
        this.networks.delete(last);
        return out("");
      case "network ls":
        return out([...this.networks.keys()].join("\n"));
      case "volume inspect": {
        const v = this.volumes.get(last);
        if (v === undefined) throw new Error(`Error response from daemon: get ${last}: no such volume`);
        return out(JSON.stringify({ Name: last, Driver: "local", Labels: v.labels, Options: v.options }));
      }
      case "volume ls": {
        const task = filter("label")
          .find((f) => f.startsWith("label=majhi.task="))
          ?.slice("label=majhi.task=".length);
        const rows = [...this.volumes].filter(
          ([, v]) => task === undefined || v.labels["majhi.task"] === task,
        );
        return out(
          rows
            .map(([name, v]) => (args.includes("--format") ? `${v.labels["majhi.task"]} ${name}` : name))
            .join("\n"),
        );
      }
      case "volume rm":
        for (const name of args.slice(3)) this.volumes.delete(name);
        return out("");
      case "ps": {
        if (args.includes("label=majhi.runner=1")) return out(this.runners.join("\n"));
        const labels = filter("label").map((f) => f.slice("label=".length));
        const all = args.includes("-a");
        const format = args[args.indexOf("--format") + 1];
        // The answer is read now and delivered late, like a slow daemon: a start that lands meanwhile is not in it.
        const answer = out(
          [...this.containers.values()]
            .filter((c) => all || !(c.status ?? "Up").startsWith("Exited"))
            .filter((c) =>
              labels.every((l) => {
                const at = l.indexOf("=");
                return at === -1 ? c.labels[l] !== undefined : c.labels[l.slice(0, at)] === l.slice(at + 1);
              }),
            )
            .map((c) => (args.includes("--format") && format !== undefined ? render(format, c) : c.name))
            .join("\n"),
        );
        if (this.psDelayMs > 0) await new Promise((r) => setTimeout(r, this.psDelayMs));
        return answer;
      }
      case "logs": {
        const c = this.containers.get(last);
        if (c === undefined) throw new Error("No such container");
        return out(c.logs ?? "");
      }
      case "inspect": {
        const c = [...this.containers.values()].find((x) => x.id === last || x.name === last);
        if (c === undefined) throw new Error("No such object");
        if (args.includes("{{.State.Status}}")) return out((c.state ?? "running 0 none").split(" ")[0] ?? "");
        if (args.some((a) => a.includes(".State"))) return out(c.state ?? "running 0 none");
        return out(`/${c.name} ${c.labels["majhi.task"]} ${c.labels["majhi.container"]}`);
      }
      case "rm":
        for (const name of args.slice(3)) {
          const c = this.containers.get(name);
          if (c?.child) killTree(c.child);
          this.containers.delete(name);
        }
        return out("");
    }
    throw new Error(`The fake docker does not know ${args.join(" ")}`);
  }
}
