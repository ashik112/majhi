import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type OwnImage,
  readOpenTasks,
  removeOwnLeftovers,
  selectOtherReleases,
  selectOwnImages,
} from "./diskHygiene.ts";

const row = (repository: string, tag = "latest", size = "1GB") => ({ repository, tag, id: "abc", size });
const own = (ref: string, builtBy: string): OwnImage => ({ ref, builtBy, bytes: 1_000_000_000 });

describe("what an update may remove", () => {
  const open = new Set(["ACM-1"]);

  it("selects only images majhi labelled whose task is not open", () => {
    const rows = [
      own("majhi-acme-api-preview:latest", "ACM-1"),
      own("majhi-acme-api-img-web:test", "ACM-2"),
      own("majhi-preview-acm-3:latest", "ACM-3"),
      own("sha256:unlabelled", ""),
    ];
    expect(selectOwnImages(rows, open).map((r) => r.ref)).toEqual([
      "majhi-acme-api-img-web:test",
      "majhi-preview-acm-3:latest",
    ]);
  });

  it("keeps every image when the open tasks are not known", () => {
    expect(selectOwnImages([own("majhi-acme-api-preview:latest", "ACM-2")], undefined)).toEqual([]);
  });
});

describe("removeOwnLeftovers", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "majhi-hygiene-"));
    await mkdir(home, { recursive: true });
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  function fakeDocker() {
    const calls: string[][] = [];
    const t = (...cols: string[]) => cols.join("\t");
    const step = async (_label: string, args: string[]): Promise<string> => {
      calls.push(args);
      const line = args.join(" ");
      if (line.startsWith("image ls --format") && line.endsWith("majhi-server:previous"))
        return t("majhi-server", "previous", "id1", "2.1GB");
      if (line.startsWith("image ls --format")) return "";
      if (line.startsWith("image ls -q")) return ["id2", "id3", "id4"].join("\n");
      if (line.startsWith("image inspect"))
        return [
          t("id2", "ACM-1", "500000000", "majhi-acme-api-preview:latest"),
          t("id3", "ACM-2", "700000000", "majhi-acme-api-img-web:test"),
          t("id4", "", "900000000", "acme-web:latest"),
        ].join("\n");
      if (line.includes("dangling=true") && line.includes("label=majhi.owned=build"))
        return t("<none>", "<none>", "id5", "300MB");
      if (line.includes("dangling=true")) return "";
      return "";
    };
    return { calls, step };
  }

  it("removes only majhi's own labelled images, keeps an open task's, and never prunes the build cache", async () => {
    await writeFile(join(home, "open-tasks.json"), JSON.stringify({ tasks: ["ACM-1"] }));
    const { calls, step } = fakeDocker();
    const said: string[] = [];
    await removeOwnLeftovers(step, home, async (text) => void said.push(text));
    const lines = calls.map((c) => c.join(" "));

    const removals = lines.filter((l) => l.startsWith("image rm") || l.startsWith("image prune"));
    expect(removals).toEqual([
      "image rm majhi-server:previous",
      "image rm majhi-acme-api-img-web:test",
      "image prune -f --filter label=majhi.owned=build",
    ]);
    const all = lines.join("\n");
    expect(all).not.toContain("acme-web");
    expect(all).not.toMatch(/system prune|volume prune|container prune|image prune -f$|prune -a|--all|buildx rm|volume rm/);
    // The build cache is only ever trimmed by age, never cleared.
    const builderPrunes = all.split("\n").filter((l) => l.includes("builder prune"));
    expect(builderPrunes.every((l) => l.includes("--filter until="))).toBe(true);
    expect(said.at(-1)).toContain("majhi-server:previous (2.1GB)");
    expect(said.at(-1)).toContain("majhi-acme-api-img-web:test (700 MB)");
    expect(said.at(-1)).toContain("freed");
  });

  it("keeps all labelled images but still drops the previous tag when the open tasks are unknown", async () => {
    const { calls, step } = fakeDocker();
    const said: string[] = [];
    await removeOwnLeftovers(step, home, async (text) => void said.push(text));
    const lines = calls.map((c) => c.join(" "));
    expect(lines).toContain("image rm majhi-server:previous");
    expect(lines.some((l) => l.startsWith("image inspect"))).toBe(false);
    expect(said[0]).toContain("Kept the preview images");
  });

  it("reads the open tasks as they are, or nothing when the file is bad", async () => {
    expect(await readOpenTasks(home)).toBeUndefined();
    await writeFile(join(home, "open-tasks.json"), JSON.stringify({ tasks: ["ACM-1"] }));
    expect([...((await readOpenTasks(home)) ?? [])]).toEqual(["ACM-1"]);
    await writeFile(join(home, "open-tasks.json"), "{nope");
    expect(await readOpenTasks(home)).toBeUndefined();
  });
});

describe("selectOtherReleases", () => {
  it("picks only registry images of other versions, never the local images built on them", () => {
    const rows = [
      row("ghcr.io/acme/majhi-server", "v1.0.0"),
      row("ghcr.io/acme/majhi-laya", "v1.0.0-cuda"),
      row("ghcr.io/acme/majhi-server", "v1.1.0"),
      row("ghcr.io/acme/majhi-laya", "v1.1.0-cpu"),
      row("ghcr.io/acme/majhi-runner", "<none>"),
      row("majhi-server", "dev"),
      row("majhi-server", "previous"),
    ];
    expect(selectOtherReleases(rows, "v1.1.0").map((r) => `${r.repository}:${r.tag}`)).toEqual([
      "ghcr.io/acme/majhi-server:v1.0.0",
      "ghcr.io/acme/majhi-laya:v1.0.0-cuda",
    ]);
  });
});
