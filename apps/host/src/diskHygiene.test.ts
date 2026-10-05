import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readOpenTasks,
  removeOwnLeftovers,
  selectBuilders,
  selectPreviewImages,
  selectStateVolumes,
} from "./diskHygiene.ts";

const row = (repository: string, tag = "latest", size = "1GB") => ({ repository, tag, id: "abc", size });

describe("what an update may remove", () => {
  const open = new Set(["acm-1"]);

  it("selects only majhi preview images of tasks that are not open", () => {
    const rows = [
      row("majhi-preview-acm-1"),
      row("majhi-preview-acm-2"),
      row("acme-web"),
      row("majhi-server", "dev"),
      row("someone/majhi-preview-acm-3"),
    ];
    expect(selectPreviewImages(rows, open).map((r) => r.repository)).toEqual(["majhi-preview-acm-2"]);
  });

  it("keeps every preview when the open tasks are not known", () => {
    expect(selectPreviewImages([row("majhi-preview-acm-2")], undefined)).toEqual([]);
    expect(selectBuilders(["majhi-preview-acm-2"], undefined)).toEqual([]);
    expect(selectStateVolumes(["buildx_buildkit_majhi-preview-acm-20_state"], undefined)).toEqual([]);
  });

  it("selects only majhi builders and their state volumes, never another project's", () => {
    expect(
      selectBuilders(["majhi-preview-acm-1", "majhi-preview-acm-2", "default", "acme-builder"], open),
    ).toEqual(["majhi-preview-acm-2"]);
    expect(
      selectStateVolumes(
        [
          "buildx_buildkit_majhi-preview-acm-10_state",
          "buildx_buildkit_majhi-preview-acm-20_state",
          "buildx_buildkit_acme-builder0_state",
          "acme_data",
          "majhi-acm-2-data-db",
        ],
        open,
      ),
    ).toEqual(["buildx_buildkit_majhi-preview-acm-20_state"]);
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
      if (line.includes("reference=majhi-preview-*"))
        return [
          t("majhi-preview-acm-1", "latest", "id2", "500MB"),
          t("majhi-preview-acm-2", "latest", "id3", "700MB"),
          t("acme-web", "latest", "id4", "900MB"),
        ].join("\n");
      if (line.startsWith("buildx ls"))
        return "default*\nmajhi-preview-acm-1\nmajhi-preview-acm-2\nacme-builder";
      if (line.startsWith("volume ls"))
        return [
          "buildx_buildkit_majhi-preview-acm-10_state",
          "buildx_buildkit_majhi-preview-acm-20_state",
          "acme_data",
        ].join("\n");
      if (line.includes("dangling=true") && line.includes("label=majhi.owned=build"))
        return t("<none>", "<none>", "id5", "300MB");
      if (line.includes("dangling=true")) return "";
      return "";
    };
    return { calls, step };
  }

  it("removes only majhi's own images, builders and volumes, keeps an open task's preview, and never prunes the build cache", async () => {
    await writeFile(join(home, "open-tasks.json"), JSON.stringify({ tasks: ["ACM-1"] }));
    const { calls, step } = fakeDocker();
    const said: string[] = [];
    await removeOwnLeftovers(step, home, async (text) => void said.push(text));
    const lines = calls.map((c) => c.join(" "));

    expect(lines).toContain("image rm majhi-server:previous");
    expect(lines).toContain("image rm majhi-preview-acm-2:latest");
    expect(lines).toContain("buildx rm --force majhi-preview-acm-2");
    expect(lines).toContain("volume rm buildx_buildkit_majhi-preview-acm-20_state");
    expect(lines).toContain("image prune -f --filter label=majhi.owned=build");

    const removals = lines.filter((l) =>
      /^(image rm|image prune|buildx rm|volume rm|container rm|rm )/.test(l),
    );
    expect(removals).toEqual([
      "image rm majhi-server:previous",
      "image rm majhi-preview-acm-2:latest",
      "buildx rm --force majhi-preview-acm-2",
      "volume rm buildx_buildkit_majhi-preview-acm-20_state",
      "image prune -f --filter label=majhi.owned=build",
    ]);
    const all = lines.join("\n");
    expect(all).not.toContain("acme");
    expect(all).not.toContain("acm-1:");
    expect(all).not.toMatch(
      /builder prune|system prune|volume prune|container prune|image prune -f$|prune -a|--all/,
    );
    expect(said.at(-1)).toContain("majhi-server:previous (2.1GB)");
    expect(said.at(-1)).toContain("majhi-preview-acm-2:latest (700MB)");
    expect(said.at(-1)).toContain("freed");
  });

  it("keeps all previews but still drops the previous tag when the open tasks are unknown", async () => {
    const { calls, step } = fakeDocker();
    const said: string[] = [];
    await removeOwnLeftovers(step, home, async (text) => void said.push(text));
    const lines = calls.map((c) => c.join(" "));
    expect(lines).toContain("image rm majhi-server:previous");
    expect(lines.some((l) => l.startsWith("buildx rm") || l.startsWith("volume rm"))).toBe(false);
    expect(lines.some((l) => l.includes("majhi-preview-acm-2"))).toBe(false);
    expect(said[0]).toContain("Kept the preview images");
  });

  it("reads the open tasks lowercased, or nothing when the file is bad", async () => {
    expect(await readOpenTasks(home)).toBeUndefined();
    await writeFile(join(home, "open-tasks.json"), JSON.stringify({ tasks: ["ACM-1"] }));
    expect([...((await readOpenTasks(home)) ?? [])]).toEqual(["acm-1"]);
    await writeFile(join(home, "open-tasks.json"), "{nope");
    expect(await readOpenTasks(home)).toBeUndefined();
  });
});
