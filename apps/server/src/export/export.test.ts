import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { localSpawner } from "@majhi/acp";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskFileRoutes } from "../http/taskFiles.ts";
import { tempDir } from "../testing/fixtures.ts";
import { runnerPdfPrinter } from "./pdf.ts";

/** One PNG chunk: length, type, data and the CRC of type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A 1x1 PNG, one RGBA pixel, built here so the test holds no encoded blob. */
const PNG = (() => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 0x2a, 0x64, 0xb8, 0xff]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
})();

const PLAN = `# Northwind launch plan

| Region | Owner |
| --- | --- |
| North | Acme |

![chart](../media/chart.png)

[docs](https://example.com/docs) and [run](javascript:alert(1))
`;

describe("downloading a viewer file", () => {
  let dir: string;
  let folder: string;
  let cleanup: () => Promise<void>;
  let app: Hono;
  const download = (path: string, format: string) =>
    app.request(`/api/tasks/ACM-1/files/${path}?download=${format}`);

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    folder = join(dir, "ACM-1");
    await mkdir(join(folder, "docs"), { recursive: true });
    await mkdir(join(folder, "media"));
    await writeFile(join(folder, "docs", "plan.md"), PLAN);
    await writeFile(join(folder, "media", "chart.png"), PNG);
    app = new Hono().route(
      "/api/tasks",
      taskFileRoutes({
        folderOf: (id) => (id === "ACM-1" ? folder : undefined),
        // The runner's print script, run next to the test with this machine's Chromium.
        pdf: runnerPdfPrinter({
          spawner: (req) => localSpawner({ ...req, isolated: false, cwd: tmpdir() }),
          base: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        }),
      }),
    );
  });
  afterEach(() => cleanup());

  it("html: only safe links, and no script", async () => {
    const res = await download("docs/plan.md", "html");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a href="https://example.com/docs">docs</a>');
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/<script/i);
  });

  it("reads only what the viewer may: no file or image outside the folder or behind a dot name", async () => {
    await writeFile(join(dir, "secret.png"), Buffer.concat([PNG, Buffer.from("OUTSIDE")]));
    await writeFile(join(dir, "outside.md"), "# Outside\n");
    await mkdir(join(folder, ".private"));
    await writeFile(join(folder, ".private", "notes.md"), "# Hidden\n");
    await writeFile(join(folder, ".private", "chart.png"), PNG);
    await symlink(join(dir, "outside.md"), join(folder, "linked.md"));
    await symlink(join(dir, "secret.png"), join(folder, "media", "linked.png"));
    for (const path of ["linked.md", ".private/notes.md", "..%2Foutside.md", "docs/..%2F..%2Foutside.md"]) {
      for (const format of ["raw", "html", "docx"]) {
        expect((await download(path, format)).status, `${path} ${format}`).not.toBe(200);
      }
    }
    expect((await download("media/chart.png", "html")).status).toBe(400);
    expect((await download("docs/plan.md", "exe")).status).toBe(400);

    // A document may name images anywhere; only those the viewer would serve are inlined.
    await writeFile(
      join(folder, "docs", "leaky.md"),
      `# Leaky\n\n![a](../../secret.png) ![b](../media/linked.png) ![c](../.private/chart.png) ![d](${join(dir, "secret.png")})\n`,
    );
    const html = await (await download("docs/leaky.md", "html")).text();
    expect(html).toContain("<h1>Leaky</h1>");
    expect(html).not.toContain("data:image");
  });
});
