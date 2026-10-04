import { describe, expect, it } from "vitest";
import { DockerCli } from "./docker.ts";
import {
  findUnusedImages,
  type ImageRow,
  parseDockerSize,
  removeImages,
  selectOldVolumes,
  selectUnusedImages,
} from "./prune.ts";

const NOW = new Date("2026-10-04T08:00:00Z");
const OLD = "2026-09-20T08:00:00Z";
const NEW = "2026-10-01T08:00:00Z";
const hex = (c: string) => `sha256:${c.repeat(64)}`;

const image = (c: string, at: string, refs: string[], label = "image", task = ""): ImageRow => ({
  id: hex(c),
  at,
  bytes: 1000,
  refs,
  label,
  task,
});

describe("selectUnusedImages", () => {
  const images = [
    image("a", OLD, ["majhi-preview-acm-1:latest"], "image", "ACM-1"),
    image("b", NEW, ["majhi-preview-acm-2:latest"]),
    image("c", OLD, ["majhi-preview-acm-3:latest"]),
    image("d", OLD, ["acme/api:1"], ""),
    image("e", OLD, ["postgres:16-alpine"], ""),
    image("f", OLD, ["majhi-server:dev"], ""),
    image("g", "not a date", ["majhi-preview-acm-4:latest"]),
  ];

  it("takes only majhi's own old preview images that no container uses, never another image", () => {
    const picked = selectUnusedImages(images, new Set([hex("c")]), NOW);
    expect(picked.map((i) => i.id)).toEqual([hex("a")]);
  });

  it("leaves the images of the skipped (open) tasks at any age", () => {
    expect(selectUnusedImages(images, new Set(), NOW, 0, new Set(["ACM-1"])).map((i) => i.id)).toEqual([
      hex("b"),
      hex("c"),
    ]);
  });
});

describe("selectOldVolumes", () => {
  const volumes = [
    { task: "ACM-1", name: "majhi-acm-1-db" },
    { task: "ACM-2", name: "majhi-acm-2-db" },
    { task: "ACM-3", name: "majhi-acm-3-db" },
    { task: "ACM-4", name: "majhi-acm-4-db" },
  ];
  const age = (task: string) =>
    task === "ACM-1"
      ? ("open" as const)
      : task === "ACM-2"
        ? { doneAt: OLD }
        : task === "ACM-3"
          ? { doneAt: NEW }
          : ("gone" as const);

  it("removes volumes of tasks done for a week or gone, never of open or recently done tasks", () => {
    expect(selectOldVolumes(volumes, age, NOW).map((v) => v.name)).toEqual([
      "majhi-acm-2-db",
      "majhi-acm-4-db",
    ]);
  });
});

describe("parseDockerSize", () => {
  it("reads docker's units", () => {
    expect(parseDockerSize("21.6GB")).toBe(21_600_000_000);
    expect(parseDockerSize("340MB")).toBe(340_000_000);
    expect(parseDockerSize("0B")).toBe(0);
    expect(parseDockerSize("nonsense")).toBeUndefined();
  });
});

/** Plays the docker daemon: images with dates and tags, and containers using some. */
class FakeDocker {
  calls: string[][] = [];
  images = new Map<string, { created: string; refs: string[]; label: string }>([
    [hex("a"), { created: OLD, refs: ["majhi-preview-acm-1:latest"], label: "image" }],
    [hex("b"), { created: NEW, refs: ["majhi-preview-acm-2:latest"], label: "image" }],
    [hex("c"), { created: OLD, refs: ["majhi-preview-acm-3:latest"], label: "image" }],
    [hex("d"), { created: OLD, refs: ["majhi-server:dev"], label: "" }],
    [hex("f"), { created: OLD, refs: ["postgres:16-alpine"], label: "" }],
  ]);
  containers = new Map([["1".repeat(64), hex("c")]]);

  async exec(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push([...args]);
    const out = (stdout: string) => ({ stdout, stderr: "" });
    const key = args.slice(0, 2).join(" ");
    if (key === "image ls") {
      const labelled = args.includes("label=majhi.container=image");
      return out(
        [...this.images]
          .filter(([, i]) => !labelled || i.label === "image")
          .map(([id]) => id)
          .join("\n"),
      );
    }
    if (key === "image inspect") {
      return out(
        args
          .slice(4)
          .map((id) => {
            const i = this.images.get(id);
            if (i === undefined) throw new Error(`No such image: ${id}`);
            return `${id} ${i.created} 0001-01-01T00:00:00Z 1000 ${i.label === "" ? "-" : i.label} - ${i.refs.join(",")}`;
          })
          .join("\n"),
      );
    }
    if (args[0] === "ps") return out([...this.containers.keys()].join("\n"));
    if (args[0] === "inspect") {
      return out(
        args
          .slice(3)
          .map((c) => this.containers.get(c))
          .join("\n"),
      );
    }
    if (key === "image rm") {
      this.images.delete(`sha256:${args[2]}`);
      return out("");
    }
    throw new Error(`The fake docker does not know ${args.join(" ")}`);
  }
}

describe("image prune against docker", () => {
  it("removes only majhi's old unused preview images, never another project's image, and issues no prune command", async () => {
    const docker = new FakeDocker();
    const found = await findUnusedImages(docker, NOW);
    expect(await removeImages(docker, found)).toEqual({ removed: 1, bytes: 1000 });
    expect([...docker.images.keys()]).toEqual([hex("b"), hex("c"), hex("d"), hex("f")]);
    expect(docker.calls.filter((c) => c[1] === "rm")).toEqual([["image", "rm", "a".repeat(64)]]);
    expect(docker.calls.some((c) => c.includes("prune") || c.includes("--force") || c.includes("-f"))).toBe(
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
