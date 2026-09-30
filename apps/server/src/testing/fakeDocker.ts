import { type ChildProcess, spawn } from "node:child_process";
import { killTree, type Spawned } from "@majhi/acp";
import { assertSafe, type DockerParts, dockerArgv, type Safety } from "../containers/args.ts";
import type { ContainerDocker } from "../containers/service.ts";

export interface FakeContainer {
  name: string;
  labels: Record<string, string>;
  child: ChildProcess | undefined;
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

  async attached(parts: DockerParts, safety: Safety): Promise<Spawned> {
    assertSafe(parts, safety);
    const verb = parts.verb.join(" ");
    this.calls.push(verb);
    const child = spawn("sleep", ["30"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    if (verb === "buildx build") {
      this.images.add(parts.flags[parts.flags.indexOf("--tag") + 1] ?? "");
      setTimeout(() => killTree(child), 20);
      return { child, cwd: "/", kill: () => killTree(child) };
    }
    const name = parts.flags[parts.flags.indexOf("--name") + 1] ?? "";
    this.containers.set(name, { name, labels: this.labelsOf(parts), child });
    return {
      child,
      cwd: "/",
      kill: () => {
        killTree(child);
        this.containers.delete(name);
      },
    };
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
      args[0] === "ps" || args[0] === "port" || args[0] === "rm" ? args[0] : `${args[0]} ${args[1]}`;
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
      case "buildx rm":
        this.builders.delete(last);
        return out("");
      case "buildx ls":
        return out([...this.builders].join("\n"));
      case "network inspect":
        if (!this.networks.has(last)) throw new Error("No such network");
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
        const task = filter("label")
          .find((f) => f.startsWith("label=majhi.task="))
          ?.slice("label=majhi.task=".length);
        if (args.includes("label=majhi.runner=1")) return out(this.runners.join("\n"));
        return out(
          [...this.containers.values()]
            .filter(
              (c) =>
                c.labels["majhi.container"] !== undefined &&
                (task === undefined || c.labels["majhi.task"] === task),
            )
            .map((c) => c.name)
            .join("\n"),
        );
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
