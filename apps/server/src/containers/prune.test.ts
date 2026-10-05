import { describe, expect, it } from "vitest";
import { DockerCli } from "./docker.ts";
import { type InspectedImage, pruneImages, selectOldImages } from "./prune.ts";

const NOW = new Date("2026-10-04T08:00:00Z");
const OLD = "2026-09-20T08:00:00Z";
const NEW = "2026-10-01T08:00:00Z";
const hex = (c: string) => `sha256:${c.repeat(64)}`;

describe("selectOldImages", () => {
  it("takes majhi's images older than seven days that no container uses, and nothing else", () => {
    const images: InspectedImage[] = [
      { id: hex("a"), created: OLD, label: "image" },
      { id: hex("b"), created: NEW, label: "image" },
      { id: hex("c"), created: OLD, label: "image" },
      { id: hex("d"), created: OLD, label: "" },
      { id: hex("e"), created: OLD, label: "volume" },
      { id: hex("f"), created: "not a date", label: "image" },
    ];
    expect(selectOldImages(images, new Set([hex("c")]), NOW)).toEqual([hex("a")]);
  });
});

/** Plays the docker daemon for the prune: images with labels and dates, and containers using some. */
class PruneDocker {
  calls: string[][] = [];
  images = new Map<string, { created: string; labels: Record<string, string> }>([
    [hex("a"), { created: OLD, labels: { "majhi.container": "image", "majhi.task": "ACM-1" } }],
    [hex("b"), { created: NEW, labels: { "majhi.container": "image", "majhi.task": "ACM-1" } }],
    [hex("c"), { created: OLD, labels: { "majhi.container": "image", "majhi.task": "ACM-2" } }],
    // Another project's old images: one unlabelled, one with a label that only looks alike.
    [hex("d"), { created: OLD, labels: {} }],
    [hex("e"), { created: OLD, labels: { "com.example.container": "image" } }],
  ]);
  /** Container id to the image it runs. */
  containers = new Map([
    ["1".repeat(64), hex("c")],
    ["2".repeat(64), hex("d")],
  ]);

  async exec(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push([...args]);
    const out = (stdout: string) => ({ stdout, stderr: "" });
    const key = args.slice(0, 2).join(" ");
    if (key === "image ls") {
      const filter = args[args.indexOf("--filter") + 1] ?? "";
      const [k = "", v = ""] = filter.replace(/^label=/, "").split("=");
      return out(
        [...this.images]
          .filter(([, i]) => i.labels[k] === v)
          .map(([id]) => id)
          .join("\n"),
      );
    }
    if (key === "image inspect") {
      const ids = args.slice(4);
      return out(
        ids
          .map((id) => {
            const i = this.images.get(id);
            if (i === undefined) throw new Error(`No such image: ${id}`);
            return `${id} ${i.created} ${i.labels["majhi.container"] ?? ""}`;
          })
          .join("\n"),
      );
    }
    if (args[0] === "ps") return out([...this.containers.keys()].join("\n"));
    if (args[0] === "inspect")
      return out(
        args
          .slice(3)
          .map((c) => this.containers.get(c))
          .join("\n"),
      );
    if (key === "image rm") {
      const id = `sha256:${args[2]}`;
      if ([...this.containers.values()].includes(id)) throw new Error("image is being used");
      this.images.delete(id);
      return out("");
    }
    throw new Error(`The fake docker does not know ${args.join(" ")}`);
  }
}

describe("pruneImages", () => {
  it("removes only majhi-labelled images older than seven days that no container uses, and never touches volumes", async () => {
    const docker = new PruneDocker();
    expect(await pruneImages(docker, NOW)).toBe(1);
    expect([...docker.images.keys()]).toEqual([hex("b"), hex("c"), hex("d"), hex("e")]);
    const removals = docker.calls.filter((c) => c[1] === "rm");
    expect(removals).toEqual([["image", "rm", "a".repeat(64)]]);
    expect(docker.calls.some((c) => c[0] === "volume" || c.includes("--force") || c.includes("-f"))).toBe(
      false,
    );
  });
});

describe("DockerCli build cache prune", () => {
  const cli = new DockerCli({
    cliEnv: {},
    majhiHome: "/Users/owner/.majhi",
    hostHome: "/Users/owner",
    protectedPaths: [],
  });
  const refused = (args: string[]) => expect(() => cli.exec(args)).toThrow(/Only the old build cache/);

  it("allows only the old cache of a majhi builder", () => {
    refused(["buildx", "prune", "--builder", "default", "--force", "--filter", "until=168h"]);
    refused(["buildx", "prune", "--builder", "acme-builder", "--force", "--filter", "until=168h"]);
    refused(["buildx", "prune", "--builder", "majhi-preview-acm-1", "--force", "--all"]);
    refused(["buildx", "prune", "--builder", "majhi-preview-acm-1", "--force"]);
    refused(["buildx", "prune", "--force", "--filter", "until=168h"]);
    refused([
      "buildx",
      "prune",
      "--builder",
      "majhi-preview-acm-1",
      "--force",
      "--filter",
      "until=168h",
      "--all",
    ]);
    refused(["buildx", "prune", "--builder", "majhi-preview-acm-1", "--force", "--filter", "type=regular"]);
  });

  it("refuses volume and system prunes", () => {
    expect(() => cli.exec(["volume", "prune", "-f"])).toThrow(/not allowed/);
    expect(() => cli.exec(["system", "prune", "-f"])).toThrow(/not allowed/);
    expect(() => cli.exec(["image", "prune", "-a"])).toThrow(/not allowed/);
  });
});
